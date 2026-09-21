/* ===== drive.js — Google Drive backup / restore (proprietor only) =====
 *
 * Uses Google Identity Services (GIS) OAuth token client + Drive REST API v3
 * via plain fetch (no gapi client needed). One-time setup: proprietor creates a
 * free Google Cloud OAuth Client ID (docs/GDRIVE-SETUP.md) and saves it in
 * Settings → Google Drive Backup.
 *
 * Flow:
 *   Save: find 'shop-records-backup.json' on Drive → update it, or create it.
 *   Load: download that file → validate → replace local data (with confirm).
 */
(function () {
  'use strict';

  const FILE_NAME = 'shop-records-backup.json';
  const MIME = 'application/json';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

  let tokenClient = null;
  let accessToken = null;
  let gisPromise = null;

  function getData() { return window.App ? App.getData() : null; }
  function saveData(d) { window.App && App.replaceData(d); }
  function toast(msg, opts) { window.App && App.toast(msg, opts); }
  function confirmDlg(title, text, cb) { window.App && App.askConfirm(title, text, cb); }

  function clientId() {
    const d = getData();
    return d && d.settings && d.settings.driveClientId ? d.settings.driveClientId.trim() : '';
  }

  function saveClientId(v) {
    const d = getData();
    if (!d) return;
    d.settings.driveClientId = v.trim();
    saveData(d);
  }

  /* ---------- Google Identity Services loader (cached by service worker) ---------- */
  function loadGIS() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in (needs internet).')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  function ensureTokenClient() {
    const cid = clientId();
    if (!cid) return Promise.reject(new Error('No Google Client ID. Tap "Connect Google Account" first.'));
    return loadGIS().then(() => {
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: cid,
          scope: SCOPE,
          callback: () => {},   // replaced per-request below
        });
      }
      return tokenClient;
    });
  }

  function getToken() {
    if (accessToken) return Promise.resolve(accessToken);
    return ensureTokenClient().then((tc) => new Promise((resolve, reject) => {
      let done = false;
      tc.callback = (resp) => {
        if (done) return;
        done = true;
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          resolve(accessToken);
        } else {
          reject(new Error('Google sign-in was not completed.'));
        }
      };
      try {
        tc.requestAccessToken({ prompt: '' });
      } catch (e) { reject(e); }
    }));
  }

  /* ---------- Drive API ---------- */
  function gapiFetch(url, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, { Authorization: 'Bearer ' + accessToken });
    return fetch(url, options).then((res) => {
      if (res.status === 401) {           // token expired → drop and force re-auth
        accessToken = null;
        throw new Error('Google sign-in expired. Please try again.');
      }
      if (!res.ok) throw new Error('Google Drive error (' + res.status + ').');
      return res.json().catch(() => ({}));
    });
  }

  function findBackupFile() {
    const q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    return gapiFetch(API + '/files?q=' + q + '&fields=files(id,name,modifiedTime)')
      .then((j) => (j.files && j.files[0]) || null);
  }

  function findBackupFiles() {
    const q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    return gapiFetch(API + '/files?q=' + q + '&fields=files(id,name,modifiedTime)')
      .then((j) => (j.files || []));
  }

  function deleteFile(fileId) {
    return fetch(API + '/files/' + fileId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + accessToken },
    }).then((res) => {
      if (!res.ok && res.status !== 204) throw new Error('Could not remove an old duplicate backup (' + res.status + ').');
      return true;
    });
  }

  function uploadCreate(json) {
    const metadata = { name: FILE_NAME, mimeType: MIME };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([json], { type: MIME }));
    return fetch(UPLOAD + '/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: form,
    }).then((res) => {
      if (!res.ok) throw new Error('Google Drive upload failed (' + res.status + ').');
      return res.json();
    });
  }

  function uploadUpdate(fileId, json) {
    return fetch(UPLOAD + '/files/' + fileId + '?uploadType=media', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': MIME },
      body: json,
    }).then((res) => {
      if (!res.ok) throw new Error('Google Drive update failed (' + res.status + ').');
      return res.json();
    });
  }

  /* ---------- record hygiene: strictly prevent repeated rows ---------- */
  function sanitizeData(d) {
    if (!d || typeof d !== 'object') return d;
    const uniq = (arr) => {
      const out = [], seen = new Set();
      (Array.isArray(arr) ? arr : []).forEach((x) => {
        if (!x || x.id == null || seen.has(x.id)) return;
        seen.add(x.id);
        out.push(x);
      });
      return out;
    };
    d.users = uniq(d.users);
    d.products = uniq(d.products);
    d.sales = uniq(d.sales);
    d.expenses = uniq(d.expenses);
    d.stock = uniq(d.stock);
    return d;
  }

  /* ---------- public actions ---------- */
  function saveToDrive() {
    if (!clientId()) return Promise.reject(new Error('No Google Client ID. Tap "Connect Google Account" first.'));
    return getToken()
      .then(() => findBackupFiles())
      .then((files) => {
        // upload the sanitized snapshot; update the existing backup in place and
        // remove any extra copies so repeated saves never create duplicates
        const json = JSON.stringify(sanitizeData(getData()), null, 2);
        const main = files[0] || null;
        const extras = files.slice(1);
        const chain = main
          ? uploadUpdate(main.id, json)
          : uploadCreate(json);
        return chain.then((res) =>
          Promise.allSettled(extras.map((f) => deleteFile(f.id))).then(() => res));
      });
  }

  function loadFromDrive() {
    if (!clientId()) return Promise.reject(new Error('No Google Client ID. Tap "Connect Google Account" first.'));
    return getToken()
      .then(() => findBackupFile())
      .then((file) => {
        if (!file) throw new Error('No backup file found on this Google Drive (' + FILE_NAME + '). Save once first.');
        return fetch(API + '/files/' + file.id + '?alt=media', {
          headers: { Authorization: 'Bearer ' + accessToken },
        }).then((res) => {
          if (!res.ok) throw new Error('Could not download the backup (' + res.status + ').');
          return res.text();
        });
      })
      .then((text) => {
        const d = sanitizeData(JSON.parse(text));   // throws → caught as bad file
        if (!d || !Array.isArray(d.users) || !d.settings) throw new Error('bad file');
        return d;
      });
  }

  window.Drive = {
    hasClientId: () => !!clientId(),
    saveClientId,
    getToken,                 // exposed for testing
    saveToDrive,
    loadFromDrive,
    // test hooks
    _findBackupFile: () => getToken().then(findBackupFile),
    _sanitize: sanitizeData,
    _reset: () => { accessToken = null; tokenClient = null; },
  };
})();
