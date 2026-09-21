/* ===== db.js — localStorage data layer ===== */
(function () {
  'use strict';
  const KEY = 'shop_records_v1';

  const DEFAULT_CATEGORIES = ['Rent', 'Stock Buying', 'Transport', 'Other'];
  const DEFAULT_UNITS = ['kg', 'g', 'litre', 'ml', 'sachet', 'tin', 'box', 'bag (25kg)', 'carton', 'dozen', 'piece', 'pack', 'bottle'];

  window.DEFAULTS = { CATEGORIES: DEFAULT_CATEGORIES, UNITS: DEFAULT_UNITS };

  function blank() {
    return {
      updatedAt: 0,
      users: [],            // {id, name, pin, role: 'proprietor'|'employee', active}
      settings: {
        businessName: 'MyStore',
        currency: 'UGX',
        customCurrency: '',
        categories: DEFAULT_CATEGORIES.slice(),
        units: DEFAULT_UNITS.slice(),      // units of measurement, editable
        budgets: {},
        appLock: false,
        driveClientId: '',   // Google OAuth Client ID for Drive backup
        store: { name: '', contact: '', phone: '', email: '', website: '' },
        workDays: [1, 1, 1, 1, 1, 0, 0],   // Mon..Sun — 1 = work day (Settings → Work Days)
        workHours: { start: '08:00', end: '17:00' },
      },
      products: [],         // {id, name, price, unit}
      sales: [],            // {id, item, qty, amount, price, unit, ts, userId, userName}
      expenses: [],         // {id, amount, note, category, ts, userId, userName}
      stock: [],            // {id, name, qty, reorder, updatedAt}
      attendance: [],       // only ABSENT marks are stored: {id, userId, userName, date:'YYYY-MM-DD', ts, markedBy}
      sync: {               // offline-first cloud sync (see js/sync.js)
        shopId: '',         // random code identifying this shop's cloud copy
        deviceId: '',       // random code identifying this device
        lastSyncAt: 0,      // last successful two-way sync (ms)
        config: null,       // {apiKey, databaseURL, projectId} — set in Settings → Sync
      },
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const d = JSON.parse(raw);
      const b = blank();
      // merge to tolerate older backups
      const merged = {
        updatedAt: d.updatedAt || 0,
        users: Array.isArray(d.users) ? d.users : [],
        settings: Object.assign(b.settings, d.settings || {}),
        products: Array.isArray(d.products) ? d.products : [],
        sales: Array.isArray(d.sales) ? d.sales : [],
        expenses: Array.isArray(d.expenses) ? d.expenses : [],
        stock: Array.isArray(d.stock) ? d.stock : [],
        attendance: Array.isArray(d.attendance) ? d.attendance : [],
        sync: Object.assign(b.sync, d.sync || {}),
      };
      merged.settings.store = Object.assign(b.settings.store, (d.settings && d.settings.store) || {});
      merged.settings.workHours = Object.assign(b.settings.workHours, (d.settings && d.settings.workHours) || {});
      if (!Array.isArray(merged.settings.workDays) || merged.settings.workDays.length !== 7)
        merged.settings.workDays = [1, 1, 1, 1, 1, 0, 0];
      if (!Array.isArray(merged.settings.units) || !merged.settings.units.length)
        merged.settings.units = DEFAULT_UNITS.slice();
      // migrate old stock field 'low' → 'reorder'
      merged.stock.forEach((s) => {
        if (s.reorder == null) s.reorder = s.low == null ? 5 : s.low;
        delete s.low;
      });
      // migrate: explicit "Staff" flag for Attendance — employees show up by
      // default (unchanged behaviour), the Proprietor does not unless added
      // on purpose in Settings → Users (Staff: On)
      // migrate: "type" (Proprietor/Employee/Other) — a label distinct from
      // "role" (which only ever controls permissions: proprietor vs employee).
      // Existing users default to a type matching their role.
      merged.users.forEach((u) => {
        if (u.isStaff == null) u.isStaff = u.role !== 'proprietor';
        if (!u.type) u.type = u.role === 'proprietor' ? 'proprietor' : 'employee';
      });
      return merged;
    } catch (e) {
      console.error('Data load failed, starting blank', e);
      return blank();
    }
  }

  function save(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  window.DB = { load, save, uid, KEY };
})();
