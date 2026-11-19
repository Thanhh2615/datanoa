<p align="center">
  <img src="assets/icon.png" alt="Datanoa Logo" width="84" height="84" />
</p>

# Datanoa — Multi-Engine OLED Database Studio for Orca

**Datanoa** is a production-grade, zero-stub Database Studio extension for **Orca** (`>=1.4.248`). Inspired by JetBrains DataGrip and built specifically around Orca's True OLED (`#000000`) and Light theme token system, Datanoa gives you unified schema exploration, transactional inline data editing, multi-statement SQL & Redis execution, execution plan analysis, and `.env` / `.db` auto-discovery across **8 database engines** without leaving your workspace.

---

## True Orca OLED & Light Theme Parity

- **True OLED Canvas (`#000000`):** Reads Orca host-injected `--orca-*` tokens directly (`--orca-background`, `--orca-editor-surface`, `--orca-secondary`, `--orca-border`, `--orca-foreground`, `--orca-primary`, `--orca-primary-foreground`, `--orca-accent`) with `#000000` OLED canvas fallbacks, `#0a0a0a` / `#0f0f0f` / `#141414` elevated surfaces, `#1f1f1f` hairline borders, and `#e6e6e6` on `#000000` primary actions.
- **Zero Host Token Overrides:** Never overwrites `:root` `--orca-*` variables, preserving `stablyai.orca-oled-theme` and user themes automatically.
- **Full Light Mode Parity:** Detects host theme via `orca.on('theme')` and luminance probing of `--orca-background`, toggling `html.light` cleanly across both the Sidebar Panel and Full Studio Editor.
- **Native Orca Typography Sync & Embedded `Geist` Variable Font:** Synchronizes font family, size, weight, line height, and ligatures directly from Orca via `editor.readTypography` and `editor.typography.changed`, while embedding Orca Desktop's bundled `Geist` variable font (`assets/fonts/Geist-Variable.woff2` / `src/assets/geist-font.ts`, `GEIST_FONT_DATA_URI`) via `@font-face` in both the isolated Custom Editor and Sidebar Panel HTML for exact visual parity with Orca Desktop (`Cascadia Code` / `ui-monospace` for SQL & tabular metrics).
- **OLED CodeMirror 6 Highlighting:** Configured with `HighlightStyle` tuned to `stablyai.orca-oled-theme` SQL syntax colors.

---

## 8 Supported Database Engines

| Engine | Driver ID | Default Port | Transport / Implementation |
|---|---|---|---|
| **SQLite** | `sqlite` | Local file / `:memory:` | Built-in `node:sqlite` (`DatabaseSync`) isolated in `worker_threads` |
| **PostgreSQL** | `postgres` | `5432` | Pre-bundled `pg` + `pg-cursor` (`vendor/pg.js`) with optional TLS |
| **MySQL** | `mysql` | `3306` | Pre-bundled pure-JS `mysql2` (`vendor/mysql2.js`) |
| **MariaDB** | `mariadb` | `3306` | Pre-bundled pure-JS `mysql2` (`vendor/mysql2.js`) |
| **CockroachDB** | `cockroachdb` | `26257` | PostgreSQL wire protocol (`vendor/pg.js`) with SSL default enabled |
| **ClickHouse** | `clickhouse` | `8123` / `8443` | Native HTTP(S) `JSONCompact` & parameterized mutation driver |
| **Redis** | `redis` | `6379` | Zero-dependency TCP / TLS RESP2 protocol client (`db0`–`db15`, `SCAN`) |
| **Turso / LibSQL** | `libsql` | `443` | Hrana v2 HTTP pipeline client with encrypted `authToken` storage |

### 1-Click Connection URI Quick-Fill & Workspace Auto-Detect

- **Connection URI Parser (`connection.parseUri`):** Paste any `postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `cockroachdb://`, `cockroach://`, `clickhouse://`, `clickhouses://`, `http://`, `https://`, `redis://`, `rediss://`, `libsql://`, `sqlite://`, or `file:` URI to auto-populate engine selection, host, port, database, TLS flags, credentials, and SQLite read-only mode.
- **Workspace `.env` & `.db` Auto-Detection (`workspace.detectConnections`, `sqlite.scanFolder`):**
  - Scans root `.env`, `.env.local`, and `.env.development` files for database URLs (`DATABASE_URL`, `POSTGRES_URL`, `MYSQL_URL`, `REDIS_URL`, `CLICKHOUSE_URL`, `TURSO_DATABASE_URL`, `LIBSQL_URL`, and related keys).
  - Performs bounded asynchronous BFS discovery (`800ms` budget, max depth `4`, max `350` dirs, max `60` results) for `.db`, `.sqlite`, and `.sqlite3` files while blocking home/system roots (`isBlockedScanRoot`) and skipping `node_modules`, `.git`, build outputs, and caches.

---

## JetBrains DataGrip / Database Tools Parity

- **Multi-Data-Source Expandable Tree:** Expand multiple database connections simultaneously with custom engine vector SVG logos (`getDbLogoSvg` / `createDbLogoSvg`), `DEV` / `STAGING` / `PROD` environment badges, `RO` indicators, nested `Tables` / `Views` / `Keyspaces` → `Columns` / `Indexes` / `Foreign Keys`, live table & column search, safe delete confirmation modal (`Confirm Delete Connection`) before removing a connection, and right-click context menus (`Open Data`, `Open in Full Studio`, `Jump to Console`, `Generate SELECT / INSERT / UPDATE / CREATE DDL`, `Edit`, `Duplicate`, `Refresh`, `Delete`).
- **Server-Side `WHERE` & `ORDER BY` Filter Bar & Configurable Page Size (`100`–`10,000`):** Execute filtered and sorted table pages on the server (`data.fetchPage`) with statement-breakout protection (`sanitizeFilterClause` rejects unquoted `;`, `--`, `/*`, and unclosed quotes) and switch rows per page (`100`, `500`, `1,000`, `5,000`, `10,000`) on the fly in both Panel and Full Studio.
- **Smart Context-Aware SQL & Redis Autocomplete + Query Status/Error Banners:** Context-aware CodeMirror completion (`computeSmartSqlCompletions`) suggests active/referenced table columns directly inside `SELECT`, `WHERE`, and `ORDER BY` clauses, boosts table names after `FROM` / `JOIN` / `UPDATE` / `INTO`, resolves table aliases (`a.col`), and completes Redis commands (`SCAN`, `GET`, `HGETALL`, etc.), paired with prominent `.datanoa-query-banner` / `#sqlSuccessBanner` / `#sqlErrorBanner` feedback and query-aware empty states.
- **Transactional Batch Staging & DML Preview:** Stage inline cell edits, new rows (`+ Row`, automatically omitting unedited `AUTOINCREMENT` and `DEFAULT` columns such as `DEFAULT datetime('now')` so the database evaluates true engine defaults cleanly and displaying `(auto)` / `(default)` cell placeholders), row deletions (`− Row`), and row clones (`Clone` / `Clone Row`) with live pending counters, preview exact dialect SQL statements (`DML Preview` → `data.previewChanges`), commit atomically inside dialect transactions (`Submit` → `data.applyChanges`), or roll back locally (`Revert`). Inline edits enforce optimistic concurrency matching on original values.
- **Transpose View:** Toggle `Transpose` (`⇄ Transpose`) to inspect wide tables row-by-column without horizontal scrolling fatigue.
- **7-Format Data Extractor:** Copy result grids cleanly as `SQL INSERT`, `SQL UPDATE`, `JSON`, `NDJSON`, `CSV`, `TSV`, or `Markdown`.
- **Caret-Aware Multi-Statement SQL Runner & `EXPLAIN`:** Split SQL scripts cleanly across quotes, dollar-quoted (`$$`) blocks, and comments (`findStatementAtOffset`) so `Ctrl+Enter` runs the statement at the cursor while `Execute All` / `Run All` runs all statements end-to-end. Run `Explain` (`query.explain`) for execution plans and abort long queries mid-flight (`query.cancel`).
- **Persistent Query History:** Browse, filter, and recall up to 50 recent queries with driver badges, duration metrics, and error indicators (`query.history.list`, `query.history.clear`).
- **Staged Visual Table Structure Designer (`Schema Inspector` / `Schema` Tab & SQLite 12-Step Rebuild):** Design tables interactively in the same DataGrip/TablePlus-grade staged grid (`+ Column`, `+ Index / Key` with composite multi-column pills & `UNIQUE` support, `+ Foreign Key` with `ON DELETE` rules, inline table rename, inline column type/PK/Nullable editing, smart `Default Value` auto-quoting with 1-click `×` clear button, `DDL Preview` drawer, `Apply [N]` via `Ctrl+S`, and `Revert`). Powered by a multi-dialect migration builder (`buildTableMigrationSql`) that performs an atomic 12-step `PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE; CREATE TABLE ...; INSERT INTO ... SELECT ...; DROP TABLE ...; ALTER TABLE ... RENAME TO ...; COMMIT; PRAGMA foreign_keys = ON;` table rebuild on SQLite/LibSQL whenever column types, defaults, nullability, PKs, or FKs change.
- **Cleanly Formatted Multi-Line `CREATE TABLE` DDL Viewer:** Inspect formatted multi-line `CREATE TABLE`, `PRIMARY KEY`, `FOREIGN KEY`, and `CREATE [UNIQUE] INDEX` DDL (`formatDdlForDisplay`, `schema.generateDdl` / `reconstructTableDdl`) preserving exact identifier casing alongside scrollable Columns, Foreign Keys, and Indexes matrices.
- **Dockable Cell & JSON Value Inspector:** Single-click cells to highlight and stage without shrinking the grid; open the Value Inspector on demand via the **Edit Cell** button or grid context menu (**Edit in Value Inspector**) to edit multi-line text, pretty-print JSON payloads (`Format JSON`), set `NULL`, or copy values.
- **Environment Color Guards & Read-Only Lock:** Tag connections as `none`, `dev`, `staging`, or `prod` (`colorTag`), display caution banners on `PROD` / `Read-Only` connections, and enforce worker-level mutation blocking (`isMutatingStatement`) across both single and multi-statement SQL buffers whenever `readOnly` is active.

### Keyboard & Mouse Shortcuts

| Shortcut / Gesture | Action | Scope |
|---|---|---|
| `Ctrl / Cmd + Mouse Wheel` | Smooth horizontal panning on wide tables, SQL results, DDL cards & schema matrices | Panel & Full Studio |
| `Drag Column Border` | Smooth 60fps `<colgroup>` column width resizing across `#` & data columns | Panel & Full Studio |
| `Double-Click Column Border` | Auto-fit column width (`64px–480px`) to visible header & cell content | Panel & Full Studio |
| `Double-Click` | Open inline cell editor (`Enter` / smart `blur` to commit) | Data Grid |
| `Tab` / `Shift+Tab` | Commit current cell edit and jump to next / previous editable cell | Data Grid |
| `Ctrl+Enter` (`Cmd+Enter`) | Execute SQL statement at current caret position | SQL Console |
| `Execute All` (`Run All`) | Execute entire multi-statement SQL buffer sequentially | SQL Console |
| `Ctrl+S` / `Cmd+S` | Transactional batch submit of all staged inserts, updates & deletes | Data Grid |
| `Escape` | Cancel active inline cell edit or dismiss context menus / drawers | Panel & Full Studio |

---

## Architecture & Security Model

Datanoa runs under Orca's `"trusted-worker"` execution model (`manifestVersion: 2`, `pluginApi: 1`):

1. **Sidebar Panel (`src/panel/panel.html`, `ui: "html"`):** Self-contained OLED HTML/CSS/SVG Studio sidebar panel, paired with `src/panel/index.tsx` and `src/panel/index.check.ts` for declarative check coverage.
2. **Full Studio Custom Editor (`src/editor/index.ts`, `frame: "isolated"`):** Custom editor for `.sql` and `.datanoa` documents (`.datanoa/*.datanoa` workspace tabs opened via `studio.open` with `.datanoa/.gitignore` isolation), hosting CodeMirror 6 (`src/editor/console.ts`), the virtualized staging grid (`src/editor/grid.ts`), and schema/DDL inspector (`src/editor/schema-inspector.ts`).
3. **Trusted Worker (`src/worker/index.ts`):**
   - `connections.list` and `SessionManager.findProfile` read exclusively from `orca.storage` (`datanoa.savedConnections`) so listing connections never triggers filesystem crawls.
   - `SessionManager` stores passwords (`pwd_<id>`) and Turso/LibSQL tokens (`tok_<id>`) strictly in Orca's encrypted `secrets:own` vault and strips secrets from sanitized JSON responses (`sanitizeJsonPayload`).
   - SQLite operations execute inside an isolated Node `worker_threads` worker (`src/drivers/sqlite/thread.ts`).
4. **Type-Safe IPC Contract (`src/protocol.ts`):** Single source of truth augmenting `orca`'s `PluginRequests` and `PluginPanelEvents` across worker, panel, editor, and test suites.
5. **CSP & Bundle Compliance:** All vendor bundles (`vendor/pg.js`, `vendor/mysql2.js`, `vendor/codemirror.js`) are minified ESM modules strictly `< 1 MiB` per file with zero `eval(` and zero `new Function(`.
6. **Licensing:** Released under the [MIT License](LICENSE) with full dependency attributions in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

## Project Structure

```text
datanoa/
├── assets/
│   ├── fonts/Geist-Variable.woff2      # Bundled Orca Geist variable font (SIL OFL-1.1)
│   └── icon.png                        # 256x256 plugin icon (< 1 MiB)
├── build/
│   └── bundle-drivers.mjs              # esbuild vendor bundler + 1 MiB size & CSP audit
├── src/
│   ├── assets/
│   │   ├── geist-font.ts               # Base64 WOFF2 GEIST_FONT_DATA_URI (< 100 KB)
│   │   └── logo.ts                     # 64x64 Base64 PNG DATANOA_LOGO_DATA_URI
│   ├── protocol.ts                     # Canonical IPC contracts & JsonValue sanitizer
│   ├── drivers/
│   │   ├── index.ts                    # 8-engine driver registry
│   │   ├── common/                     # Shared URI parser, SQL tools, schema, update builder
│   │   ├── sqlite/                     # node:sqlite driver + worker_threads runner
│   │   ├── postgres/                   # PostgreSQL & CockroachDB driver (vendor/pg.js)
│   │   ├── mysql/                      # MySQL & MariaDB driver (vendor/mysql2.js)
│   │   ├── clickhouse/                 # ClickHouse HTTP JSONCompact driver
│   │   ├── redis/                      # Zero-dependency TCP/TLS RESP2 client
│   │   └── libsql/                     # Turso / LibSQL Hrana v2 HTTP pipeline client
│   ├── editor/                         # Isolated Custom Editor (.sql / .datanoa)
│   ├── panel/                          # Sidebar HTML panel + TSX / check compatibility
│   └── worker/                         # Trusted worker IPC handlers, discovery & session manager
├── test/
│   ├── drivers/                        # SQLite, Postgres, MySQL & multi-engine integration tests
│   ├── worker/                         # URI parser, SQL tools & trusted-worker RPC tests
│   └── e2e/
│       ├── panel-editor-runtime.e2e.test.ts # Static JS semantic, font, grid DOM & SQLite runtime gate
│       ├── harness/                    # MockOrcaRuntime, fixtures & test helpers
│       └── tier1-feature-coverage/     # Tier-1 feature E2E suite (F1–F20)
├── vendor/                             # Pre-bundled pg, mysql2 & codemirror (< 1 MiB each)
├── LICENSE                             # MIT License
├── THIRD-PARTY-NOTICES.md              # Bundled open-source notices
└── orca-plugin.json                    # Orca v2 plugin manifest
```

---

## Build, Typecheck, Test & Verification

Prerequisites: **Node.js `>=22`** (Node 24 recommended for native `node:sqlite`) and **Orca `>=1.4.248`**.

```powershell
# Install dependencies
npm install

# Bundle pg, mysql2, and CodeMirror into vendor/ (< 1 MiB, CSP audited)
npm run build

# Generate .orca/types and run strict TypeScript typechecking
npm run typecheck

# Run full Vitest suite (15 files / 314 tests: drivers, worker, SQL tools, URI parser, runtime gates & E2E)
npm test

# Run Orca CLI manifest, check, and runtime test verification
orca plugin validate .
orca plugin check .
orca plugin test .

# Or run the combined verification pipeline
npm run verify
```
