# Shop Records — Architecture & Gap Notes

> The app is named **MyStore** in the UI (manifest, title, defaults). This document still
> refers to the folder name `shop-records-pwa` — same app.

## Architecture

```
shop-records-pwa/
├── index.html          # Single-page app shell: login + all screens + modals
├── css/style.css       # Mobile-first styles, big touch targets, safe-area aware
├── js/db.js            # Data layer: localStorage load/save/migrate (key shop_records_v1)
├── js/sync.js          # Offline-first Firebase sync: merge-by-id, auto-sync on reconnect
├── js/drive.js         # Google Drive backup/restore via OAuth (owner one-tap save/load)
├── js/app.js           # All logic: auth, permissions, sales, expenses, stock,
│                       # budget, dashboard + canvas chart, reports, PDF, settings
├── manifest.json       # PWA manifest (installable, standalone, portrait)
├── sw.js               # Service worker: cache-first offline for all assets
├── icons/              # Generated app icons (192, 512, 512-maskable)
└── docs/               # SETUP.md + SHOP-GUIDE.md + ARCHITECTURE.md +
                        # FIREBASE-SETUP.md + GDRIVE-SETUP.md
```

**Stack:** vanilla HTML/CSS/JS. No build step, no frameworks, no server code.
**Storage:** browser `localStorage` (single JSON document, versioned key `shop_records_v1`).
**Offline-first sync:** `js/sync.js` — localStorage is always the source of truth; Firebase
Realtime Database (free tier) is the merge point. Sync triggers: `online` event,
visibility change, and 15 s debounce after local writes. Records merge **by id** (union),
stock resolves per-item by `updatedAt`, settings/scalars go to the newer document.
A 25 s timeout guards against unreachable/badly-configured databases.
**Offline:** service worker caches every asset on first visit; jsPDF + Firebase SDK are
cached from CDN on first online visit, so PDF export and sync keep working afterwards.
**Charts:** hand-drawn canvas bar chart (no chart library — keeps the app light on low-end phones).

## Data model

```jsonc
{
  "users":     [{ "id", "name", "pin", "role": "owner|employee", "active", "dash" }],
  // "dash": false hides the Dashboard + Summary from that employee (owner-set, default on)
  "settings":  { "businessName", "currency", "customCurrency",
                 "categories": [], "units": [],          // units of measurement, editable
                 "store": { "name", "contact", "phone", "email", "website" },
                 "workDays": [1,1,1,1,1,0,0],            // Mon..Sun — 1 = work day
                 "workHours": { "start": "08:00", "end": "17:00" },
                 "budgets": { "category": limit }, "appLock" },
  "products":  [{ "id", "name", "price", "unit" }],
  "sales":     [{ "id", "item", "qty", "amount", "price", "unit", "ts", "userId", "userName" }],
  "expenses":  [{ "id", "amount", "note", "category", "ts", "userId", "userName" }],
  "stock":     [{ "id", "name", "qty", "reorder", "updatedAt" }],
  "attendance": [{ "id", "userId", "userName", "date": "YYYY-MM-DD", "ts", "markedBy" }]
  // attendance stores ONLY absent marks; P (present) is the implicit default on work days
}
```

`db.js` migrates older data on load: stock field `low` → `reorder`, missing `units` /
`store` / `products` get defaults. `store.name` and `settings.businessName` are kept in
sync (store name is required and doubles as the header/report name).

## Login & permission design

- **First launch** → store setup: **store / business name is required** (it becomes the
  header and report name, renamable anytime in Settings → Store Details); owner name is
  optional (defaults to **Milly**); 4-digit PIN entered twice.
- **Login** → pick name from a **dropdown** → 4-digit PIN on a numeric pad. Fast login:
  the last successful user is remembered, so reopening the app jumps straight to their
  PIN pad (a Back button returns to the dropdown).
- **Roles:** `owner` (everything) / `employee` ("Sales").
- **Hide, don't lock:** employee UI never renders owner-only elements
  (`.owner-only` sections are removed from the DOM path via `hidden` before display).
- **Employee limits:** employees get **Dashboard (owner can toggle per person), Sales,
  Account, Stock and Staff (attendance)** plus Summary/Tutorial — no Settings, reports,
  budget, paper templates, delete buttons, or "By Person" card.
- Every sale/expense stores `userName` — "by Amina" attribution everywhere.

## Screen list

| # | Screen | Access | Notes |
|---|--------|--------|-------|
| 1 | Login (dropdown + PIN) | all | name dropdown → PIN pad, 4 digits, auto-submit; fast login jumps to last user's PIN |
| 2 | First-launch store setup | none (one time) | **store name required**, owner name optional (default Milly), PIN ×2; creates default **Sales Person 1** (PIN 1234) |
| 3 | Dashboard | all (owner can toggle per employee) | period chips (Today/Week/Month/Year) + view chips (All / Sales / Account / Stock / Attendance), **📋 Summary button**, stat cards + **6 KPI tiles incl. staff P/A**, Summary card with Share, Stock Overview, **Top & Slowest Sellers**, chart, best sellers, by person (owner) |
| 4 | Sales | all | **Quick Sale card** (−/+ steppers per product, running total, one-tap "Save All" → one sale record per line, stock auto-deducts) + custom sale modal (product picker autofills price/unit), recent list, delete (owner) |
| 5 | Account | all | monthly Money In / Out / Balance card, + New Expense, recent list, budget bars (owner) |
| 6 | Stock | all | reorder-level badges (Low!), tap row → Stock In / Used + edit reorder level |
| 7 | **Staff (attendance)** | all | today-only: everyone **P by default** on work days; tap a person to mark **A** (tap again to restore P); work-day/hours note; non-work days show 🌴 and are not counted |
| 8 | More | all | Tutorial + Summary (owner: also Budget / Reports / Paper Templates / Settings) |
| 9 | Budget | owner | monthly limit per category, progress bars |
| 10 | Reports & PDF | owner | period + **report-type filter** (All/Sales/Account/Stock/Attendance), on-screen preview, **PDF and Spreadsheet (CSV) download** |
| 11 | Settings & Users | owner | business, **Store Details** (name required), **Work Days & Hours** (Mon–Sun ticks + start/end time), **Products** (price + unit CRUD), **Units of Measurement** (CRUD + restore defaults), categories (+ restore), app lock, users (+ **per-user Dashboard on/off**), Drive backup, cloud sync, backup/restore |
| 12 | Paper Templates | owner | blank PDF sheets for Sales, Account, Stock, Attendance (attendance pre-filled with staff names + work days) — the offline paper backup plan |

Plus: a **sync status pill** in the header (all screens) — grey = not set up,
orange = offline, flashing amber = syncing, green = synced, red = failed (auto-retries).

## Gaps in the original spec — how they were filled

1. **"React Native + Expo, APK"** → built as a **PWA** (user chose PWA). Install = "Add to
   Home Screen". No Node/Expo needed. Native APK can be added later via Capacitor/TWA if wanted.
2. **"SQLite"** → `localStorage`. Same offline guarantee; trade-off: browser data can be
   wiped if the user clears site data — mitigated by the JSON backup/restore feature
   (Settings → Download Backup), which the spec also asked for.
3. **"Wait for approval before building"** → user asked for a finished, tryable app, so the
   full build was delivered; this document serves as the architecture/screen-list deliverable.
4. **"Backup/restore"** → implemented as JSON export/import (the only sane offline option).
5. **Low-stock threshold undefined** → per-item threshold, default 5, editable when adding stock.
6. **"Week" undefined** → Monday-start weeks (East African business convention).
7. **PDF offline conflict** → jsPDF from CDN, cached by the service worker after the first
   online visit; graceful fallback to browser Print if unavailable.
8. **App PIN lock** → implemented as an optional pre-login PIN gate (Settings → App PIN Lock).
9. **Undo on accidental delete** → all deletes (records, stock) show a toast with **Undo**.
10. **"Works offline, syncs when network is restored"** (added after first delivery) →
    implemented as offline-first sync: localStorage is always the source of truth; a free
    Firebase Realtime Database is the cloud merge point. Sync fires on the `online` event,
    on app foreground, and 15 s after local changes; conflicts merge by record id. One-time
    owner setup (docs/FIREBASE-SETUP.md); until configured the app works offline as before.
11. **"Default PIN 1234 for all, owner can reset / add / remove / rename / change access"**
    (added after first delivery) → new users get PIN **1234** by default (field left blank);
    Settings → Users now supports **Rename** (past records follow the new name),
    **Make Owner / Make Sales** (guarded: no self-change, shop always keeps ≥1 owner),
    **Reset PIN**, **Deactivate/Reactivate**, and **Remove** (history is kept).
12. **"Buttons to save/load records on Google Drive with owner's Google account"**
    (added after first delivery) → Settings → Google Drive Backup: one-tap save/load of
    `shop-records-backup.json` via Google sign-in (OAuth). One-time Client ID setup:
    docs/GDRIVE-SETUP.md.
13. **"Rename the app MyStore; default owner Milly; default sales person Sales Person 1"**
    (added after first delivery) → manifest/title/default business name = **MyStore**;
    setup screen pre-fills **Milly** (owner's chosen spelling); first launch auto-creates
    **Sales Person 1** (PIN 1234, renameable/deletable like any user).
14. **"Store details (name required), products with price + units of measurement, restore
    defaults, tutorial button, dashboard KPIs, Sales/Account/Stock tabs, stock auto-deduct,
    editable reorder level"** (added after first delivery) → Settings → Store Details card
    (name required — empty input is rejected and reverted); Settings → Products (add /
    edit / remove with price + unit; renaming a product follows into matching stock so
    auto-deduct keeps working); Settings → Units (13 defaults like kg, sachet, tin, box,
    bag (25kg)… add / remove / restore); Restore Default Categories button; in-app
    **Tutorial** (8-step walkthrough, "?" header button + More page); Dashboard KPI tiles
    (sales count, expense count, stock items, low-stock count); Account tab with monthly
    balance card; sale modal picks products with auto-filled price/unit and computed total;
    every stock item has an editable **reorder level** with "Low!" badges + dashboard count.
15. **"Best UI/UX in similar apps, world-class but usable by less-educated people"**
    (research-informed) → plain words ("Money In / Money Out / Balance" instead of
    accounting terms), one primary action per screen, big touch targets, no scroll-gated
    content, snapshot KPI tiles up top, numeric pad PIN entry, and undo toasts instead of
    confirmation dialogs for reversible actions.
16. **"Dashboard: time filter (daily/weekly/monthly/yearly) + view filter (all / sales only /
    stock only) + summary of key records"** (added after first delivery) → the period chips
    (Today/Week/Month/Year) were extended with a second filter row — **All / Sales only /
    Stock only** — that shows and hides dashboard sections (`.dv-sales` / `.dv-exp` /
    `.dv-stock` classes). A **Summary card** lists key records for the selected period
    (sales count+total, expenses, balance, stock status with low items, best seller) with a
    **Share** button (Web Share API, clipboard fallback), plus a **Stock Overview** card on
    the dashboard (low items first).
17. ~~"Take a screenshot / upload a picture and the app picks the data"~~ →
    **requested, built (Tesseract.js OCR pre-fill), then removed at the owner's request**
    (14:37) — manual entry is the sole input method again; `js/ocr.js` deleted.
18. **"Logically add top-selling and worst-selling items; a summary button for sales,
    expenses, etc.; default owner Milly"** (added after first delivery) → Dashboard
    **"Top & Slowest Sellers"** card (top 3 + slowest 3 + items not sold at all), with a
    **📦 By quantity / 💵 By money** mini-filter — the same mode ranks the dashboard card,
    the summary's Top 3 Best/Worst tables, and the Reports "Best Sellers" section.
    **"📋 Summary"** button on the Dashboard and the More page opens a full summary sheet
    for the selected period in a **table format** (sectioned label/value tables):
    money (sales count+total, expenses, balance), **Top 3 Best Sellers** and
    **Top 3 Worst Sellers** by quantity sold, biggest expense category, stock status
    with low items, and staff today — with a Share button (Web Share API, clipboard
    fallback). First-launch owner name
    pre-fills as **Milly**.
19. **"Final polish before deployment: visual states, incremental Drive sync, clean URL
    slug"** (added after first delivery) →
    - *Busy feedback:* Drive Save/Load buttons show a spinner label ("⏳ Saving to Google
      Drive…"), disable themselves and lock each other while running, and always restore;
      explicit success/error toasts on completion.
    - *Incremental Drive sync:* save finds ALL files named `shop-records-backup.json`,
      updates the existing one in place, and deletes extra copies — consecutive clicks can
      never create duplicate files. Both save and load run `sanitizeData()` which drops
      rows with duplicate or missing `id`s, so repeated rows cannot appear in backups.
    - *Empty states:* a welcome card on the Dashboard when the shop has no data at all
      (CTA: record first sale / add first stock item / tutorial), and CTA buttons inside
      the empty sales, expenses and stock lists.
    - *Destructive actions:* all deletes/removals (records, stock, products, users) go
      through the red confirm dialog; reversible deletes offer Undo in the toast.
    - *Production slug:* the deployable copy lives in a cleanly named folder
      **`milly-store-tracker`** (`[clientname]-store-tracker`) ready to share with the
      client owner.
20. **"Account + Attendance tabs; P-by-default attendance with work days/hours; faster
    daily sales; report downloads by type as spreadsheet or PDF; per-user dashboard
    toggle"** (added after first delivery) →
    - *Attendance:* new **Staff** tab. Only **absent** marks are stored; every active user
      is Present by default on work days, so the daily routine is "tap only the absent".
      Work days (Mon–Sun ticks) and work hours are set in Settings; non-work days show a
      🌴 note, display "—" and reject marks. Dashboard gained Present/Absent KPI tiles and
      the daily summary gained a "Staff today" line. Reports gained an Attendance section
      (absence groups per date).
    - *Account:* the dashboard view filter renamed/extended to
      **All / Sales / Account / Stock / Attendance**; "Account" shows the money
      in/out/balance sections.
    - *Faster daily sales:* **Quick Sale** card on the Sales tab — −/+ steppers per product,
      live running total, one "Save All" writing one sale record per product line with stock
      auto-deducted (few seconds for a whole day's common items). Fast login: the app
      remembers the last user and opens directly on their PIN pad.
    - *Report downloads:* Reports page gained a **report-type filter** (All/Sales/Account/
      Stock/Attendance) that filters both the preview and the downloads, plus a
      **Download Spreadsheet (CSV)** button alongside PDF (BOM-prefixed, opens in Excel /
      Google Sheets).
    - *Per-user dashboard access:* Settings → Users has a **Dashboard On/Off** toggle per
      employee; when off the employee lands on Sales and the Dashboard nav button, summary
      button and summary card are hidden. Daily summary content stays available to all who
      can see it; the owner always has full access.
21. **"Registration requires store name only; downloadable paper templates as plan B"**
    (added after first delivery) →
    - *Registration:* the first-launch setup now requires **only the store / business
      name** (empty is rejected). The owner name is optional (defaults to Milly) and the
      salesperson name is optional (defaults to Sales Person 1). The store name can be
      renamed anytime in Settings → Store Details and drives the header and report names.
    - *Paper templates:* More → **Paper Templates** offers four blank PDF sheets — Daily
      Sales, Account/Cash Book (Money In + Money Out), Stock/Inventory, and Staff
      Attendance (pre-filled with staff names, work days, hours, and the P-default legend
      for the current month). They are the offline fallback: if the phone or app fails,
      write on paper and type the records into the app later.

## Known limits (by design)

- **One device only.** Multi-user is on one shared phone. Separate phones per employee
  requires cloud sync — a different architecture (say the word and it can be scoped).
- **Custom date-range reports** not in the spec's filter list (Today/Week/Month/Year implemented).
- **Profit** is Money In − Money Spent (no cost-of-goods accounting — matches spec).
