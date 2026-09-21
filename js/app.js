/* ===== app.js — Shop Records PWA logic ===== */
(function () {
  'use strict';

  window.App = window.App || {};   // created first — sync.js hooks into this below

  let data = DB.load();
  let session = null;          // logged-in user object
  let pendingPinUser = null;
  let pinBuffer = '';
  let currentPeriod = 'today';
  let reportPeriod = 'today';
  let reportType = 'all';
  let dashView = 'all';
  let sellersMode = 'qty';      // rank sellers by 'qty' sold or 'money' value
  const quickCart = {};             // productId -> qty (Quick Sale)
  let pickedSaleItem = null;
  let pickedCategory = null;
  let adjustStockId = null;
  let pinTargetUserId = null;
  let lastDeleted = null;      // {kind, record}

  const $ = (id) => document.getElementById(id);

  /* ---------- helpers ---------- */
  function persist() {
    data.updatedAt = Date.now();
    DB.save(data);
    if (window.Sync) Sync.scheduleSync();
  }

  // exposed for sync.js
  App.getData = function () { return data; };
  App.toast = toast;
  App.askConfirm = askConfirm;
  App.replaceData = function (d) {
    data = d;
    DB.save(data);
    if (session) { applyPermissions(); refreshAll(); }
    else renderLogin();
  };

  function money(n) {
    const sym = data.settings.currency === 'CUSTOM'
      ? (data.settings.customCurrency || '')
      : data.settings.currency;
    const num = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sym ? sym + ' ' + num : num;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' +
           d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function startOfPeriod(period, from) {
    const d = new Date(from || Date.now());
    d.setHours(0, 0, 0, 0);
    if (period === 'today') return d;
    if (period === 'week') {
      const day = (d.getDay() + 6) % 7; // Monday = 0
      d.setDate(d.getDate() - day);
      return d;
    }
    if (period === 'month') { d.setDate(1); return d; }
    if (period === 'year') { d.setMonth(0, 1); return d; }
    return d;
  }

  function inPeriod(ts, period) {
    if (period === 'all') return true;
    return ts >= startOfPeriod(period).getTime();
  }

  function sum(list, key) {
    return list.reduce((a, r) => a + (Number(r[key]) || 0), 0);
  }

  let toastTimer = null;
  function toast(msg, opts) {
    const t = $('toast');
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    if (opts && opts.undo) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'Undo';
      b.onclick = () => { opts.undo(); hideToast(); };
      t.appendChild(b);
    }
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, (opts && opts.long) ? 6000 : 3200);
  }
  function hideToast() { $('toast').classList.add('hidden'); }

  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(el) {
    if (typeof el === 'string') $(el).classList.add('hidden');
    else el.closest('.modal').classList.add('hidden');
  }

  let confirmCb = null;
  function askConfirm(title, text, cb) {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    confirmCb = cb;
    openModal('modal-confirm');
  }
  $('btn-confirm-yes').addEventListener('click', () => {
    closeModal('modal-confirm');
    if (confirmCb) confirmCb();
    confirmCb = null;
  });
  $('btn-confirm-no').addEventListener('click', () => closeModal('modal-confirm'));

  /* ---------- login flow ---------- */
  const LAST_USER_KEY = 'shop_records_last_user';

  function renderLogin() {
    $('login-business-name').textContent = data.settings.businessName;
    const hasProp = data.users.some((u) => u.role === 'proprietor');
    $('login-setup').classList.toggle('hidden', hasProp);
    $('login-pick').classList.toggle('hidden', !hasProp);
    $('login-pin').classList.add('hidden');
    if (hasProp) {
      renderUserList();
      // fast path: regular users of this phone go straight to their PIN
      const lastId = localStorage.getItem(LAST_USER_KEY);
      const last = lastId && data.users.find((u) => u.id === lastId && u.active !== false);
      if (last) {
        $('login-pick').classList.add('hidden');
        beginPin(last);
      }
    }
  }

  function renderUserList() {
    const sel = $('login-user-select');
    sel.innerHTML = '';
    const active = data.users.filter((u) => u.active !== false);
    if (!active.length) {
      const o = document.createElement('option');
      o.textContent = 'No active users — ask the Proprietor to add you';
      o.value = '';
      sel.appendChild(o);
      return;
    }
    active.forEach((u) => {
      const o = document.createElement('option');
      o.value = u.id;
      o.textContent = u.name + (u.role === 'proprietor' ? ' (Proprietor)' : ' (Sales)');
      sel.appendChild(o);
    });
  }

  $('btn-login-next').addEventListener('click', () => {
    const id = $('login-user-select').value;
    const user = data.users.find((u) => u.id === id && u.active !== false);
    if (!user) return toast('Pick your name from the list.');
    beginPin(user);
  });

  function beginPin(user) {
    pendingPinUser = user;
    pinBuffer = '';
    $('pin-for').textContent = user.name + ', enter your PIN';
    $('login-pick').classList.add('hidden');
    $('login-pin').classList.remove('hidden');
    renderPinDots();
  }

  function renderPinDots() {
    const wrap = $('pin-display');
    wrap.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const d = document.createElement('div');
      d.className = 'pin-dot' + (i < pinBuffer.length ? ' filled' : '');
      wrap.appendChild(d);
    }
  }

  function buildPinPad() {
    const pad = $('pin-pad');
    pad.innerHTML = '';
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, '⌫'].forEach((k) => {
      const b = document.createElement('button');
      b.className = 'pin-key';
      b.textContent = k;
      b.onclick = () => {
        if (k === 'C') pinBuffer = '';
        else if (k === '⌫') pinBuffer = pinBuffer.slice(0, -1);
        else if (pinBuffer.length < 4) pinBuffer += String(k);
        renderPinDots();
        if (pinBuffer.length === 4) setTimeout(checkPin, 150);
      };
      pad.appendChild(b);
    });
  }

  function checkPin() {
    if (pendingPinUser && pinBuffer === pendingPinUser.pin) {
      session = pendingPinUser;
      pinBuffer = '';
      localStorage.setItem(LAST_USER_KEY, session.id);   // fast login next time
      enterApp();
    } else {
      toast('Wrong PIN. Try again.');
      pinBuffer = '';
      renderPinDots();
    }
  }

  $('btn-pin-back').addEventListener('click', () => {
    $('login-pin').classList.add('hidden');
    $('login-pick').classList.remove('hidden');
    pinBuffer = '';
  });

  /* proprietor setup (first launch) */
  function setupPinRow(id) {
    const el = $(id);
    el.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const d = document.createElement('div');
      d.className = 'pin-dot';
      el.appendChild(d);
    }
  }
  function watchPinInputs(aId, bId) {
    const a = $(aId), b = $(bId);
    function paint() {
      [[a, aId + '-dots'], [b, bId + '-dots']].forEach(([inp, rowId]) => {
        const row = $(rowId);
        if (!row) return;
        Array.from(row.children).forEach((d, i) =>
          d.classList.toggle('filled', i < inp.value.length));
      });
    }
    [a, b].forEach((inp) => inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(0, 4);
      paint();
    }));
  }

  $('btn-setup-done').addEventListener('click', () => {
    const store = $('setup-store').value.trim();
    const name = $('setup-name').value.trim() || 'Milly';
    const p1 = $('setup-pin').value || '';
    const p2 = $('setup-pin2').value || '';
    if (!store) return toast('Please enter the store / business name.');
    if (!/^\d{4}$/.test(p1)) return toast('PIN must be exactly 4 digits.');
    if (p1 !== p2) return toast('PINs do not match. Try again.');
    data.settings.businessName = store;
    data.settings.store = data.settings.store || {};
    data.settings.store.name = store;
    const proprietor = { id: DB.uid(), name, pin: p1, role: 'proprietor', active: true };
    data.users.push(proprietor);
    // default sales person (PIN 1234, renameable in Settings)
    data.users.push({ id: DB.uid(), name: 'Sales Person 1', pin: '1234', role: 'employee', active: true });
    persist();
    session = proprietor;
    toast('Store "' + store + '" created ✓ Proprietor: ' + name + ' · Sales Person 1 added (PIN 1234)');
    enterApp();
  });

  /* cancel setup: clear everything typed, save nothing */
  $('btn-setup-cancel').addEventListener('click', () => {
    $('setup-store').value = '';
    $('setup-name').value = 'Milly';
    $('setup-pin').value = '';
    $('setup-pin2').value = '';
    [$('setup-pin'), $('setup-pin2')].forEach((inp) => inp.dispatchEvent(new Event('input')));
    toast('Setup cancelled — nothing was saved.');
  });

  /* ---------- app shell ---------- */
  function enterApp() {
    $('screen-login').classList.remove('active');
    $('shell').classList.remove('hidden');
    applyPermissions();
    $('hdr-business').textContent = data.settings.businessName;
    $('hdr-user').textContent = 'Logged in as ' + session.name +
      (session.role === 'proprietor' ? ' (Proprietor)' : ' (Sales)');
    go(dashAllowed() ? 'page-home' : 'page-in');
    refreshAll();
  }

  function dashAllowed() {
    return session && (session.role === 'proprietor' || session.dash !== false);
  }

  function applyPermissions() {
    const isProp = session && session.role === 'proprietor';
    document.querySelectorAll('.proprietor-only').forEach((el) =>
      el.classList.toggle('hidden', !isProp));
    // per-user dashboard access (proprietor sets it in Settings → Users; default on)
    const dash = dashAllowed();
    $('nav-dash').classList.toggle('hidden', !dash);
    $('btn-open-summary').classList.toggle('hidden', !dash);
    $('more-summary').classList.toggle('hidden', !dash);
    $('summary-card').classList.toggle('hidden', !dash);
  }

  $('btn-logout').addEventListener('click', () => {
    session = null;
    $('shell').classList.add('hidden');
    $('screen-login').classList.add('active');
    renderLogin();
  });

  function go(pageId) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    $(pageId).classList.add('active');
    document.querySelectorAll('.nav-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.page === pageId));
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.page)));
  document.querySelectorAll('.more-item').forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.go)));

  /* ---------- dashboard ---------- */
  function filteredSales(period) { return data.sales.filter((s) => inPeriod(s.ts, period)); }
  function filteredExpenses(period) { return data.expenses.filter((e) => inPeriod(e.ts, period)); }

  function reorderOf(s) { return s.reorder == null ? 5 : s.reorder; }
  function lowStockCount() { return data.stock.filter((s) => s.qty <= reorderOf(s)).length; }

  function renderAccountBalance() {
    const mIn = sum(data.sales.filter((s) => inPeriod(s.ts, 'month')), 'amount');
    const mOut = sum(data.expenses.filter((e) => inPeriod(e.ts, 'month')), 'amount');
    $('bal-in').textContent = money(mIn);
    $('bal-out').textContent = money(mOut);
    const net = mIn - mOut;
    const row = document.querySelector('.balance-row.total');
    if (row) row.classList.toggle('negative', net < 0);
    $('bal-net').textContent = (net < 0 ? '−' : '') + money(Math.abs(net));
  }

  function renderDashboard() {
    const sales = filteredSales(currentPeriod);
    const exps = filteredExpenses(currentPeriod);
    const tin = sum(sales, 'amount');
    const tout = sum(exps, 'amount');
    $('stat-in').textContent = money(tin);
    $('stat-out').textContent = money(tout);
    const profit = tin - tout;
    const pCard = document.querySelector('.stat-card.profit');
    pCard.classList.toggle('negative', profit < 0);
    $('stat-profit').textContent = (profit < 0 ? '−' : '') + money(Math.abs(profit));

    document.querySelectorAll('#period-filter .chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.period === currentPeriod));

    // KPI counts
    $('kpi-sales-count').textContent = sales.length;
    $('kpi-exp-count').textContent = exps.length;
    $('kpi-stock-items').textContent = data.stock.length;
    $('kpi-low-stock').textContent = lowStockCount();
    const att = attendanceToday();
    $('kpi-staff-present').textContent = att.present;
    $('kpi-staff-absent').textContent = att.absent.size;

    applyDashView();
    renderSummary(sales, exps);
    renderDashStock();
    const isEmptyShop = !data.sales.length && !data.expenses.length &&
      !data.stock.length && !data.products.length;
    $('welcome-card').classList.toggle('hidden', !isEmptyShop);
    drawChart();
    renderSellerRank(sales);
    if (session.role === 'proprietor') renderByPerson(sales);
  }

  function bucketCounts() {
    // returns {labels, in[], out[]} for current period
    const now = new Date();
    const labels = [], ins = [], outs = [];
    if (currentPeriod === 'today') {
      for (let h = 6; h <= 21; h += 3) {
        labels.push((h % 12 || 12) + (h < 12 ? 'am' : 'pm'));
        const a = new Date(now); a.setHours(h, 0, 0, 0);
        const b = new Date(now); b.setHours(h + 3, 0, 0, 0);
        ins.push(sum(data.sales.filter((s) => s.ts >= a && s.ts < b), 'amount'));
        outs.push(sum(data.expenses.filter((e) => e.ts >= a && e.ts < b), 'amount'));
      }
    } else if (currentPeriod === 'week') {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
        const e = new Date(d); e.setDate(e.getDate() + 1);
        labels.push(d.toLocaleDateString(undefined, { weekday: 'short' }));
        ins.push(sum(data.sales.filter((s) => s.ts >= d && s.ts < e), 'amount'));
        outs.push(sum(data.expenses.filter((x) => x.ts >= d && x.ts < e), 'amount'));
      }
    } else if (currentPeriod === 'month') {
      for (let i = 3; i >= 0; i--) {
        const d = new Date(now); d.setDate(1); d.setMonth(d.getMonth() - i);
        const e = new Date(d); e.setMonth(e.getMonth() + 1);
        labels.push(d.toLocaleDateString(undefined, { month: 'short' }));
        ins.push(sum(data.sales.filter((s) => s.ts >= d && s.ts < e), 'amount'));
        outs.push(sum(data.expenses.filter((x) => x.ts >= d && x.ts < e), 'amount'));
      }
    } else {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now); d.setMonth(d.getMonth() - i, 1); d.setHours(0, 0, 0, 0);
        const e = new Date(d); e.setMonth(e.getMonth() + 1);
        labels.push(d.toLocaleDateString(undefined, { month: 'short' }));
        ins.push(sum(data.sales.filter((s) => s.ts >= d && s.ts < e), 'amount'));
        outs.push(sum(data.expenses.filter((x) => x.ts >= d && x.ts < e), 'amount'));
      }
    }
    return { labels, ins, outs };
  }

  function drawChart() {
    const cv = $('chart');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 320;
    const h = 140;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const { labels, ins, outs } = bucketCounts();
    const max = Math.max(1, ...ins, ...outs);
    const n = labels.length;
    const pad = 8, base = h - 22;
    const slot = (w - pad * 2) / n;
    const bw = Math.min(12, slot / 3);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    labels.forEach((lb, i) => {
      const cx = pad + slot * i + slot / 2;
      const hi = (ins[i] / max) * (base - 10);
      const ho = (outs[i] / max) * (base - 10);
      ctx.fillStyle = '#0f9d58';
      ctx.fillRect(cx - bw - 1, base - hi, bw, hi);
      ctx.fillStyle = '#e8590c';
      ctx.fillRect(cx + 1, base - ho, bw, ho);
      ctx.fillStyle = '#6b7280';
      ctx.fillText(lb, cx, h - 8);
    });
  }

  /* top & slowest sellers, plus items not sold at all this period */
  function sellerStats(sales) {
    // returns {rank: [[item, qty, amount]], notSold: [names]} honoring sellersMode
    const qtyOf = {}, amtOf = {};
    sales.forEach((s) => {
      qtyOf[s.item] = (qtyOf[s.item] || 0) + Number(s.qty || 0);
      amtOf[s.item] = (amtOf[s.item] || 0) + Number(s.amount || 0);
    });
    const rank = Object.keys(qtyOf)
      .map((it) => [it, qtyOf[it], amtOf[it]])
      .sort((a, b) => (sellersMode === 'money' ? b[2] - a[2] : b[1] - a[1]));
    const notSold = [];
    data.products.forEach((p) => { if (!qtyOf[p.name]) notSold.push(p.name); });
    data.stock.forEach((s) => { if (!qtyOf[s.name] && !notSold.includes(s.name)) notSold.push(s.name); });
    return { rank, notSold };
  }

  function renderSellerRank(sales) {
    const el = $('seller-rank');
    const { rank, notSold } = sellerStats(sales);
    if (!rank.length) {
      el.className = 'rows-empty';
      el.textContent = 'No sales yet in this period.';
      return;
    }
    el.className = '';
    const fmtVal = (q, a) => sellersMode === 'money' ? money(a) : q + ' sold';
    const row = (item, q, a, cls, note) =>
      '<div class="row-item"><div class="main"><div class="title">' + esc(item) + '</div>' +
      '<div class="sub">' + note + '</div></div><div class="val ' + (cls || '') + '">' + fmtVal(q, a) + '</div></div>';
    let html = '<div class="r-section">🏆 Top sellers</div>' +
      rank.slice(0, 3).map(([i, q, a]) => row(i, q, a, 'in', 'best moving')).join('');
    if (rank.length > 3) {
      html += '<div class="r-section">🐢 Slowest sellers</div>' +
        rank.slice(-3).reverse().map(([i, q, a]) => row(i, q, a, 'out', 'sells the least — check price / stock')).join('');
    }
    if (notSold.length) {
      html += '<div class="r-section">😴 Not sold this period</div>' +
        notSold.slice(0, 4).map((i) =>
          '<div class="row-item"><div class="main"><div class="title">' + esc(i) +
          '</div></div><div class="val">' + (sellersMode === 'money' ? money(0) : '0 sold') + '</div></div>').join('') +
        (notSold.length > 4 ? '<p class="muted small-note">+' + (notSold.length - 4) + ' more not sold.</p>' : '');
    }
    el.innerHTML = html;
  }

  /* sellers by quantity or money — shared by dashboard card, summary and reports */
  function setSellersMode(mode) {
    sellersMode = mode;
    document.querySelectorAll('#sellers-filter .mini-chip, #summary-sellers-filter .mini-chip')
      .forEach((c) => c.classList.toggle('active', c.dataset.smode === mode));
    renderSellerRank(filteredSales(currentPeriod));
    if (session && !$('modal-summary').classList.contains('hidden')) renderFullSummary();
  }
  document.querySelectorAll('#sellers-filter .mini-chip, #summary-sellers-filter .mini-chip')
    .forEach((c) => c.addEventListener('click', () => setSellersMode(c.dataset.smode)));

  function renderByPerson(sales) {
    const byUser = {};
    sales.forEach((s) => { byUser[s.userName] = (byUser[s.userName] || 0) + Number(s.amount || 0); });
    const arr = Object.entries(byUser).sort((a, b) => b[1] - a[1]);
    const el = $('by-person');
    if (!arr.length) { el.className = 'rows-empty'; el.textContent = 'No sales yet in this period.'; return; }
    el.className = '';
    el.innerHTML = arr.map(([name, amt]) =>
      '<div class="row-item"><div class="main"><div class="title">' + esc(name) +
      '</div></div><div class="val in">' + money(amt) + '</div></div>').join('');
  }

  document.querySelectorAll('#period-filter .chip').forEach((c) =>
    c.addEventListener('click', () => {
      currentPeriod = c.dataset.period;
      renderDashboard();
    }));

  /* dashboard view filter: all / sales / account / stock / attendance */
  function applyDashView() {
    document.querySelectorAll('#view-filter .chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.view === dashView));
    const show = {
      sales: dashView === 'all' || dashView === 'sales',
      exp: dashView === 'all' || dashView === 'account',
      stock: dashView === 'all' || dashView === 'stock',
      att: dashView === 'all' || dashView === 'attendance',
    };
    document.querySelectorAll('#page-home .dv-sales').forEach((el) => el.classList.toggle('hidden', !show.sales));
    document.querySelectorAll('#page-home .dv-exp').forEach((el) => el.classList.toggle('hidden', !show.exp));
    document.querySelectorAll('#page-home .dv-stock').forEach((el) => el.classList.toggle('hidden', !show.stock));
    document.querySelectorAll('#page-home .dv-att').forEach((el) => el.classList.toggle('hidden', !show.att));
  }

  document.querySelectorAll('#view-filter .chip').forEach((c) =>
    c.addEventListener('click', () => {
      dashView = c.dataset.view;
      renderDashboard();
    }));

  /* empty-state call-to-action helpers */
  window.App.openNewSale = function () { go('page-in'); $('btn-new-sale').click(); };
  window.App.openNewExpense = function () { go('page-out'); $('btn-new-expense').click(); };
  window.App.openNewStock = function () { go('page-stock'); $('btn-new-stock').click(); };
  $('btn-welcome-tutorial').addEventListener('click', () => {
    tutIdx = 0; renderTutorial(); openModal('modal-tutorial');
  });

  /* summary of key records for the selected period */
  function renderSummary(sales, exps) {
    const periodName = { today: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }[currentPeriod];
    $('summary-title').textContent = '📋 Summary — ' + periodName;
    const tin = sum(sales, 'amount'), tout = sum(exps, 'amount');
    const net = tin - tout;

    const best = {};
    sales.forEach((s) => { best[s.item] = (best[s.item] || 0) + Number(s.qty || 0); });
    const bestArr = Object.entries(best).sort((a, b) => b[1] - a[1]);
    const bestLine = bestArr.length
      ? esc(bestArr[0][0]) + ' (' + bestArr[0][1] + ' sold)' : '—';

    const lowItems = data.stock.filter((s) => s.qty <= reorderOf(s)).map((s) => s.name);
    const stockLine = data.stock.length
      ? data.stock.length + ' items' + (lowItems.length ? ' · Low: ' + esc(lowItems.join(', ')) : ' · all OK')
      : 'no stock recorded yet';

    const row = (label, val, cls) =>
      '<div class="row-item"><div class="main">' + label + '</div><div class="val ' + (cls || '') + '">' + val + '</div></div>';
    $('summary-body').innerHTML =
      row('Sales', sales.length + ' sale' + (sales.length === 1 ? '' : 's') + ' · ' + money(tin), 'in') +
      row('Expenses', exps.length + ' payment' + (exps.length === 1 ? '' : 's') + ' · ' + money(tout), 'out') +
      row('Balance', (net < 0 ? '−' : '') + money(Math.abs(net)), net < 0 ? 'out' : 'in') +
      row('Stock', stockLine) +
      row('Best seller', bestLine);
  }

  $('btn-share-summary').addEventListener('click', () => {
    const text = $('summary-title').textContent.replace('📋 ', '') + '\n' +
      $('summary-body').innerText + '\n— sent from MyStore';
    if (navigator.share) {
      navigator.share({ title: 'MyStore summary', text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => toast('Summary copied ✓ Paste it in WhatsApp or anywhere.', { long: true }))
        .catch(() => toast('Could not copy on this browser.'));
    } else {
      toast('Sharing is not supported on this browser.');
    }
  });

  /* stock overview card on the dashboard */
  function renderDashStock() {
    const el = $('dash-stock-list');
    if (!data.stock.length) {
      el.className = 'rows-empty';
      el.textContent = 'No stock items yet. Tap "+ Add Stock Item" on the Stock tab.';
      return;
    }
    el.className = '';
    const sorted = data.stock.slice().sort((a, b) => (a.qty <= reorderOf(a) ? -1 : 0) - (b.qty <= reorderOf(b) ? -1 : 0) || a.name.localeCompare(b.name));
    el.innerHTML = sorted.slice(0, 8).map((s) => {
      const low = s.qty <= reorderOf(s);
      return '<div class="row-item"><div class="main"><div class="title">' + esc(s.name) +
        (low ? ' <span class="badge low">Low!</span>' : '') +
        '</div><div class="sub">Reorder: ' + reorderOf(s) + '</div></div><div class="val">' + s.qty + ' left</div></div>';
    }).join('') + (sorted.length > 8 ? '<p class="muted small-note">+' + (sorted.length - 8) + ' more on the Stock tab.</p>' : '');
  }


  /* ---------- sales ---------- */
  let pickedProductId = null;   // product picked from list
  let saleAmountTouched = false; // user edited "amount received" manually

  $('btn-new-sale').addEventListener('click', () => {
    pickedSaleItem = null;
    pickedProductId = null;
    saleAmountTouched = false;
    $('sale-item-custom').value = '';
    $('sale-qty').value = '1';
    $('sale-price').value = '';
    $('sale-amount').value = '';
    $('sale-total').textContent = '—';
    $('sale-unit-lbl').textContent = 'item';
    renderSaleItemPicker();
    openModal('modal-sale');
    setTimeout(() => $('sale-qty').focus(), 250);
  });

  function selectedProduct() {
    if (pickedProductId)
      return data.products.find((p) => p.id === pickedProductId) || null;
    if (pickedSaleItem)
      return data.products.find((p) => p.name.toLowerCase() === pickedSaleItem.toLowerCase()) || null;
    return null;
  }

  function applyProductToSale(prod) {
    if (prod) {
      $('sale-price').value = Math.round(prod.price);
      $('sale-unit-lbl').textContent = prod.unit || 'item';
    } else {
      $('sale-unit-lbl').textContent = 'item';
    }
    computeSaleTotal();
  }

  function computeSaleTotal() {
    const qty = parseInt($('sale-qty').value, 10) || 0;
    const price = parseFloat($('sale-price').value) || 0;
    const total = qty * price;
    $('sale-total').textContent = total > 0 ? money(total) : '—';
    if (!saleAmountTouched) $('sale-amount').value = total > 0 ? String(Math.round(total)) : '';
  }

  function renderSaleItemPicker() {
    const wrap = $('sale-items');
    wrap.innerHTML = '';
    // products first — name, price and unit shown on the button
    data.products.slice(0, 30).forEach((p) => {
      const b = document.createElement('button');
      b.className = 'pick' + (pickedProductId === p.id ? ' selected' : '');
      b.innerHTML = esc(p.name) + ' <small>' + money(p.price) + ' / ' + esc(p.unit || 'unit') + '</small>';
      b.onclick = () => {
        pickedProductId = p.id;
        pickedSaleItem = null;
        $('sale-item-custom').value = '';
        applyProductToSale(p);
        renderSaleItemPicker();
      };
      wrap.appendChild(b);
    });
    // items sold before or in stock, not in the product list
    const names = new Set();
    data.sales.forEach((s) => names.add(s.item));
    data.stock.forEach((s) => names.add(s.name));
    Array.from(names).slice(0, 15).forEach((n) => {
      if (data.products.some((p) => p.name.toLowerCase() === n.toLowerCase())) return;
      const b = document.createElement('button');
      b.className = 'pick' + (pickedSaleItem === n ? ' selected' : '');
      b.textContent = n;
      b.onclick = () => {
        pickedSaleItem = n;
        pickedProductId = null;
        $('sale-item-custom').value = '';
        applyProductToSale(data.products.find((p) => p.name.toLowerCase() === n.toLowerCase()) || null);
        renderSaleItemPicker();
      };
      wrap.appendChild(b);
    });
  }

  $('sale-item-custom').addEventListener('input', () => {
    if ($('sale-item-custom').value.trim()) {
      pickedSaleItem = null;
      pickedProductId = null;
      $('sale-unit-lbl').textContent = 'item';
      computeSaleTotal();
      renderSaleItemPicker();
    }
  });

  ['sale-qty', 'sale-price'].forEach((id) =>
    $(id).addEventListener('input', computeSaleTotal));
  $('sale-amount').addEventListener('input', () => { saleAmountTouched = true; });

  $('btn-save-sale').addEventListener('click', () => {
    const custom = $('sale-item-custom').value.trim();
    const prod = selectedProduct();
    const item = custom || (prod && prod.name) || pickedSaleItem;
    const qty = parseInt($('sale-qty').value, 10);
    const amount = parseFloat($('sale-amount').value);
    const price = parseFloat($('sale-price').value) || null;
    const unit = prod ? (prod.unit || '') : '';
    if (!item) return toast('Pick or type the item sold.');
    if (!qty || qty < 1) return toast('Enter a valid quantity.');
    if (!amount || amount <= 0) return toast('Enter the amount received.');
    data.sales.push({
      id: DB.uid(), item, qty, amount, price, unit,
      ts: Date.now(), userId: session.id, userName: session.name,
    });
    // auto-deduct stock if item matches
    const st = data.stock.find((s) => s.name.toLowerCase() === item.toLowerCase());
    if (st) { st.qty = Math.max(0, st.qty - qty); st.updatedAt = Date.now(); }
    persist();
    closeModal('modal-sale');
    toast('Sale saved ✓ ' + money(amount));
    refreshAll();
  });

  function renderSalesList() {
    const el = $('sales-list');
    const recent = data.sales.slice(-20).reverse();
    const todayTotal = sum(data.sales.filter((s) => inPeriod(s.ts, 'today')), 'amount');
    $('today-in').textContent = money(todayTotal);
    if (!recent.length) {
      el.className = '';
      el.innerHTML = '<p class="muted">No sales recorded yet.</p>' +
        '<button class="btn btn-primary btn-block" onclick="App.openNewSale()">＋ Record your first sale</button>';
      return;
    }
    el.className = '';
    el.innerHTML = recent.map((s) => {
      const del = session.role === 'proprietor'
        ? ' <button class="btn btn-small btn-ghost" onclick="App.deleteRecord(\'sale\',\'' + s.id + '\')">Delete</button>' : '';
      return '<div class="row-item"><div class="main"><div class="title">' + esc(s.item) +
        (s.qty > 1 ? ' × ' + s.qty : '') + '</div><div class="sub">' + fmtDate(s.ts) +
        ' · by ' + esc(s.userName) + '</div></div><div class="val in">' + money(s.amount) + '</div>' + del + '</div>';
    }).join('');
  }

  /* ---------- expenses ---------- */
  $('btn-new-expense').addEventListener('click', () => {
    pickedCategory = null;
    $('exp-amount').value = '';
    $('exp-note').value = '';
    renderCategoryPicker();
    openModal('modal-expense');
    setTimeout(() => $('exp-amount').focus(), 250);
  });

  function renderCategoryPicker() {
    const wrap = $('exp-categories');
    wrap.innerHTML = '';
    data.settings.categories.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'pick' + (pickedCategory === c ? ' selected' : '');
      b.textContent = c;
      b.onclick = () => { pickedCategory = c; renderCategoryPicker(); };
      wrap.appendChild(b);
    });
  }

  $('btn-save-expense').addEventListener('click', () => {
    const amount = parseFloat($('exp-amount').value);
    const note = $('exp-note').value.trim();
    const category = pickedCategory;
    if (!amount || amount <= 0) return toast('Enter the amount spent.');
    if (!category) return toast('Pick a category.');
    data.expenses.push({
      id: DB.uid(), amount, note, category,
      ts: Date.now(), userId: session.id, userName: session.name,
    });
    persist();
    closeModal('modal-expense');
    toast('Expense saved ✓ ' + money(amount));
    refreshAll();
  });

  function renderExpensesList() {
    const el = $('expenses-list');
    const recent = data.expenses.slice(-20).reverse();
    if (!recent.length) {
      el.className = '';
      el.innerHTML = '<p class="muted">No expenses recorded yet.</p>' +
        '<button class="btn btn-primary btn-block" onclick="App.openNewExpense()">＋ Record your first expense</button>';
      return;
    }
    el.className = '';
    el.innerHTML = recent.map((e) => {
      const del = session.role === 'proprietor'
        ? ' <button class="btn btn-small btn-ghost" onclick="App.deleteRecord(\'expense\',\'' + e.id + '\')">Delete</button>' : '';
      return '<div class="row-item"><div class="main"><div class="title">' + esc(e.category) +
        (e.note ? ' — ' + esc(e.note) : '') + '</div><div class="sub">' + fmtDate(e.ts) +
        ' · by ' + esc(e.userName) + '</div></div><div class="val out">' + money(e.amount) + '</div>' + del + '</div>';
    }).join('');
  }

  /* ---------- stock ---------- */
  $('btn-new-stock').addEventListener('click', () => {
    $('stock-modal-title').textContent = 'Add Stock Item';
    $('stock-name').value = '';
    $('stock-qty').value = '1';
    $('stock-low').value = '5';
    $('stock-name').disabled = false;
    openModal('modal-stock');
  });

  $('btn-save-stock').addEventListener('click', () => {
    const name = $('stock-name').value.trim();
    const qty = parseInt($('stock-qty').value, 10);
    const low = parseInt($('stock-low').value, 10);
    if (!name) return toast('Enter the item name.');
    if (isNaN(qty)) return toast('Enter how many you have.');
    const existing = data.stock.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.qty += qty;
      if (!isNaN(low)) existing.reorder = low;
      existing.updatedAt = Date.now();
    } else {
      data.stock.push({ id: DB.uid(), name, qty: Math.max(0, qty), reorder: isNaN(low) ? 5 : low, updatedAt: Date.now() });
    }
    persist();
    closeModal('modal-stock');
    toast('Stock saved ✓ ' + name);
    refreshAll();
  });

  function renderStock() {
    const el = $('stock-list');
    if (!data.stock.length) {
      el.className = '';
      el.innerHTML = '<p class="muted">No stock items yet.</p>' +
        '<button class="btn btn-primary btn-block" onclick="App.openNewStock()">📦 Add your first stock item</button>';
      return;
    }
    el.className = '';
    el.innerHTML = data.stock.map((s) => {
      const low = s.qty <= reorderOf(s);
      const badge = low ? '<span class="badge low">Low!</span>' : '';
      const del = session.role === 'proprietor'
        ? ' <button class="btn btn-small btn-ghost" onclick="App.deleteStock(\'' + s.id + '\')">Remove</button>' : '';
      return '<div class="row-item stock-row' + (low ? ' low' : '') + '" onclick="App.openAdjust(\'' + s.id + '\')">'+
        '<div class="main"><div class="title">' + esc(s.name) + ' ' + badge + '</div>' +
        '<div class="sub">Reorder: ' + reorderOf(s) + ' · tap to add / use stock</div></div>' +
        '<div class="val">' + s.qty + ' left</div>' + del + '</div>';
    }).join('');
  }

  window.App.openAdjust = function (id) {
    adjustStockId = id;
    const s = data.stock.find((x) => x.id === id);
    if (!s) return;
    $('adj-title').textContent = s.name;
    $('adj-current').textContent = 'Currently ' + s.qty + ' in stock';
    $('adj-qty').value = '1';
    $('adj-reorder').value = reorderOf(s);
    openModal('modal-stock-adjust');
  };

  $('btn-stock-in').addEventListener('click', () => saveAdjust(1));
  $('btn-stock-out').addEventListener('click', () => saveAdjust(-1));

  function saveAdjust(dir) {
    const s = data.stock.find((x) => x.id === adjustStockId);
    const q = parseInt($('adj-qty').value, 10);
    const r = parseInt($('adj-reorder').value, 10);
    if (!s || !q || q < 1) return toast('Enter how many.');
    s.qty = Math.max(0, s.qty + dir * q);
    if (!isNaN(r)) s.reorder = r;
    s.updatedAt = Date.now();
    persist();
    closeModal('modal-stock-adjust');
    toast('Stock updated ✓ ' + s.name + ': ' + s.qty + ' left');
    refreshAll();
  }

  App.deleteStock = function (id) {
    const s = data.stock.find((x) => x.id === id);
    if (!s) return;
    askConfirm('Remove ' + s.name + '?', 'This removes it from the stock list only. Sales history is not affected.', () => {
      data.stock = data.stock.filter((x) => x.id !== id);
      persist();
      toast('Removed ' + s.name, { undo: () => { data.stock.push(s); persist(); refreshAll(); } });
      refreshAll();
    });
  };

  /* ---------- attendance (P by default on work days; only A is recorded) ---------- */
  function toISO(d) {
    return todayStr(d);
  }
  function todayStr(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  function isWorkDay(d) {
    const days = (data.settings.workDays && data.settings.workDays.length === 7)
      ? data.settings.workDays : [1, 1, 1, 1, 1, 0, 0];
    return days[(d || new Date()).getDay() === 0 ? 6 : (d || new Date()).getDay() - 1] === 1;
  }

  function absentIdsFor(dateStr) {
    const s = new Set();
    data.attendance.forEach((a) => { if (a.date === dateStr) s.add(a.userId); });
    return s;
  }

  function attendanceToday() {
    const dateStr = todayStr();
    const absent = absentIdsFor(dateStr);
    const staff = data.users.filter((u) => u.active !== false);
    const a = staff.filter((u) => absent.has(u.id)).length;
    return { present: staff.length - a, absent, total: staff.length };
  }

  function renderAttendance() {
    const dateStr = todayStr();
    const now = new Date();
    $('att-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const wh = data.settings.workHours || { start: '08:00', end: '17:00' };
    $('att-hours').textContent = (wh.start || '—') + ' – ' + (wh.end || '—');
    const workToday = isWorkDay(now);
    const staff = data.users.filter((u) => u.active !== false);
    const absent = absentIdsFor(dateStr);
    $('att-present').textContent = workToday ? String(staff.length - absent.size) : '—';
    $('att-absent').textContent = workToday ? String(absent.size) : '—';
    $('att-note').innerHTML = workToday
      ? 'Everyone is <strong>Present (P)</strong> by default on work days. Tap a person only if they are <strong>Absent (A)</strong> — tap again to bring them back to Present.'
      : '🌴 Today is <strong>not a work day</strong> (see Settings → Work Days). Attendance is not counted today.';
    const el = $('att-list');
    if (!staff.length) {
      el.className = 'rows-empty';
      el.textContent = 'No active staff yet. Add people in Settings → Users.';
      return;
    }
    el.className = '';
    el.innerHTML = staff.map((u) => {
      const isA = absent.has(u.id);
      return '<div class="row-item att-row' + (isA ? ' absent' : '') + '" onclick="App.toggleAbsent(\'' + u.id + '\')">'+
        '<div class="main"><div class="title">' + esc(u.name) +
        (u.role === 'proprietor' ? ' <span class="role-tag proprietor">Proprietor</span>' : '') + '</div>' +
        '<div class="sub">' + (isA ? 'marked absent today' : 'present by default') + '</div></div>' +
        '<div class="val ' + (isA ? 'out' : 'in') + '">' + (isA ? 'A ✗' : 'P ✓') + '</div></div>';
    }).join('');
  }

  window.App.toggleAbsent = function (userId) {
    if (!isWorkDay(new Date())) return toast('Today is not a work day — attendance is not counted.');
    const dateStr = todayStr();
    const u = data.users.find((x) => x.id === userId);
    const existing = data.attendance.find((a) => a.date === dateStr && a.userId === userId);
    if (existing) {
      data.attendance = data.attendance.filter((a) => a !== existing);
      toast((u ? u.name : 'Staff') + ' is back to Present ✓');
    } else {
      data.attendance.push({
        id: DB.uid(), userId, userName: u ? u.name : 'Staff',
        date: dateStr, ts: Date.now(), markedBy: session ? session.name : '',
      });
      toast((u ? u.name : 'Staff') + ' marked Absent (A) ✗');
    }
    persist();
    refreshAll();
  };

  /* ---------- quick sale: fastest way to record the day's sales ---------- */
  function renderQuickSale() {
    const el = $('quick-sale-list');
    const btn = $('btn-save-quick');
    if (!data.products.length) {
      el.className = 'rows-empty';
      el.textContent = 'Add products in Settings → Products to use Quick Sale.';
      $('quick-total').textContent = '—';
      btn.disabled = true;
      return;
    }
    el.className = '';
    el.innerHTML = data.products.map((p) => {
      const q = quickCart[p.id] || 0;
      return '<div class="row-item"><div class="main"><div class="title">' + esc(p.name) +
        '</div><div class="sub">' + money(p.price) + ' / ' + esc(p.unit || 'unit') + '</div></div>' +
        '<div class="qty-ctl">' +
        '<button class="btn btn-small btn-ghost" onclick="App.qtyDelta(\'' + p.id + '\',-1)">−</button>' +
        '<span class="qty-num' + (q > 0 ? ' on' : '') + '">' + q + '</span>' +
        '<button class="btn btn-small btn-primary" onclick="App.qtyDelta(\'' + p.id + '\',1)">＋</button>' +
        '</div></div>';
    }).join('');
    let total = 0, count = 0;
    data.products.forEach((p) => {
      const q = quickCart[p.id] || 0;
      total += q * p.price;
      count += q;
    });
    $('quick-total').textContent = count ? money(total) + ' (' + count + ' items)' : '—';
    btn.disabled = !count;
  }

  window.App.qtyDelta = function (productId, delta) {
    const q = (quickCart[productId] || 0) + delta;
    if (q <= 0) delete quickCart[productId];
    else quickCart[productId] = q;
    renderQuickSale();
  };

  $('btn-save-quick').addEventListener('click', () => {
    const lines = data.products
      .filter((p) => quickCart[p.id] > 0)
      .map((p) => ({ p, qty: quickCart[p.id], amount: Math.round(p.price * quickCart[p.id]) }));
    if (!lines.length) return;
    const now = Date.now();
    lines.forEach(({ p, qty, amount }) => {
      data.sales.push({
        id: DB.uid(), item: p.name, qty, amount, price: p.price, unit: p.unit || '',
        ts: now, userId: session.id, userName: session.name,
      });
      const st = data.stock.find((s) => s.name.toLowerCase() === p.name.toLowerCase());
      if (st) { st.qty = Math.max(0, st.qty - qty); st.updatedAt = now; }
    });
    Object.keys(quickCart).forEach((k) => delete quickCart[k]);
    persist();
    renderQuickSale();
    toast('⚡ Saved ' + lines.length + ' sale line' + (lines.length > 1 ? 's' : '') + ' ✓');
    refreshAll();
  });

  /* ---------- delete with undo (proprietor) ---------- */
  App.deleteRecord = function (kind, id) {
    const list = kind === 'sale' ? data.sales : data.expenses;
    const rec = list.find((r) => r.id === id);
    if (!rec) return;
    askConfirm('Delete this ' + (kind === 'sale' ? 'sale' : 'expense') + '?',
      (kind === 'sale' ? rec.item + ' — ' : rec.category + ' — ') + money(rec.amount),
      () => {
        if (kind === 'sale') data.sales = data.sales.filter((r) => r.id !== id);
        else data.expenses = data.expenses.filter((r) => r.id !== id);
        lastDeleted = { kind, record: rec };
        persist();
        toast('Deleted. ', {
          undo: () => {
            if (!lastDeleted) return;
            if (lastDeleted.kind === 'sale') data.sales.push(lastDeleted.record);
            else data.expenses.push(lastDeleted.record);
            lastDeleted = null;
            persist();
            refreshAll();
          },
        });
        refreshAll();
      });
  };

  /* ---------- budget (proprietor) ---------- */
  function renderBudgetPage() {
    const el = $('budget-list');
    el.innerHTML = '';
    data.settings.categories.forEach((c) => {
      const spent = sum(data.expenses.filter((e) => e.category === c && inPeriod(e.ts, 'month')), 'amount');
      const limit = (data.settings.budgets && data.settings.budgets[c]) || '';
      const div = document.createElement('div');
      div.className = 'budget-item';
      div.innerHTML =
        '<div class="row"><strong>' + esc(c) + '</strong><span class="muted">' + money(spent) + ' spent</span></div>' +
        '<label>Monthly limit</label>' +
        '<input type="tel" inputmode="numeric" data-cat="' + esc(c) + '" value="' + (limit || '') + '" placeholder="e.g. 200000">';
      el.appendChild(div);
    });
  }

  $('btn-save-budget').addEventListener('click', () => {
    data.settings.budgets = {};
    document.querySelectorAll('#budget-list input').forEach((inp) => {
      const v = parseFloat(inp.value);
      if (v > 0) data.settings.budgets[inp.dataset.cat] = v;
    });
    persist();
    toast('Budgets saved ✓');
    renderBudgetSummary();
  });

  function renderBudgetSummary() {
    const el = $('budget-summary');
    if (!el) return;
    if (!data.settings.budgets || !Object.keys(data.settings.budgets).length) {
      el.innerHTML = '<p class="muted">No budgets set yet. Proprietor can set them under More → Budget Setup.</p>';
      return;
    }
    el.innerHTML = Object.entries(data.settings.budgets).map(([cat, limit]) => {
      const spent = sum(data.expenses.filter((e) => e.category === cat && inPeriod(e.ts, 'month')), 'amount');
      const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
      let msg = '';
      if (pct >= 100) msg = '<div class="budget-msg over">You have used ' + pct + '% of your ' + esc(cat) + ' budget — over the limit!</div>';
      else if (pct >= 80) msg = '<div class="budget-msg warn">You have used ' + pct + '% of your ' + esc(cat) + ' budget.</div>';
      return '<div class="budget-item"><div class="row"><span>' + esc(cat) + '</span><span class="muted">' +
        money(spent) + ' / ' + money(limit) + '</span></div>' +
        '<div class="progress"><div class="' + cls + '" style="width:' + Math.min(100, pct) + '%"></div></div>' + msg + '</div>';
    }).join('');
  }

  /* ---------- reports (proprietor) ---------- */
  function renderReport() {
    const showSales = reportType === 'all' || reportType === 'sales';
    const showAccount = reportType === 'all' || reportType === 'account';
    const showStock = reportType === 'all' || reportType === 'stock';
    const showAtt = reportType === 'all' || reportType === 'attendance';
    const typeName = { all: 'Full', sales: 'Sales', account: 'Account', stock: 'Stock', attendance: 'Attendance' }[reportType];
    const sales = filteredSales(reportPeriod);
    const exps = filteredExpenses(reportPeriod);
    const tin = sum(sales, 'amount'), tout = sum(exps, 'amount');
    const periodName = { today: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }[reportPeriod];
    const att = attendanceInPeriod(reportPeriod);
    const staffCount = data.users.filter((u) => u.active).length;
    const { rank: bestRank } = sellerStats(sales);
    const bestArr = bestRank.slice(0, 5);

    const rows = (arr, mapper) => arr.length ? arr.map(mapper).join('') : '<p class="muted">None in this period.</p>';
    let html =
      '<h3>' + esc(data.settings.businessName) + ' — ' + periodName + ' (' + typeName + ')</h3>' +
      '<p class="muted">Generated ' + new Date().toLocaleString() + '</p>';
    if (showSales) {
      html += '<div class="r-section">Sales (' + sales.length + ')</div>' +
        rows(sales, (s) => '<div class="row-item"><div class="main"><div class="title">' + esc(s.item) +
          (s.qty > 1 ? ' × ' + s.qty : '') + '</div><div class="sub">' + fmtDate(s.ts) + ' · by ' + esc(s.userName) +
          '</div></div><div class="val in">' + money(s.amount) + '</div></div>');
      if (bestArr.length) {
        html += '<div class="r-section">Best Sellers (' + (sellersMode === 'money' ? 'by money' : 'by quantity') + ')</div>' +
          bestArr.map(([i, q, a], ix) => '<div class="row-item"><div class="main">' + (ix + 1) + '. ' + esc(i) +
            '</div><div class="val">' + (sellersMode === 'money' ? money(a) : q + ' sold') + '</div></div>').join('');
      }
    }
    if (showAccount) {
      html += '<div class="r-section">Account</div>' +
        '<div class="row-item"><div class="main">Money In (Income)</div><div class="val in">' + money(tin) + '</div></div>' +
        '<div class="row-item"><div class="main">Money Out (Expenses)</div><div class="val out">' + money(tout) + '</div></div>' +
        '<div class="row-item"><div class="main"><strong>Balance (In − Out)</strong></div><div class="val"><strong>' +
        money(tin - tout) + '</strong></div></div>' +
        '<div class="r-section">Expense Details (' + exps.length + ')</div>' +
        rows(exps, (e) => '<div class="row-item"><div class="main"><div class="title">' + esc(e.category) +
          (e.note ? ' — ' + esc(e.note) : '') + '</div><div class="sub">' + fmtDate(e.ts) + ' · by ' + esc(e.userName) +
          '</div></div><div class="val out">' + money(e.amount) + '</div></div>');
    }
    if (showStock) {
      html += '<div class="r-section">Stock Status</div>' +
        rows(data.stock, (s) => '<div class="row-item"><div class="main"><div class="title">' + esc(s.name) +
          (s.qty <= reorderOf(s) ? ' <span class="badge low">Low!</span>' : '') +
          '</div></div><div class="val">' + s.qty + ' left</div></div>');
    }
    if (showAtt) {
      const dates = Object.keys(att.days).sort();
      html += '<div class="r-section">Attendance (' + att.marks + ' absence mark' + (att.marks === 1 ? '' : 's') +
        ' on ' + dates.length + ' work day' + (dates.length === 1 ? '' : 's') + ')</div>' +
        rows(dates, (d) => {
          const names = att.days[d].map((a) => esc(a.userName)).join(', ');
          const total = att.days[d].length;
          return '<div class="row-item"><div class="main"><div class="title">' + d + '</div><div class="sub">Absent: ' +
            names + '</div></div><div class="val out">' + total + ' A</div></div>';
        }) +
        (staffCount ? '<div class="row-item"><div class="main muted">Staff roster: ' + staffCount + ' active user' +
          (staffCount === 1 ? '' : 's') + '</div><div class="val"></div></div>' : '');
    }
    $('report-preview').innerHTML = html;
  }

  function attendanceInPeriod(period) {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (period === 'week') { start.setDate(start.getDate() - 6); }
    else if (period === 'month') { start.setDate(1); }
    else if (period === 'year') { start.setMonth(0, 1); }
    const days = {};
    data.attendance.forEach((a) => {
      const d = (a.date || '').slice(0, 10);
      if (d >= toISO(start) && d <= toISO(end)) {
        (days[d] = days[d] || []).push(a);
      }
    });
    return { days, marks: Object.values(days).reduce((n, arr) => n + arr.length, 0) };
  }

  document.querySelectorAll('#report-filter .chip').forEach((c) =>
    c.addEventListener('click', () => {
      reportPeriod = c.dataset.period;
      document.querySelectorAll('#report-filter .chip').forEach((x) =>
        x.classList.toggle('active', x === c));
      renderReport();
    }));

  document.querySelectorAll('#report-type-filter .chip').forEach((c) =>
    c.addEventListener('click', () => {
      reportType = c.dataset.rtype;
      document.querySelectorAll('#report-type-filter .chip').forEach((x) =>
        x.classList.toggle('active', x === c));
      renderReport();
    }));

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCsv() {
    const cur = data.settings.currency === 'CUSTOM' ? (data.settings.customCurrency || '') : data.settings.currency;
    const lines = [];
    const sales = filteredSales(reportPeriod);
    const exps = filteredExpenses(reportPeriod);
    const periodName = { today: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }[reportPeriod];
    const att = attendanceInPeriod(reportPeriod);
    const header = [data.settings.businessName + ' — ' + periodName + ' (' + reportType + ') — ' +
      new Date().toLocaleString() + ' — currency: ' + cur];
    const showSales = reportType === 'all' || reportType === 'sales';
    const showAccount = reportType === 'all' || reportType === 'account';
    const showStock = reportType === 'all' || reportType === 'stock';
    const showAtt = reportType === 'all' || reportType === 'attendance';
    if (showSales) {
      lines.push(header.slice());
      lines.push(['SALES']);
      lines.push(['Item', 'Qty', 'Amount', 'Date', 'By']);
      sales.forEach((s) => lines.push([s.item, s.qty || 1, s.amount, fmtDate(s.ts), s.userName]));
      lines.push(['TOTAL SALES', '', sum(sales, 'amount')]);
    }
    if (showAccount) {
      lines.push(header.slice());
      lines.push(['ACCOUNT']);
      lines.push(['Direction', 'Amount']);
      lines.push(['Money In', sum(sales, 'amount')]);
      lines.push(['Money Out', sum(exps, 'amount')]);
      lines.push(['Balance', sum(sales, 'amount') - sum(exps, 'amount')]);
      lines.push(['EXPENSES']);
      lines.push(['Category', 'Note', 'Amount', 'Date', 'By']);
      exps.forEach((e) => lines.push([e.category, e.note || '', e.amount, fmtDate(e.ts), e.userName]));
      lines.push(['TOTAL EXPENSES', '', '', sum(exps, 'amount')]);
    }
    if (showStock) {
      lines.push(header.slice());
      lines.push(['STOCK']);
      lines.push(['Item', 'Qty', 'Unit', 'Reorder Level', 'Low?']);
      data.stock.forEach((s) => lines.push([s.name, s.qty, s.unit || '', reorderOf(s),
        s.qty <= reorderOf(s) ? 'LOW' : '']));
    }
    if (showAtt) {
      const dates = Object.keys(att.days).sort();
      lines.push(header.slice());
      lines.push(['ATTENDANCE']);
      lines.push(['Date', 'Absent Staff', 'Absent Count']);
      dates.forEach((d) => lines.push([d, att.days[d].map((a) => a.userName).join('; '), att.days[d].length]));
      if (!dates.length) lines.push(['(no absence marks this period)', '', '']);
    }
    return '﻿' + lines.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  }

  $('btn-download-csv').addEventListener('click', () => {
    try {
      const blob = new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mystore-report-' + reportPeriod + '-' + reportType + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Report saved as spreadsheet (.csv) — opens in Excel / Google Sheets');
    } catch (err) {
      toast('Download failed: ' + err.message);
    }
  });

  $('btn-download-pdf').addEventListener('click', () => {
    try {
      if (!window.jspdf || !window.jspdf.jsPDF) {
        toast('PDF library not loaded yet (needs internet once). Using Print instead.');
        window.print();
        return;
      }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      const sales = filteredSales(reportPeriod);
      const exps = filteredExpenses(reportPeriod);
      const tin = sum(sales, 'amount'), tout = sum(exps, 'amount');
      const periodName = { today: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }[reportPeriod];
      const cur = data.settings.currency === 'CUSTOM' ? (data.settings.customCurrency || '') : data.settings.currency;
      let y = 15;
      doc.setFontSize(16);
      doc.text(data.settings.businessName, 14, y); y += 8;
      doc.setFontSize(12);
      doc.text(periodName + ' Report — generated ' + new Date().toLocaleString(), 14, y); y += 10;
      doc.setFontSize(13); doc.text('Sales', 14, y); y += 7; doc.setFontSize(10);
      sales.forEach((s) => {
        if (y > 280) { doc.addPage(); y = 15; }
        doc.text(s.item + (s.qty > 1 ? ' x' + s.qty : '') + '  —  ' + cur + ' ' + s.amount +
          '  (' + new Date(s.ts).toLocaleDateString() + ', by ' + s.userName + ')', 14, y); y += 6;
      });
      y += 4; doc.setFontSize(13); doc.text('Expenses', 14, y); y += 7; doc.setFontSize(10);
      exps.forEach((e) => {
        if (y > 280) { doc.addPage(); y = 15; }
        doc.text(e.category + (e.note ? ' — ' + e.note : '') + '  —  ' + cur + ' ' + e.amount +
          '  (by ' + e.userName + ')', 14, y); y += 6;
      });
      y += 4; doc.setFontSize(13); doc.text('Stock Status', 14, y); y += 7; doc.setFontSize(10);
      data.stock.forEach((s) => {
        if (y > 280) { doc.addPage(); y = 15; }
        doc.text(s.name + ': ' + s.qty + ' left', 14, y); y += 6;
      });
      y += 4; doc.setFontSize(12);
      doc.text('Money In: ' + cur + ' ' + Math.round(tin), 14, y); y += 7;
      doc.text('Money Spent: ' + cur + ' ' + Math.round(tout), 14, y); y += 7;
      doc.text('Profit: ' + cur + ' ' + Math.round(tin - tout), 14, y);
      doc.save('report-' + reportPeriod + '.pdf');
      toast('PDF downloaded ✓');
    } catch (err) {
      console.error(err);
      toast('PDF failed. Using Print instead.');
      window.print();
    }
  });

  /* ---------- paper templates (offline backup sheets, PDF) ---------- */
  function tplDoc(title, subtitle) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 15;
    doc.setFontSize(16);
    doc.text(String(data.settings.businessName || 'MyStore'), 14, y); y += 7;
    doc.setFontSize(13);
    doc.text(title, 14, y); y += 6;
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(subtitle, 14, y); y += 4;
    doc.setTextColor(0);
    return { doc, y: y + 3 };
  }

  // Draw a blank table. cols: [{label, w}] widths sum to ~182. rows: number of blank rows.
  function tplTable(doc, y, cols, rows) {
    const x0 = 14, totalW = 182, rowH = 8;
    const widths = cols.map((c) => c.w);
    const scale = totalW / widths.reduce((a, b) => a + b, 0);
    doc.setFontSize(8);
    // header
    doc.setFillColor(232, 245, 238);
    doc.rect(x0, y, totalW, rowH, 'F');
    doc.setFont('helvetica', 'bold');
    let x = x0;
    cols.forEach((c, i) => {
      doc.text(c.label, x + 1.5, y + 5.5);
      x += widths[i] * scale;
    });
    doc.setFont('helvetica', 'normal');
    // grid
    for (let r = 0; r <= rows; r++) {
      const ry = y + rowH * (r + 1);
      if (ry > 285) break;
      doc.line(x0, ry, x0 + totalW, ry);
    }
    // verticals
    let vx = x0;
    doc.line(x0, y, x0, y + rowH * (Math.min(rows, Math.floor((285 - y) / rowH) - 1) + 1));
    cols.forEach((c, i) => {
      vx += widths[i] * scale;
      const endY = y + rowH * (Math.min(rows, Math.floor((285 - y) / rowH) - 1) + 1);
      doc.line(vx, y, vx, endY);
    });
    return y + rowH * (Math.min(rows, Math.floor((285 - y) / rowH) - 1) + 2);
  }

  function cur() {
    return data.settings.currency === 'CUSTOM' ? (data.settings.customCurrency || '') : data.settings.currency;
  }

  function needPdf() {
    if (window.jspdf && window.jspdf.jsPDF) return true;
    toast('PDF tool not loaded yet — connect to the internet once, then try again.');
    return false;
  }

  $('btn-tpl-sales').addEventListener('click', () => {
    if (!needPdf()) return;
    try {
      const t = tplDoc('DAILY SALES SHEET', 'Write one line per sale. Amount = Price × Qty. Total the Amount column at day end.');
      const cols = [{ label: 'Date', w: 22 }, { label: 'Item', w: 45 }, { label: 'Qty', w: 15 },
        { label: 'Unit', w: 20 }, { label: 'Price (' + cur() + ')', w: 25 }, { label: 'Amount', w: 30 },
        { label: 'Sold by', w: 25 }];
      let y = t.y;
      const rowsPerPage = 26;
      for (let p = 0; p < 2; p++) {
        y = tplTable(t.doc, y, cols, rowsPerPage);
        t.doc.setFontSize(9); t.doc.setFont('helvetica', 'bold');
        t.doc.text('DAY TOTAL: ' + cur() + ' ______________________', 14, y + 2);
        t.doc.setFont('helvetica', 'normal');
        if (p === 0) { t.doc.addPage(); y = 15; }
      }
      t.doc.save('template-sales.pdf');
      toast('Sales template downloaded ✓');
    } catch (err) { console.error(err); toast('PDF failed: ' + err.message); }
  });

  $('btn-tpl-account').addEventListener('click', () => {
    if (!needPdf()) return;
    try {
      const t = tplDoc('DAILY ACCOUNT SHEET', 'Write amounts in and out. Total each column at day end.');
      const cols = [{ label: 'Date', w: 22 }, { label: 'Description', w: 80 }, { label: 'Money In', w: 30 },
        { label: 'Money Out', w: 30 }];
      let y = t.y;
      const rowsPerPage = 26;
      for (let p = 0; p < 2; p++) {
        y = tplTable(t.doc, y, cols, rowsPerPage);
        t.doc.setFontSize(9); t.doc.setFont('helvetica', 'bold');
        t.doc.text('TOTALS: ' + cur() + ' __________ In    ' + cur() + ' __________ Out', 14, y + 2);
        t.doc.setFont('helvetica', 'normal');
        if (p === 0) { t.doc.addPage(); y = 15; }
      }
      t.doc.save('template-account.pdf');
      toast('Account template downloaded ✓');
    } catch (err) { console.error(err); toast('PDF failed: ' + err.message); }
  });

  $('btn-tpl-stock').addEventListener('click', () => {
    if (!needPdf()) return;
    try {
      const t = tplDoc('STOCK SHEET', 'Write the item name and quantity. Total at day end.');
      const cols = [{ label: 'Item', w: 80 }, { label: 'Qty Start', w: 30 }, { label: 'Qty Added', w: 30 },
        { label: 'Qty Used', w: 30 }];
      let y = t.y;
      const rowsPerPage = 26;
      for (let p = 0; p < 2; p++) {
        y = tplTable(t.doc, y, cols, rowsPerPage);
        if (p === 0) { t.doc.addPage(); y = 15; }
      }
      t.doc.save('template-stock.pdf');
      toast('Stock template downloaded ✓');
    } catch (err) { console.error(err); toast('PDF failed: ' + err.message); }
  });

  /* ---------- settings & users ---------- */
  function renderSettings() {
    $('settings-business').value = data.settings.businessName || '';
    $('settings-currency').value = data.settings.currency || 'INR';
    $('settings-custom-cur').value = data.settings.customCurrency || '';
    $('settings-custom-cur').classList.toggle('hidden', data.settings.currency !== 'CUSTOM');
    renderCategoryList();
    renderUsersList();
    renderWorkDaysSettings();
    renderWorkHoursSettings();
  }

  $('settings-currency').addEventListener('change', () => {
    data.settings.currency = $('settings-currency').value;
    $('settings-custom-cur').classList.toggle('hidden', data.settings.currency !== 'CUSTOM');
  });
  $('settings-custom-cur').addEventListener('input', () => {
    data.settings.customCurrency = $('settings-custom-cur').value;
  });

  $('btn-save-settings').addEventListener('click', () => {
    data.settings.businessName = $('settings-business').value.trim() || 'MyStore';
    persist();
    $('hdr-business').textContent = data.settings.businessName;
    toast('Settings saved ✓');
    renderDashboard();
  });

  /* categories */
  function renderCategoryList() {
    const el = $('category-list');
    if (!data.settings.categories.length) {
      el.innerHTML = '<p class="muted">No categories yet.</p>';
      return;
    }
    el.innerHTML = data.settings.categories.map((c) =>
      '<div class="row-item"><div class="main">' + esc(c) +
      '</div><button class="btn btn-small btn-ghost" onclick="App.deleteCategory(\'' + esc(c.replace(/'/g, '\\'')) +
      '\')">Remove</button></div>').join('');
  }
  $('btn-add-category').addEventListener('click', () => {
    const c = $('new-category').value.trim();
    if (!c) return toast('Enter a category name.');
    if (data.settings.categories.includes(c)) return toast('Already added.');
    data.settings.categories.push(c);
    $('new-category').value = '';
    persist();
    renderCategoryList();
  });
  App.deleteCategory = function (cat) {
    data.settings.categories = data.settings.categories.filter((c) => c !== cat);
    persist();
    renderCategoryList();
  };

  /* users */
  function renderUsersList() {
    const el = $('users-list');
    el.innerHTML = '';
    data.users.forEach((u) => {
      const isMe = u.id === (session ? session.id : null);
      const div = document.createElement('div');
      div.className = 'user-card' + (u.active === false ? ' inactive' : '');
      div.innerHTML = '<div class="user-header"><strong>' + esc(u.name) +
        (u.role === 'proprietor' ? ' <span class="role-tag proprietor">Proprietor</span>' : ' <span class="role-tag">Sales</span>') +
        '</strong>' + (isMe ? ' <span class="muted">(you)</span>' : '') + '</div>' +
        '<div class="row"><label>PIN</label><input type="text" value="' + (u.pin || '') +
        '" placeholder="e.g. 1234" ' + (u.role === 'proprietor' ? 'readonly' : '') + '>' +
        (u.role === 'proprietor' ? '' : '<button class="btn btn-small btn-ghost" onclick="App.savePin(\'' + u.id + '\',this)">Save PIN</button>') +
        '</div>' + (u.role === 'proprietor' ? '' : '<div class="row"><label>Can access dashboard?</label><input type="checkbox" ' +
        (u.dash !== false ? 'checked' : '') + ' onchange="App.setDashAccess(\'' + u.id + '\',this.checked)"></div>') +
        '<div class="row">' +
        (u.active === false
          ? '<button class="btn btn-small" onclick="App.toggleUserActive(\'' + u.id + '\',true)">Re-activate</button>'
          : '<button class="btn btn-small btn-ghost" onclick="App.toggleUserActive(\'' + u.id + '\',false)">Deactivate</button>') +
        '</div>';
      el.appendChild(div);
    });
  }
  $('btn-add-user').addEventListener('click', () => {
    const name = $('new-user-name').value.trim();
    if (!name) return toast('Enter a name.');
    const existing = data.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (existing) return toast('User already exists.');
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    data.users.push({ id: DB.uid(), name, pin, role: 'employee', active: true, dash: true });
    $('new-user-name').value = '';
    persist();
    renderUsersList();
    toast('User added: ' + name + ' · PIN: ' + pin + ' (can be changed in their profile)');
  });
  App.savePin = function (userId, btn) {
    const u = data.users.find((x) => x.id === userId);
    if (!u) return;
    const inputs = document.querySelectorAll('.user-card');
    let inp = null;
    inputs.forEach((card) => {
      if (card.querySelector('button') === btn) inp = card.querySelector('input[type="text"]');
    });
    if (!inp) return;
    const pin = inp.value.trim();
    if (!/^\d{4}$/.test(pin)) return toast('PIN must be exactly 4 digits.');
    u.pin = pin;
    persist();
    toast('PIN saved for ' + u.name + ' ✓');
  };
  App.setDashAccess = function (userId, allowed) {
    const u = data.users.find((x) => x.id === userId);
    if (!u) return;
    u.dash = allowed ? true : false;
    persist();
    if (session && session.id === userId) { applyPermissions(); }
  };
  App.toggleUserActive = function (userId, activate) {
    const u = data.users.find((x) => x.id === userId);
    if (!u) return;
    askConfirm(activate ? 'Re-activate ' + u.name + '?' : 'Deactivate ' + u.name + '?',
      activate ? 'They can log in again.' : 'They cannot log in. Sales history is kept.',
      () => {
        u.active = activate ? true : false;
        persist();
        renderUsersList();
        toast((activate ? 'Reactivated' : 'Deactivated') + ': ' + u.name);
      });
  };

  /* work days & hours */
  function renderWorkDaysSettings() {
    const days = data.settings.workDays || [1, 1, 1, 1, 1, 0, 0];
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const el = $('work-days-list');
    el.innerHTML = names.map((n, i) =>
      '<label><input type="checkbox" ' + (days[i] ? 'checked' : '') +
      ' onchange="App.setWorkDay(' + i + ',this.checked)"> ' + n + '</label>').join('');
  }
  App.setWorkDay = function (dayIdx, isWork) {
    data.settings.workDays = data.settings.workDays || [1, 1, 1, 1, 1, 0, 0];
    data.settings.workDays[dayIdx] = isWork ? 1 : 0;
    persist();
  };

  function renderWorkHoursSettings() {
    const wh = data.settings.workHours || { start: '08:00', end: '17:00' };
    $('work-start-time').value = wh.start || '08:00';
    $('work-end-time').value = wh.end || '17:00';
  }
  $('btn-save-work-hours').addEventListener('click', () => {
    data.settings.workHours = {
      start: $('work-start-time').value || '08:00',
      end: $('work-end-time').value || '17:00',
    };
    persist();
    toast('Work hours saved ✓');
  });

  /* tutorial */
  let tutIdx = 0;
  const tutSteps = [
    { title: 'Welcome', text: 'MyStore helps you keep track of sales, expenses, stock, and staff attendance.' },
    { title: 'Quick Sale', text: 'Add products in Settings, then tap «Quick Sale» to record sales in seconds.' },
    { title: 'Dashboard', text: 'See your daily totals, best sellers, and low stock items at a glance.' },
    { title: 'Reports', text: 'Download a full report as CSV or PDF at the end of the day or month.' },
  ];
  function renderTutorial() {
    const step = tutSteps[tutIdx % tutSteps.length];
    $('tut-title').textContent = step.title;
    $('tut-text').textContent = step.text;
    $('tut-dots').innerHTML = tutSteps.map((_, i) =>
      '<span class="dot' + (i === tutIdx % tutSteps.length ? ' active' : '') + '"></span>').join('');
  }
  $('btn-tut-next').addEventListener('click', () => {
    tutIdx = (tutIdx + 1) % tutSteps.length;
    renderTutorial();
  });
  $('btn-tut-back').addEventListener('click', () => {
    tutIdx = (tutIdx - 1 + tutSteps.length) % tutSteps.length;
    renderTutorial();
  });
  $('btn-tut-close').addEventListener('click', () => closeModal('modal-tutorial'));

  /* refresh: called after mutations */
  function refreshAll() {
    renderDashboard();
    renderSalesList();
    renderExpensesList();
    renderStock();
    renderAttendance();
    renderQuickSale();
    renderSettings();
    renderBudgetSummary();
    renderAccountBalance();
  }

  /* init */
  buildPinPad();
  setupPinRow('setup-pin-dots');
  setupPinRow('setup-pin2-dots');
  watchPinInputs('setup-pin', 'setup-pin2');
  renderLogin();
  if (!session) {
    $('screen-login').classList.add('active');
  }
})();
