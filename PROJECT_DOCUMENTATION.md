# Quotist - Complete Project Documentation

> **Quotist** is a Windows-first desktop quotes generator built with **Electron** (UI), **Python** (backend) and **SQLite** (storage). It ships with a built-in quote library, can optionally pull more quotes from the DummyJSON API, and exports quotes to **PDF** or **TXT**. All data stays on the user's device.

| | |
|---|---|
| **Version** | 1.1.0 |
| **Author** | mayurcodes01 (https://github.com/mayurcodes01) |
| **License** | MIT |
| **App ID** | `com.mayurcodes01.quotist` |
| **Product name** | Quotist |
| **Tagline** | "Quotist Online, a quotes generator" |
| **Target platform** | Windows x64 (NSIS installer); runs on macOS/Linux in dev mode |

---

## 1. Table of Contents

1. Overview and features
2. Tech stack
3. Project structure
4. Architecture
5. Backend (Python)
6. Electron main process
7. Preload bridge
8. Renderer (UI)
9. Data model (SQLite)
10. Built-in quote library
11. Settings reference
12. Online source (DummyJSON)
13. Export formats
14. Security model
15. Setup, run and build
16. Packaging and distribution
17. Terms and Conditions shown in-app
18. Known limitations and ideas for improvement

---

## 2. Overview and Features

- **Generate quotes** at the press of a button or `Enter`.
- **Filter by keyword or author** (searches quote text and author, case-insensitive).
- **Built-in library** of 42 quotes in 6 categories (Motivation, Wisdom, Life, Success, Creativity, Courage).
- **Optional online source**: random quote from DummyJSON; falls back to the local library when offline.
- **Library sync**: downloads the whole DummyJSON collection into the local DB for offline use.
- **History ("log")**: every generated quote can be auto-saved (or saved manually), searched, copied, deleted, or cleared.
- **Export** a single quote or the whole history as **.txt** or **.pdf** (A4, styled).
- **Theming**: 6 colour themes × dark/light mode.
- **Code-editor-style quote card**: line numbers, traffic-light dots, file name (`quote_001.txt`), animated line reveal.
- **Frameless transparent window** with custom minimize/close controls and a right-hand tab rail.
- **Single instance** lock - launching a second copy focuses the existing window.
- **Local-only data**: no telemetry, no account.

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Shell / UI container | Electron (frameless, transparent `BrowserWindow`) |
| UI | Vanilla HTML, CSS, JavaScript (no framework) |
| Backend | Python 3, standard library only (`sqlite3`, `json`, `urllib`, `random`, `datetime`, `sys`) |
| Database | SQLite (file `quotist.db` in Electron `userData`) |
| IPC to backend | Newline-delimited JSON over child-process stdin/stdout |
| Backend packaging | PyInstaller (`--onefile`) |
| App packaging | electron-builder (NSIS installer, Windows x64) |
| Online API | https://dummyjson.com/quotes |

No third-party Python packages are required. `package.json` declares no runtime dependencies in the provided snapshot; `electron` and `electron-builder` are needed as dev dependencies to run/build (see §15).

---

## 4. Project Structure

```
quotist/
├── .gitignore              # node_modules, dist, build, pyi_work, __pycache__, *.db
├── package.json            # npm scripts, electron-builder config
├── main.js                 # Electron main process (window, IPC, backend process, exports)
├── preload.js              # contextBridge API exposed to the renderer as window.quotist
├── backend/
│   ├── backend.py          # Python backend: SQLite, quote logic, online fetch, JSON-RPC loop
│   └── quotes_data.py      # Built-in quote data + category order
└── renderer/
    ├── index.html          # UI markup (Run / Log / Cfg panels + right rail)
    ├── app.js              # UI logic and state
    └── styles.css          # Themes, layout, animations
```

Approx. size: ~1,650 lines (backend 322 + 55, main 270ish, app.js 434, HTML 193, CSS 649).

---

## 5. Architecture

```
┌──────────────────────────── Electron ────────────────────────────┐
│                                                                  │
│  Renderer (index.html + app.js)                                  │
│      │  window.quotist.call(action, payload)                     │
│      ▼                                                           │
│  preload.js  (contextBridge, contextIsolation = true)            │
│      │  ipcRenderer.invoke("api", action, payload)               │
│      ▼                                                           │
│  main.js  ── ipcMain.handle("api") ── callBackend()              │
│      │  stdin: {"id":N,"action":"...","payload":{...}}\n         │
│      ▼                                                           │
│  Python child process (backend.py <dbPath>)                      │
│      │  stdout: {"id":N,"ok":true,"data":...}\n                  │
│      ▼                                                           │
│  SQLite  (userData/quotist.db)          DummyJSON (optional)     │
└──────────────────────────────────────────────────────────────────┘
```

**Request flow**

1. The renderer calls `request("generate", {...})` which wraps `window.quotist.call`.
2. `main.js` assigns an incrementing `sequence` id, stores a Promise resolver in the `pending` map, and writes one JSON line to the backend's stdin.
3. `backend.py` reads the line, dispatches to a handler from the `ACTIONS` table, and writes one JSON line back.
4. `main.js` buffers stdout, splits on `\n`, parses each line, and resolves the matching pending promise.
5. The renderer receives `{ok, data}` or `{ok:false, error}`; errors become toasts.

**Failure handling**: if the backend fails to spawn or exits, every pending request is resolved with `{ok:false, error}`, and later calls return "Backend is not running".

---

## 6. Backend (Python) - `backend/backend.py`

### 6.1 Constants

| Name | Value | Purpose |
|---|---|---|
| `API_BASE` | `https://dummyjson.com/quotes` | Online quote source |
| `ONLINE_CATEGORY` | `"Online"` | Category label for downloaded quotes |
| `HTTP_TIMEOUT` | 8 s | Network timeout |
| `PAGE_SIZE` | 50 | Page size during sync |
| `MAX_PAGES` | 60 | Safety cap (up to 3,000 quotes per sync) |

### 6.2 Startup

`main()` reconfigures stdin/stdout to UTF-8, opens the DB at `sys.argv[1]`, then loops over stdin lines. `open_db()` creates tables if missing, inserts default settings (`INSERT OR IGNORE`), and seeds the `library` table with all built-in quotes (idempotent thanks to the `UNIQUE(text, author)` constraint).

### 6.3 Actions (the backend "API")

| Action | Payload | Returns | Notes |
|---|---|---|---|
| `categories` | - | `["All", ...ordered, ...extra]` | Ordered by `CATEGORY_ORDER`, extras (e.g. "Online") sorted after |
| `settings_get` | - | settings dict | |
| `settings_set` | `{key, value}` | updated settings dict | Validates key, theme, mode, blur (clamped 0–60), booleans, category |
| `generate` | `{category, keyword, last}` | quote object | See §6.4 |
| `library_stats` | - | `{total, builtin, online}` | |
| `library_sync` | - | `{added, partial, stats}` | Pages through DummyJSON; see §12 |
| `history_add` | `{text, author, category, created_at?}` | `{id}` | Manual save |
| `history_list` | `{search?}` | list of rows, newest first | `LIKE` on text/author/category |
| `history_delete` | `{id}` | `true` | |
| `history_clear` | - | `true` | |

Unknown actions or any exception yield `{id, ok:false, error:"..."}`; the process never crashes on a bad request.

### 6.4 Generate logic

1. Read settings. Online mode is attempted only if `online_enabled == "1"` **and** no keyword **and** category is `All` or `Online`.
2. If online: `GET /random`, normalise (`quote`→`text`, missing author→"Unknown"), store in `library` (source `online`), return it. On `OSError`/`ValueError` set `offline_fallback = true`.
3. Otherwise (or on fallback) `pick_local()`: filter `library` by category and/or keyword (`LOWER(text|author) LIKE %kw%`), exclude the previous quote (`last`) when alternatives exist, choose randomly.
4. No match → error "No quotes match this category and keyword. Try a different keyword."
5. The response includes `created_at` (UTC ISO-8601), `id` (history row id if auto-saved, else `null`), and `offline_fallback`.
6. If `auto_save == "1"`, the quote is inserted into `history` immediately.

---

## 7. Electron Main Process - `main.js`

Responsibilities:

- **Backend process management** - `backendCommand()` picks the bundled `quotist_backend(.exe)` from `process.resourcesPath/backend` when packaged, otherwise runs `python` (Windows) / `python3` with `backend/backend.py`. The DB path is `app.getPath("userData")/quotist.db`. `PYTHONIOENCODING=utf-8` is forced; `windowsHide: true` hides the console.
- **Window** - 1080×720, frameless, transparent, non-resizable, no shadow, context isolation on, node integration off.
- **IPC handlers**
  - `api` → forward to backend.
  - `export-text` / `export-pdf` → save dialog + write file (see §13).
  - `open-external` → opens a URL **only if it equals** `https://github.com/mayurcodes01`.
  - `win-min`, `win-max`, `win-close` → window controls.
- **Sanitising** - `cleanItems()` caps exports at 5,000 items and coerces fields to strings; `escapeHtml()` protects the PDF HTML.
- **Lifecycle** - single-instance lock, application menu removed, backend killed on `before-quit`, app quits when all windows close.

---

## 8. Preload Bridge - `preload.js`

Exposes `window.quotist` via `contextBridge`:

| Method | IPC | Purpose |
|---|---|---|
| `call(action, payload)` | invoke `api` | Backend request |
| `exportText(items, name)` | invoke `export-text` | Save .txt |
| `exportPdf(items, name)` | invoke `export-pdf` | Save .pdf |
| `openExternal(url)` | invoke `open-external` | Open GitHub |
| `minimize()` / `maximize()` / `close()` | send | Window controls |

---

## 9. Renderer (UI)

### 9.1 Layout

A rounded, transparent-window "app" containing a **stage** (three switchable panels) and a **right-hand rail** with window buttons, three tabs, and a "Q" logo. The top **dragbar** lets users move the frameless window.

| Tab (label) | Panel | Purpose |
|---|---|---|
| **run** | Generator | Quote card + keyword prompt + Generate / save / copy / .txt / .pdf |
| **log** | History | Search, count, export .txt/.pdf, clear, per-item copy/delete |
| **cfg** | Settings | Theme, appearance, behaviour toggles, library stats + sync, About, Terms |

### 9.2 Generator panel

- Editor-style card with fake traffic lights, filename `quote_NNN.txt` (session counter), category chip, line-number gutter, and footer (`local library` or `online + library`; `ln N, utf-8`).
- Quote text is word-wrapped (34 chars, or 46 for quotes > 170 chars). Font size scales with line count (30/25/21/18 px). Lines animate in with a staggered delay.
- `Enter` in the keyword field triggers generation. The button shows "Generating..." when online mode is on.
- **Save** button is shown only when auto-save is off; it is disabled once the quote has a history id.
- If the backend reports `offline_fallback`, a toast explains the quote came from the library.

### 9.3 History panel

Debounced (160 ms) search, item count, list of cards (quote, bold author, `#category`, localised timestamp), and **clear** with a two-step "sure?" confirmation that resets after 3 s.

### 9.4 Settings panel

- **Theme**: 6 swatches - Aurora, Ocean, Sunset, Forest, Rose, Graphite - plus Dark/Light segmented control.
- **Behaviour**: *Auto-save quotes* and *Fetch online quotes* toggles.
- **Library**: total / built-in / downloaded counts and a **Sync library** button.
- **About**: version, stack, storage, author, GitHub button, and the Terms and Conditions.

### 9.5 Styling - `styles.css`

CSS custom properties drive everything: `html[data-mode]` sets neutrals (`--base`, `--surface`, `--text`, `--muted`, …) and `html[data-theme]` sets accent trio `--c1/--c2/--c3`. Fonts fall back from Inter / Segoe UI Variable to system UIs; code areas use JetBrains Mono → Cascadia → Consolas. Drag regions use `-webkit-app-region`. Window radius is 26 px.

### 9.6 Client state

```js
state = { category: "All", current: null, count: 0, history: [], settings: {} }
```

Settings are loaded at startup and applied to `<html data-theme data-mode>`. Changes apply optimistically, then persist via `settings_set`.

---

## 10. Data Model (SQLite)

```sql
CREATE TABLE history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  author     TEXT NOT NULL,
  category   TEXT NOT NULL,
  created_at TEXT NOT NULL            -- UTC ISO-8601
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE library (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  author     TEXT NOT NULL,
  category   TEXT NOT NULL,
  source     TEXT NOT NULL,           -- 'builtin' | 'online'
  created_at TEXT NOT NULL,
  UNIQUE(text, author)
);
```

Location: `<Electron userData>/quotist.db` (on Windows: `%APPDATA%\Quotist\quotist.db`). `*.db` is git-ignored.

---

## 11. Built-in Quote Library - `backend/quotes_data.py`

42 quotes stored as `(category, text, author)` tuples, converted to `QUOTES = [{category, text, author}]`.

| Category | Count | Example |
|---|---|---|
| Motivation | 8 | "Fall seven times, stand up eight." - Japanese proverb |
| Wisdom | 7 | "The unexamined life is not worth living." - Socrates |
| Life | 7 | "Not all those who wander are lost." - J.R.R. Tolkien |
| Success | 7 | "Stay hungry, stay foolish." - Steve Jobs |
| Creativity | 7 | "Simplicity is the ultimate sophistication." - Leonardo da Vinci |
| Courage | 6 | "Courage is grace under pressure." - Ernest Hemingway |

`CATEGORY_ORDER` = Motivation, Wisdom, Life, Success, Creativity, Courage. To add quotes, append tuples to `_RAW`; they are inserted on next launch (existing rows are untouched).

---

## 12. Settings Reference

| Key | Default | Allowed | Meaning |
|---|---|---|---|
| `theme` | `aurora` | aurora, ocean, sunset, forest, rose, graphite | Accent colours |
| `mode` | `dark` | dark, light | Appearance |
| `blur` | `28` | integer 0–60 | Reserved (not exposed in current UI) |
| `default_category` | `All` | `All` or any existing category | Reserved (not exposed in current UI) |
| `auto_save` | `1` | `0` / `1` | Save each generated quote to history |
| `online_enabled` | `0` | `0` / `1` | Try DummyJSON before the local library |

---

## 13. Online Source (DummyJSON)

- **Random quote**: `GET https://dummyjson.com/quotes/random` → `{quote, author}`.
- **Sync**: pages through `GET /quotes?limit=50&skip=N` until the returned list is empty, `skip >= total`, or `MAX_PAGES` is hit. New quotes are inserted with category `Online`, source `online`; duplicates are ignored.
- Network errors during sync: if nothing was added → error toast; if some were added → `partial: true` and a "Connection dropped. Added N quotes so far." toast.
- Requests send `User-Agent: Quotist/1.1`. Only the request itself is sent; no personal data.
- Online mode is skipped when a keyword is typed or a non-`All`/`Online` category is chosen, so keyword searches always use the full local library.

---

## 14. Export Formats

**Text (.txt)** - header `Quotist` + export timestamp, then each entry as:

```
"quote text"
Author (Category)
```

**PDF (.pdf)** - an HTML document is rendered in a hidden sandboxed `BrowserWindow` and printed with `printToPDF` (A4, backgrounds on, margins 22 mm / 20 mm). Palatino/Georgia serif quotes with an accent left border, bold author, and a meta line (category + localised timestamp). Entries avoid page breaks inside.

Single-quote export uses the name "Quotist Quote"; history export uses "Quotist History". Cancelling the save dialog is handled silently.

---

## 15. Security Model

- `contextIsolation: true`, `nodeIntegration: false`; the renderer only sees the narrow `window.quotist` API.
- Strict CSP in `index.html`: `default-src 'self'; style-src 'self'; script-src 'self'` (no inline scripts/styles, no remote content).
- `open-external` whitelists a single URL.
- Export input is sanitised and capped; HTML is escaped before PDF rendering; the PDF window is sandboxed.
- The renderer builds DOM nodes with `textContent`, avoiding injection from quote data.
- All SQL uses parameterised queries. (`pick_local` composes the `WHERE` clause from fixed fragments only.)
- No data leaves the device except the optional DummyJSON request.

---

## 16. Setup, Run and Build

### Prerequisites

- Node.js (LTS) and npm
- Python 3 (on Windows the command must be `python`; elsewhere `python3`)
- For packaging: `pip install pyinstaller` and `electron-builder`

### Development

```bash
npm install --save-dev electron electron-builder   # first time (not pinned in package.json)
npm start                                          # runs: electron .
```

In dev mode Electron spawns `python backend/backend.py <userData>/quotist.db`.

### Build for Windows

```bash
npm run build:backend   # PyInstaller → build/backend/quotist_backend.exe
npm run dist            # electron-builder --win nsis → dist/
```

`build:backend` runs:

```
pyinstaller --onefile --name quotist_backend \
  --distpath build/backend --workpath pyi_work --specpath pyi_work backend/backend.py
```

The PyInstaller binary is copied into the installer as `resources/backend/` via `extraResources`.

---

## 17. Packaging Configuration (electron-builder)

- `appId`: `com.mayurcodes01.quotist`, `productName`: Quotist, output dir `dist`.
- Included files: `main.js`, `preload.js`, `renderer/**/*`.
- Target: **NSIS x64**, not one-click, user can change install dir, desktop and Start Menu shortcuts named "Quotist".
- Git-ignored build artefacts: `node_modules`, `dist`, `build`, `pyi_work`, `__pycache__`, `*.db`.

---

## 18. In-App Terms and Conditions (summary)

1. Acceptance by use. 2. Personal/educational use. 3. Quote wording belongs to authors/rights holders; attribution is best-effort. 4. All data is local; nothing is collected or shared. 5. Online source = DummyJSON, request only, results stored locally; service availability is outside the author's control. 6. User is responsible for exported files. 7. No warranty. 8. No liability. 9. Terms may change.

---

## 19. Known Limitations and Improvement Ideas

- `package.json` has no `devDependencies`; add pinned `electron` and `electron-builder` so `npm install` works out of the box.
- No README, tests, or CI in the snapshot.
- `blur` and `default_category` settings exist in the backend but have no UI; the `categories` action is implemented but the renderer has no category picker (the state is fixed to `All`).
- `win-max` IPC exists, but the window is non-resizable and no maximise button is rendered.
- Settings and history rely on a single long-lived Python process; very large online syncs block it while running (one request at a time).
- Keyword search uses `LIKE` on the whole library; fine for thousands of quotes, but FTS5 would scale better.
- Only the Windows installer target is configured; add `mac`/`linux` targets for cross-platform releases.
- The text export format is plain; adding JSON/CSV export would be straightforward via the existing `cleanItems` path.

---

*Document generated from the source in `quotist/` (v1.1.0).*
