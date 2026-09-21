/* ===== sync.js — offline-first cloud sync (Firebase Realtime Database) =====
 *
 * Design:
 * - localStorage stays the source of truth. Recording a sale/expense NEVER
 *   waits for the network — that is the offline guarantee.
 * - When the network is back ('online' event, visibility change, or after any
 *   local change, debounced), we push/pull the shop document from Firebase.
 * - Merge strategy: arrays (users/sales/expenses/stock) union by id, so a
 *   record made offline on this device and one made on another device BOTH
 *   survive. Scalars/settings go to whichever copy has the newer updatedAt.
 * - Requires one-time setup in Settings → Sync (free Firebase project).
 *   Without config, the app works fully offline as before; sync is dormant.
 */
(function () {
  'use strict';

  const FIREBASE_SCRIPTS = [
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  ];

  let fbApp = null;
  let fbDb = null;
  let fbLoading = null;
  let syncing = false;
  let syncTimer = null;
  let statusCb = null;          // set by UI: (statusKey, detail) => void
  let appliedCb = null;         // set by app.js: called when remote data applied

  function getData() { return window.App ? App.getData() : null; }
  function saveData(d) { window.App && App.replaceData(d); }

  function setStatus(key, detail) { if (statusCb) statusCb(key, detail); }

  /* ---------- config ---------- */
  function config() {
    const d = getData();
    return d && d.sync && d.sync.config ? d.sync.config : null;
  }

  function ensureIds() {
    const d = getData();
    if (!d) return;
    let changed = false;
    if (!d.sync.shopId) { d.sync.shopId = randCode(); changed = true; }
    if (!d.sync.deviceId) { d.sync.deviceId = randCode(); changed = true; }
    if (changed) saveData(d);
  }

  function randCode() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- lazy-load Firebase (cached by service worker after first load) ---------- */
  function loadFirebase() {
    if (fbApp) return Promise.resolve(fbApp);
    if (fbLoading) return fbLoading;
    fbLoading = new Promise((resolve, reject) => {
      let i = 0;
      function next() {
        if (i >= FIREBASE_SCRIPTS.length) {
          try {
            const cfg = config();
            if (!cfg || !cfg.apiKey || !cfg.databaseURL) {
              return reject(new Error('Sync is not set up. See Settings → Sync.'));
            }
            fbApp = firebase.initializeApp({
              apiKey: cfg.apiKey,
              databaseURL: cfg.databaseURL,
              projectId: cfg.projectId || undefined,
            });
            fbDb = firebase.database();
            resolve(fbApp);
          } catch (e) { reject(e); }
          return;
        }
        const s = document.createElement('script');
        s.src = FIREBASE_SCRIPTS[i++];
        s.onload = next;
        s.onerror = () => reject(new Error('Could not load sync library (needs internet once).'));
        document.head.appendChild(s);
      }
      next();
    });
    return fbLoading;
  }

  /* ---------- merge ---------- */
  // union arrays by id (remote wins on id collision to converge)
  function unionById(localArr, remoteArr) {
    const map = new Map();
    (localArr || []).forEach((r) => map.set(r.id, r));
    (remoteArr || []).forEach((r) => map.set(r.id, r));
    return Array.from(map.values());
  }

  function merge(local, remote) {
    const lNewer = (local.updatedAt || 0) >= (remote.updatedAt || 0);
    const base = lNewer ? local : remote;      // settings/scalars from newer copy
    return {
      updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0, Date.now()),
      users: unionById(local.users, remote.users),
      settings: base.settings,
      sales: unionById(local.sales, remote.sales),
      expenses: unionById(local.expenses, remote.expenses),
      stock: mergeStock(local.stock, remote.stock),
      sync: local.sync,                        // keep OUR sync state (config/ids)
    };
  }

  function mergeStock(localStock, remoteStock) {
    // stock quantities: higher timestamp wins per item, else newer doc
    const lMap = new Map((localStock || []).map((s) => [s.id, s]));
    const out = new Map();
    (remoteStock || []).forEach((rs) => {
      const ls = lMap.get(rs.id);
      if (!ls) { out.set(rs.id, rs); return; }
      out.set(rs.id, (ls.updatedAt || 0) >= (rs.updatedAt || 0) ? ls : rs);
    });
    (localStock || []).forEach((ls) => { if (!out.has(ls.id)) out.set(ls.id, ls); });
    return Array.from(out.values());
  }

  /* ---------- one sync round ---------- */
  function syncNow(opts) {
    opts = opts || {};
    const d = getData();
    if (!d) return Promise.resolve(false);
    ensureIds();
    if (!config()) {
      setStatus('not_configured');
      return Promise.resolve(false);
    }
    if (!navigator.onLine) {
      setStatus('offline');
      return Promise.resolve(false);
    }
    if (syncing) return Promise.resolve(false);
    syncing = true;
    setStatus('syncing');
    const withTimeout = (p, ms) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Sync timed out')), ms)),
    ]);
    return withTimeout(loadFirebase()
      .then(() => fbDb.ref('shops/' + d.sync.shopId).get())
      .then((snap) => {
        const remote = snap.exists() ? snap.val() : null;
        const local = getData();
        let merged;
        if (!remote) {
          merged = local;
          merged.updatedAt = Date.now();
        } else {
          merged = merge(local, remote);
        }
        merged.sync = local.sync;
        merged.sync.lastSyncAt = Date.now();
        return fbDb.ref('shops/' + d.sync.shopId).set(exportDoc(merged))
          .then(() => merged);
      }), 25000)
      .then((merged) => {
        saveData(merged);
        setStatus('synced');
        if (appliedCb) appliedCb();
        return true;
      })
      .catch((err) => {
        console.warn('Sync failed:', err && err.message);
        setStatus(navigator.onLine ? 'error' : 'offline');
        return false;
      })
      .finally(() => { syncing = false; });
  }

  // never upload PINs of other devices' users carelessly? — PINs must sync
  // so employees can log in on any device. Export as-is but strip sync.config
  // secrets are client-side anyway (Firebase API key is not secret).
  function exportDoc(d) {
    const copy = JSON.parse(JSON.stringify(d));
    return copy;
  }

  /* ---------- triggers ---------- */
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 15000); // debounce 15s after local changes
  }

  window.addEventListener('online', () => {
    setStatus('online_pending');
    syncNow();
  });
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine) syncNow();
  });

  window.Sync = {
    init(cb, onApplied) { statusCb = cb; appliedCb = onApplied; ensureIds(); },
    syncNow,
    scheduleSync,
    // test hooks (used by automated verification; not part of the UI)
    _merge: merge,
    _unionById: unionById,
    _mergeStock: mergeStock,
    saveConfig(cfg) {
      const d = getData();
      if (!d) return;
      d.sync.config = cfg;
      fbApp = null; fbDb = null; fbLoading = null;   // force re-init with new config
      saveData(d);
      setStatus('not_configured');                    // will flip on next syncNow
      return syncNow();
    },
    shopId() { const d = getData(); return d && d.sync ? d.sync.shopId : ''; },
    lastSyncAt() { const d = getData(); return d && d.sync ? d.sync.lastSyncAt : 0; },
    isOnline() { return navigator.onLine; },
  };
})();
