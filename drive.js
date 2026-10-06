/* ===== drive.js — Google Drive backup / restore (owner only) =====
 *
 * Uses Google Identity Services (GIS) OAuth token client + Drive REST API v3
 * and Google Sheets API v4 via plain fetch (no gapi client needed).
 * One-time setup: owner creates a free Google Cloud OAuth Client ID
 * (docs/GDRIVE-SETUP.md) and saves it in Settings → Google Drive Backup.
 *
 * Flow:
 *   Save: find 'shop-records-backup.json' on Drive → update it, or create it.
 *   Load: download that file → validate → replace local data (with confirm).
 *   Sync: write every section into a real Google Sheet (one tab per section)
 *         inside the dedicated "MyStore Records" folder, + the JSON backup.
 */
(function () {
  'use strict';

  const FILE_NAME = 'shop-records-backup.json';
  const MIME = 'application/json';
  const CSV_MIME = 'text/csv';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
  const SCOPE = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
  ].join(' ');
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

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
    return withTimeout(loadGIS(), 20000, 'Could not load Google sign-in (timed out — check internet).').then(() => {
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

  /* Every Google step gets a timeout so the Sync button can NEVER stay stuck
     on "Working…" — a blocked OAuth popup or a stalled request resolves with
     an error instead of hanging forever. */
  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
  }

  /* last sync attempt details for the on-screen error message + debugging */
  let lastSyncError = '';
  window.__syncDebug = { error: '', step: '', at: 0 };

  function noteSyncStep(step) {
    try { window.__syncDebug.step = step; window.__syncDebug.at = Date.now(); } catch (e) {}
  }

  function getToken() {
    if (accessToken) return Promise.resolve(accessToken);
    noteSyncStep('google-signin-popup');
    return ensureTokenClient().then((tc) => new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(guard); fn(arg); } };
      // the sign-in popup may wait for the user → generous, but never forever
      const guard = setTimeout(() => finish(reject,
        new Error('Google sign-in timed out. Check that the popup was not blocked, then try again.')), 150000);
      tc.callback = (resp) => {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          noteSyncStep('signed-in');
          finish(resolve, accessToken);
        } else {
          finish(reject, new Error((resp && resp.error_description) || 'Google sign-in was not completed.'));
        }
      };
      try {
        tc.requestAccessToken({ prompt: '' });
      } catch (e) { finish(reject, e); }
    }));
  }

  /* ---------- Drive API ---------- */
  function gapiFetch(url, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, { Authorization: 'Bearer ' + accessToken });
    noteSyncStep(url.split('?')[0].replace('https://www.googleapis.com', '').replace('https://sheets.googleapis.com', 'sheets'));
    return withTimeout(fetch(url, options), 30000, 'Google request timed out — check internet and try again.')
      .then((res) => {
      if (res.status === 401) {           // token expired → drop and force re-auth
        accessToken = null;
        throw new Error('Google sign-in expired. Please try again.');
      }
      if (!res.ok) {
        return res.json().catch(() => ({})).then((body) => {
          const reason = body && (body.error && (body.error.message || body.error.status)) || res.statusText;
          throw new Error('Google error (' + res.status + (reason ? '): ' + reason : ').'));
        });
      }
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
    return withTimeout(fetch(API + '/files/' + fileId, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + accessToken },
    }), 30000, 'Google request timed out.').then((res) => {
      if (!res.ok && res.status !== 204) throw new Error('Could not remove an old duplicate backup (' + res.status + ').');
      return true;
    });
  }

  function uploadCreate(name, content, mime, parentId) {
    const metadata = { name, mimeType: mime || MIME };
    if (parentId) metadata.parents = [parentId];
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: mime || MIME }));
    return withTimeout(fetch(UPLOAD + '/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken },
      body: form,
    }), 60000, 'Google Drive upload timed out — check internet and try again.').then((res) => {
      if (!res.ok) throw new Error('Google Drive upload failed (' + res.status + ').');
      return res.json();
    });
  }

  function uploadUpdate(fileId, content, mime) {
    return withTimeout(fetch(UPLOAD + '/files/' + fileId + '?uploadType=media', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': mime || MIME },
      body: content,
    }), 60000, 'Google Drive update timed out — check internet and try again.').then((res) => {
      if (!res.ok) throw new Error('Google Drive update failed (' + res.status + ').');
      return res.json();
    });
  }

  /* ---------- dedicated backup folder ---------- */
  function folderName() {
    const d = getData();
    return (((d && d.settings && d.settings.businessName) || 'MyStore') + ' Records').replace(/[\\/:*?"<>|]/g, ' ').trim();
  }

  function rememberFolderId(id) {
    const d = getData();
    if (d && d.settings) d.settings.driveFolderId = id;   // in-memory so future persists keep it
    try {
      const raw = JSON.parse(localStorage.getItem(window.DB.KEY));
      if (raw && raw.settings) {
        raw.settings.driveFolderId = id;
        localStorage.setItem(window.DB.KEY, JSON.stringify(raw));
      }
    } catch (e) { /* non-fatal */ }
  }

  function createFolder(name) {
    return gapiFetch(API + '/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    }).then((j) => {
      if (!j || !j.id) throw new Error('Could not create the Drive folder.');
      rememberFolderId(j.id);
      return { id: j.id, name };
    });
  }

  function ensureFolder() {
    const d = getData();
    const cached = d && d.settings && d.settings.driveFolderId;
    if (cached) return Promise.resolve({ id: cached, name: folderName() });
    const nm = folderName();
    const q = encodeURIComponent("name='" + nm.replace(/'/g, "\\'") + "' and mimeType='" + FOLDER_MIME + "' and trashed=false");
    return gapiFetch(API + '/files?q=' + q + '&fields=files(id,name)')
      .then((j) => {
        if (j.files && j.files[0]) {
          rememberFolderId(j.files[0].id);
          return { id: j.files[0].id, name: nm };
        }
        return createFolder(nm);
      });
  }

  function findInFolder(folderId, name) {
    const q = encodeURIComponent(
      "name='" + name.replace(/'/g, "\\'") + "' and '" + folderId + "' in parents and trashed=false"
    );
    return gapiFetch(API + '/files?q=' + q + '&fields=files(id,name,modifiedTime)')
      .then((j) => (j.files || []));
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

  /* ---------- section builders — arrays of rows (header first) ----------
     One source of truth for both the CSV files and the Google Sheet tabs. */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(ts) {
    const dt = new Date(ts);
    return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
  }
  function fmtDateTime(ts) {
    const dt = new Date(ts);
    return fmtDate(ts) + ' ' + pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
  }

  function salesRows(d) {
    return [['Date', 'Item', 'Quantity', 'Unit', 'Unit Price', 'Total', 'Recorded By']]
      .concat((d.sales || []).slice()
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .map((s) => [fmtDateTime(s.ts), s.item, s.qty, s.unit || '',
          s.price != null ? s.price : '', s.amount, s.userName || '']));
  }

  function expensesRows(d) {
    return [['Date', 'Category', 'Details', 'Amount', 'Recorded By']]
      .concat((d.expenses || []).slice()
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .map((x) => [fmtDateTime(x.ts), x.category || '', x.note || '', x.amount, x.userName || '']));
  }

  function stockRows(d) {
    const unitOf = (name) => {
      const p = (d.products || []).find((p) => p.name === name);
      return p ? (p.unit || '') : '';
    };
    return [['Item', 'Quantity', 'Unit', 'Reorder Level', 'Status']]
      .concat((d.stock || []).slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((s) => [s.name, s.qty, unitOf(s.name), s.reorder != null ? s.reorder : 5,
          s.qty <= (s.reorder != null ? s.reorder : 5) ? 'LOW' : 'ok']));
  }

  function productsRows(d) {
    return [['Product', 'Price', 'Unit']]
      .concat((d.products || []).slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((p) => [p.name, p.price != null ? p.price : '', p.unit || '']));
  }

  function usersRows(d) {
    return [['Name', 'Role', 'Status']]   // PINs are never exported
      .concat((d.users || []).map((u) => [
        u.name, u.role === 'owner' ? 'Owner' : 'Sales',
        u.active === false ? 'Inactive' : 'Active',
      ]));
  }

  function attendanceRows(d) {
    const dates = Array.from(new Set((d.attendance || []).map((a) => a.date))).sort().reverse();
    const ids = [];
    (d.users || []).forEach((u) => { if (u.active !== false && ids.indexOf(u.id) < 0) ids.push(u.id); });
    (d.attendance || []).forEach((a) => { if (ids.indexOf(a.userId) < 0) ids.push(a.userId); });
    const names = ids.map((id) => {
      const u = (d.users || []).find((x) => x.id === id);
      return u ? u.name : '(removed)';
    });
    return [['Date'].concat(names)]
      .concat(dates.map((date) => [date].concat(ids.map((id) =>
        (d.attendance || []).some((a) => a.date === date && a.userId === id) ? 'A' : 'P'))));
  }

  const SHEETS = [
    { tab: 'Sales', file: 'Sales.csv', rows: salesRows },
    { tab: 'Expenses', file: 'Expenses.csv', rows: expensesRows },
    { tab: 'Stock', file: 'Stock.csv', rows: stockRows },
    { tab: 'Products', file: 'Products.csv', rows: productsRows },
    { tab: 'Staff Attendance', file: 'Staff Attendance.csv', rows: attendanceRows },
    { tab: 'Users', file: 'Users.csv', rows: usersRows },
  ];

  /* CSV rendering kept for the downloadable/legacy file copies */
  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function rowsToCsv(all) {
    return '﻿' + all.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }

  /* ---------- one file in the folder: create or update in place, drop extras ---------- */
  function syncOneFile(folder, file) {
    const mime = file.name.slice(-5) === '.json' ? MIME : CSV_MIME;
    return findInFolder(folder.id, file.name).then((found) => {
      const main = found[0] || null;
      const extras = found.slice(1);
      const chain = main
        ? uploadUpdate(main.id, file.text, mime).then((j) => j.id || main.id)
        : uploadCreate(file.name, file.text, mime, folder.id).then((j) => j.id);
      return chain
        .then((id) => Promise.allSettled(extras.map((f) => deleteFile(f.id))).then(() => id))
        .then((id) => ({ name: file.name, action: main ? 'updated' : 'created', id }));
    });
  }

  /* ---------- public actions ---------- */
  function saveToDrive() {
    if (!clientId()) return Promise.reject(new Error('No Google Client ID. Tap "Connect Google Account" first.'));
    const json = JSON.stringify(sanitizeData(getData()), null, 2);
    return getToken()
      .then(() => ensureFolder())
      .then((folder) => syncOneFile(folder, { name: FILE_NAME, text: json }))
      // self-heal: remove same-named backups living OUTSIDE the folder (e.g. old root copies)
      .then((res) => findBackupFiles().then((all) =>
        Promise.allSettled(all.filter((f) => f.id !== res.id).map((f) => deleteFile(f.id)))
          .then(() => res)));
  }

  /* Legacy sync: write every section as a CSV file plus the full JSON backup
     into the dedicated Drive folder — creating or updating in place, never
     duplicating. Kept as a fallback; the button now uses syncSheetToDrive(). */
  function syncSheetsToDrive() {
    if (!clientId()) return Promise.reject(new Error('No Google Client ID. Tap "Connect Google Account" first.'));
    const d = getData();
    return getToken()
      .then(() => ensureFolder())
      .then((folder) => {
        const files = SHEETS.map((s) => ({ name: s.file, text: rowsToCsv(s.rows(d)) }));
        files.push({ name: FILE_NAME, text: JSON.stringify(sanitizeData(d), null, 2) });
        let seq = Promise.resolve([]);
        files.forEach((f) => {
          seq = seq.then((results) => syncOneFile(folder, f).then((r) => results.concat(r)));
        });
        return seq.then((results) => ({ folder, results }));
      });
  }

  /* ---------- Google Sheets API: one workbook, one tab per section ---------- */
  function sheetTitle() { return folderName(); }   // same name as the folder

  function findSpreadsheetInFolder(folderId) {
    const q = encodeURIComponent(
      "name='" + sheetTitle().replace(/'/g, "\\'") + "' and mimeType='" + SHEET_MIME +
      "' and '" + folderId + "' in parents and trashed=false"
    );
    return gapiFetch(API + '/files?q=' + q + '&fields=files(id,name)')
      .then((j) => (j.files && j.files[0]) || null);
  }

  function createSpreadsheetInFolder(folderId) {
    return gapiFetch(API + '/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sheetTitle(), mimeType: SHEET_MIME, parents: [folderId] }),
    }).then((j) => {
      if (!j || !j.id) throw new Error('Could not create the Google Sheet.');
      return { id: j.id, name: sheetTitle() };
    });
  }

  function listTabNames(spreadsheetId) {
    return gapiFetch(SHEETS_API + '/' + spreadsheetId + '?fields=sheets.properties.title')
      .then((j) => ((j && j.sheets) || []).map((s) => s.properties.title));
  }

  function ensureSheetTabs(spreadsheetId) {
    return listTabNames(spreadsheetId).then((names) => {
      const requests = SHEETS
        .filter((s) => names.indexOf(s.tab) < 0)
        .map((s) => ({ addSheet: { properties: { title: s.tab } } }));
      if (!requests.length) return null;
      return gapiFetch(SHEETS_API + '/' + spreadsheetId + '/batchUpdate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      });
    });
  }

  /* Write a tab's full contents, then clear any leftover rows below them. */
  function writeSheetTab(spreadsheetId, tab, values) {
    const quoted = "'" + tab.replace(/'/g, "''") + "'";
    const putRange = quoted + '!A1';
    return gapiFetch(SHEETS_API + '/' + spreadsheetId + '/values/' + encodeURIComponent(putRange) +
      '?valueInputOption=RAW', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: putRange, majorDimension: 'ROWS', values }),
    }).then(() => {
      const tail = quoted + '!A' + (values.length + 1) + ':Z1000';
      return gapiFetch(SHEETS_API + '/' + spreadsheetId + '/values/' + encodeURIComponent(tail) + ':clear', {
        method: 'POST',
      });
    });
  }

  /* The main "Sync" action: real Google Sheet (tabs per section) + CSV files +
     JSON backup, all inside the "MyStore Records" folder. */
  /* Sync button: write every section into ONE Google Sheet (one tab per
     section) inside the dedicated Drive folder, refresh the CSV copies and the
     full JSON backup — creating or updating in place, never duplicating. */
  function syncSheetToDrive() {
    if (!clientId()) return Promise.reject(new Error('No Google Client ID. Tap "Connect Google Account" first.'));
    const d = getData();
    let folderRef = null;
    noteSyncStep('start');
    return getToken()
      .then(() => { noteSyncStep('ensure-folder'); return ensureFolder(); })
      .then((folder) => {
        folderRef = folder;
        noteSyncStep('find-or-create-sheet');
        return findSpreadsheetInFolder(folder.id)
          .then((found) => found || createSpreadsheetInFolder(folder.id))
          .then((sheet) => ({ folder, sheet }));
      })
      .then(({ folder, sheet }) => {
        noteSyncStep('ensure-tabs');
        return ensureSheetTabs(sheet.id)
          .then(() => {
            let seq = Promise.resolve([]);
            SHEETS.forEach((s) => {
              seq = seq.then((done) => {
                noteSyncStep('write-tab:' + s.tab);
                return writeSheetTab(sheet.id, s.tab, s.rows(d))
                  .then(() => done.concat(s.tab));
              });
            });
            return seq;
          })
          .then((tabs) => {
            // refresh the CSV copies too, so Excel/CSV workflows keep working
            let csv = Promise.resolve();
            SHEETS.forEach((s) => {
              csv = csv.then(() => {
                noteSyncStep('csv:' + s.file);
                return syncOneFile(folder, { name: s.file, text: rowsToCsv(s.rows(d)) });
              });
            });
            return csv.then(() => tabs);
          })
          .then((tabs) => {
            noteSyncStep('json-backup');
            return syncOneFile(folder, { name: FILE_NAME, text: JSON.stringify(sanitizeData(d), null, 2) })
              .then(() => ({ folder, sheet, tabs }));
          });
      })
      .then((result) => { noteSyncStep('done'); return result; })
      .catch((e) => {
        lastSyncError = (e && e.message) || String(e);
        try { window.__syncDebug.error = lastSyncError; } catch (err) {}
        throw e;
      });
  }

  function loadFromDrive() {
    if (!clientId()) return Promise.reject(new Error('No Google Client ID. Tap "Connect Google Account" first.'));
    return getToken()
      .then(() => findBackupFile())
      .then((file) => {
        if (!file) throw new Error('No backup file found on this Google Drive (' + FILE_NAME + '). Save once first.');
        return withTimeout(fetch(API + '/files/' + file.id + '?alt=media', {
          headers: { Authorization: 'Bearer ' + accessToken },
        }), 30000, 'Google Drive download timed out — check internet and try again.').then((res) => {
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
    syncSheetToDrive,         // Google Sheets workbook (one tab per section) + JSON into the dedicated folder
    syncSheetsToDrive,        // legacy: CSV files + JSON into the dedicated folder
    loadFromDrive,
    // test hooks
    _findBackupFile: () => getToken().then(findBackupFile),
    _sanitize: sanitizeData,
    _reset: () => { accessToken = null; tokenClient = null; },
    _setToken: (t) => { accessToken = t; },
    _lastError: () => lastSyncError,
  };
})();
