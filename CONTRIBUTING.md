# Contributing to Datanoa

Thank you for helping improve **Datanoa** — the database client and SQL studio plugin for **Orca** (`>=1.4.248`)!

Whether you are reporting a bug, requesting a database feature, or submitting a pull request, this guide covers everything you need to set up, verify, and contribute cleanly.

---

## Reporting Bugs & Requesting Features

### 1. Using the Built-In Feedback Modal inside Orca (Recommended)

You can generate a privacy-safe diagnostic report directly from Datanoa:

- **Fullscreen Studio:** Click **`Feedback`** in the bottom-right status bar, open the Command Palette (`Ctrl+K`) and select **`Report Bug / Request Feature...`**, or click **`Report Issue`** on any unexpected error banner.
- **Side Panel:** Click **`Feedback`** in the top header bar.

The modal automatically pre-fills non-sensitive environment context (Datanoa version, active database driver family, view mode, read-only state, and sanitized error messages with any URI credentials masked — **never** hostnames, usernames, passwords, tokens, or file paths). Click **`Open on GitHub Issues ↗`** or **`Copy Report`**.

### 2. Opening an Issue Directly on GitHub

Use our structured GitHub Issue Templates:

- **Bug Report:** [github.com/Thanhh2615/datanoa/issues/new?template=bug_report.yml](https://github.com/Thanhh2615/datanoa/issues/new?template=bug_report.yml)
- **Feature Request:** [github.com/Thanhh2615/datanoa/issues/new?template=feature_request.yml](https://github.com/Thanhh2615/datanoa/issues/new?template=feature_request.yml)

---

## Local Development Setup

### Prerequisites

- **Node.js `>=22`** (Node 24 recommended for native `node:sqlite`)
- **Orca Desktop & Orca CLI `>=1.4.248`**

### Install, Build & Load in Orca

```bash
# 1. Clone the repository
git clone https://github.com/Thanhh2615/datanoa.git
cd datanoa

# 2. Install dependencies
npm install

# 3. Bundle vendor drivers & parsers (iconv-lite, pg, mysql2, mongodb, mssql, oracledb, ssh2, CodeMirror 6, node-sql-parser) into vendor/ (< 1 MiB & CSP audit)
npm run build

# 4. Run the full verification pipeline (build + size + typecheck + validate + check)
#    Use `npm run verify` on clean clones (`tests/` and `vitest.config.ts` are excluded via `.gitignore`).
npm run verify

# 5. Run the Vitest regression suite (when local `tests/` & `vitest.config.ts` are present)
npm test

# 6. Hot-load the plugin into your local Orca Desktop instance
orca plugin dev load .
```

> **Note on "Install plugin -> Local folder" in Orca Desktop:**
> All runtime dependencies (`vendor/iconv-lite.js`, `vendor/pg.js`, `vendor/mysql2.js`, `vendor/mongodb.js`, `vendor/mssql.js`, `vendor/oracledb.js`, `vendor/ssh2.js`, `vendor/codemirror.js`, `vendor/sql-parser-pg-sqlite.js`, `vendor/sql-parser-mysql-mssql.js`, `vendor/big-integer.js`) are pre-bundled into `vendor/` (`~4.0 MB` total; total packaged workspace payload `<= 25,000,000` bytes). However, Orca Desktop's **Local folder** installer scans the entire folder on disk (including untracked directories) against a 50 MiB / file-count limit. Before installing from a local checkout via **Install plugin -> Local folder** (or inspecting with `orca plugin inspect .`), remove dev-only directories (`rm -rf node_modules .serena .orca .datanoa .vite`) or use `orca plugin dev load .`.

---

## Architecture & Module Layout

```text
datanoa/
├── assets/
│   └── icon.png                          # 256x256 plugin icon
├── build/
│   ├── bundle-drivers.mjs                # esbuild bundler + pinned version/patch guards + < 1 MiB & CSP static auditor
│   └── check-package-size.mjs            # Package payload & vendor size budget guard
├── images/                               # 960x600 cover & 1280x800/1600x1000 (16:10) screenshots
├── vendor/
│   ├── big-integer.js / big-integer.d.ts     # Shared ESM big-integer bundle (used by sql-parser bundles)
│   ├── iconv-lite.js                         # Shared ESM iconv-lite bundle (used by mysql2 & mssql)
│   ├── pg.js / pg.d.ts                       # Bundled node-postgres + pg-cursor
│   ├── mysql2.js / mysql2.d.ts               # Bundled mysql2 (with IP-SAN TLS identity patch)
│   ├── mongodb.js / mongodb.d.ts             # Bundled official MongoDB driver + BSON/EJSON
│   ├── mssql.js / mssql.d.ts                 # Bundled mssql + tedious (node:stream & Azure stubs)
│   ├── oracledb.js / oracledb.d.ts           # Bundled OracleDB Thin Mode driver
│   ├── codemirror.js / codemirror.d.ts       # Bundled CodeMirror 6 SQL editor, Lezer highlight & Vim keymap
│   ├── sql-parser-pg-sqlite.js / .d.ts       # Bundled node-sql-parser (PostgreSQL & SQLite AST grammar)
│   ├── sql-parser-mysql-mssql.js / .d.ts     # Bundled node-sql-parser (MySQL & T-SQL AST grammar)
│   └── ssh2.js / ssh2.d.ts                   # Bundled pure-JS ssh2 (multi-hop SSH tunnels with known_hosts verification)
├── src/
│   ├── protocol.ts                       # Canonical IPC contracts & payload sanitizer
│   ├── shared-ai-ui.js                   # Shared dual-role AI modal, Fix with AI, aiPolicy gate & resizable EXPLAIN panel UI
│   ├── shared-ai-ui.d.ts                 # TypeScript declaration for shared-ai-ui.js
│   ├── shared-bind-params-modal.js       # Shared SQL Bind Parameters modal across Studio & Side Panel
│   ├── shared-bind-params-modal.d.ts     # TypeScript declaration for shared-bind-params-modal.js
│   ├── shared-cm-inline-ai.js            # Shared CodeMirror 6 ghost text, multi-hunk statement diffs (Alt+\), Pacer & telemetry extension
│   ├── shared-cm-inline-ai.d.ts          # TypeScript declaration for shared-cm-inline-ai.js
│   ├── shared-cm-keymap.js               # Shared CodeMirror 6 default/Vim modal keymap & custom Run/Format shortcut resolver
│   ├── shared-cm-keymap.d.ts             # TypeScript declaration for shared-cm-keymap.js
│   ├── shared-cm-sql-lint.js             # Shared CodeMirror 6 SQL syntax diagnostics & live DB error lint extension
│   ├── shared-cm-sql-lint.d.ts           # TypeScript declaration for shared-cm-sql-lint.js
│   ├── shared-collapsible-select.js      # Shared searchable & collapsible select dropdown controller
│   ├── shared-collapsible-select.d.ts    # TypeScript declaration for shared-collapsible-select.js
│   ├── shared-connection-order.js        # Shared folder-scoped connection & folder-section reordering primitives (Worker, Studio & Side Panel)
│   ├── shared-connection-order.d.ts      # TypeScript declaration for shared-connection-order.js
│   ├── shared-constants.ts               # Shared version, timeout, chunk & storage constants
│   ├── shared-db-icons.js                # Shared DB engine, folder & workspace SVG icons (Studio & Side Panel)
│   ├── shared-db-icons.d.ts              # TypeScript declaration for shared-db-icons.js
│   ├── shared-er-diagram.js              # Shared ER graph builder, FK cardinality inference & M:N junction collapse
│   ├── shared-er-diagram.d.ts            # TypeScript declaration for shared-er-diagram.js
│   ├── shared-er-exporters.js            # Shared Mermaid (.mmd), Graphviz (.gv), pure SVG & PNG ER exporters
│   ├── shared-er-exporters.d.ts          # TypeScript declaration for shared-er-exporters.js
│   ├── shared-er-layout.js               # Shared force-directed, PCA rotation, AABB & NFDH shelf-packing ER layout engine
│   ├── shared-er-layout.d.ts             # TypeScript declaration for shared-er-layout.js
│   ├── shared-explain-parsers.js         # Shared 8+ dialect EXPLAIN plan parsers (PG, MySQL/MariaDB, SQLite, CRDB, Oracle, MSSQL, Mongo, text)
│   ├── shared-explain-parsers.d.ts       # TypeScript declaration for shared-explain-parsers.js
│   ├── shared-explain-plan.js            # Shared EXPLAIN plan normalizer, exclusive cost/parallel/loop metrics & IPC compaction
│   ├── shared-explain-plan.d.ts          # TypeScript declaration for shared-explain-plan.js
│   ├── shared-explain-svg.js             # Shared zero-foreignObject SVG Visual EXPLAIN Tree renderer & popover controller
│   ├── shared-explain-svg.d.ts           # TypeScript declaration for shared-explain-svg.js
│   ├── shared-file-picker.js             # Shared in-app file/folder picker modal (Studio & Side Panel)
│   ├── shared-file-picker.d.ts           # TypeScript declaration for shared-file-picker.js
│   ├── shared-grid-paste.js              # Shared delimited clipboard, lossless BIGINT JSON formatter, paste planner & error sanitizer
│   ├── shared-grid-paste.d.ts            # TypeScript declaration for shared-grid-paste.js
│   ├── shared-row-height-index.js        # Shared 256-row chunked lazy prefix-sum index for wrapped multi-line grid cells
│   ├── shared-row-height-index.d.ts      # TypeScript declaration for shared-row-height-index.js
│   ├── shared-sql-core.js                # Shared SQL lexer, splitter, active statement isolation, target range remapping, formatter, DDL guard & validators
│   ├── shared-sql-core.d.ts              # TypeScript declaration for shared-sql-core.js
│   ├── shared-sql-diagnostics.js         # Shared zero-dependency multi-dialect SQL syntax diagnostic engine & multi-statement DB error targeting
│   ├── shared-sql-diagnostics.d.ts       # TypeScript declaration for shared-sql-diagnostics.js
│   ├── shared-sql-params.js              # Shared multi-syntax SQL bind parameter extractor (?, {{name}}, ${name}, :name, @name, $1) & binder
│   ├── shared-sql-params.d.ts            # TypeScript declaration for shared-sql-params.js
│   ├── shared-sql-safety.js              # Shared dangerous SQL analyzer, URI secret masker, storage scrubbers & Redis credential detector
│   ├── shared-sql-safety.d.ts            # TypeScript declaration for shared-sql-safety.js
│   ├── shared-ssh-hostkey-modal.js       # Shared top-layer SSH host-key fingerprint trust/replace modal (Studio & Side Panel)
│   ├── shared-ssh-hostkey-modal.d.ts     # TypeScript declaration for shared-ssh-hostkey-modal.js
│   ├── shared-table-display.js           # Shared per-table column display normalization, conditional highlighting & ReDoS/BigInt evaluator
│   ├── shared-table-display.d.ts         # TypeScript declaration for shared-table-display.js
│   ├── shared-wheel-scroll.js            # Shared Ctrl+Wheel horizontal scroll helper
│   ├── shared-wheel-scroll.d.ts          # TypeScript declaration for shared-wheel-scroll.js
│   ├── assets/
│   │   ├── geist-font.js                 # Embedded WOFF2 data URI for Studio & Side Panel
│   │   ├── geist-font.d.ts               # TypeScript declaration for geist-font.js
│   │   └── logo.ts                       # Embedded 64x64 logo data URI
│   ├── drivers/
│   │   ├── index.ts                      # Built-in driver registry
│   │   ├── lazy-loader.ts                # On-demand dynamic importer for built-in drivers (fast cold-boot)
│   │   ├── driver-manager.ts             # Local BYOD driver manager with SHA-256 verification
│   │   ├── common/
│   │   │   ├── bounded-file-reader.ts    # Size-bounded, symlink-safe regular-file reader shared by TLS/SSH/discovery/BYOD
│   │   │   ├── byod-templates.ts         # 7 BYOD starter adapter templates (DuckDB, Snowflake, BigQuery, Cassandra, Elasticsearch, Neo4j, Custom)
│   │   │   ├── connection-uri.ts         # Multi-dialect URI parser & Cloud Auto-SSL detector
│   │   │   ├── driver.ts                 # Shared driver contracts, abort signal, EXPLAIN/ER/COPY hooks & tx helpers
│   │   │   ├── engine-catalog.ts         # Engine metadata & capability definitions
│   │   │   ├── mssql-sql.ts              # Pure T-SQL batch splitter, Read-Only guard & TX-control analyzer
│   │   │   ├── network-dialer.ts         # RFC 8305 Happy Eyeballs 250ms dual-stack TCP dialer
│   │   │   ├── oracle-sql.ts             # Pure Oracle SQL / SQL*Plus splitter & implicit-commit DDL detector
│   │   │   ├── schema.ts                 # Catalog introspection, DDL export & TableDetailsCache
│   │   │   ├── schema-er-graph.ts        # Bulk ER catalog introspection across built-in SQL engines
│   │   │   ├── sql-credentials.ts        # Credential & secret literal scanner
│   │   │   ├── sql-lexer.ts              # Dialect-aware SQL splitter, comment stripper & guards
│   │   │   ├── sql-formatter.ts          # SQL formatter & data exporters
│   │   │   ├── sql-migration.ts          # Table structure migration planner
│   │   │   ├── sql-tools.ts              # Barrel re-export
│   │   │   ├── ssh-hop-secrets.ts        # Per-hop SSH keyring lifecycle & prefix-closed SSRF guard
│   │   │   ├── ssh-host-keys.ts          # Global @revoked scanning, serverHostKey ordering & atomic known_hosts writer
│   │   │   ├── ssh-multi-hop.ts          # In-process N-hop ssh2 tunnel chain & reverse teardown
│   │   │   ├── tls-and-tunnel.ts         # Fail-closed TLS/mTLS options, IPv4 bridge & SSH tunnel facade
│   │   │   ├── tls-prober.ts             # Credential-less TLS/STARTTLS/TDS 8.0 prober & 13 structured TlsFailures
│   │   │   └── update-builder.ts         # Parameterized DML, PK reload, chunked INSERT & pagination
│   │   ├── sqlite/                       # node:sqlite driver + worker_threads runner
│   │   ├── postgres/                     # PostgreSQL & CockroachDB driver, Supabase IPv4 bridge & COPY FROM STDIN stream (`copy-in-stream.ts`)
│   │   ├── mysql/                        # MySQL & MariaDB pooled driver
│   │   ├── clickhouse/                   # ClickHouse HTTP(S) driver
│   │   ├── redis/                        # TCP/TLS RESP2 client
│   │   ├── libsql/                       # Turso / LibSQL HTTP pipeline client
│   │   ├── d1/                           # Cloudflare D1 HTTP REST client
│   │   ├── mssql/                        # SQL Server (MSSQL) pooled TDS driver
│   │   ├── oracle/                       # Oracle Database Thin Mode driver
│   │   └── mongodb/                      # MongoDB BSON / MQL driver
│   ├── editor/                           # Isolated Custom Editor (.sql / .datanoa)
│   │   ├── index.ts                      # Fullscreen Studio controller & IPC orchestration
│   │   ├── document-meta.ts              # .datanoa metadata header & session cache snapshot helpers
│   │   ├── er-diagram-view.ts            # Interactive ER Diagram Studio view mode (`er`), LOD zoom/pan & exports
│   │   ├── studio-dom.ts                 # Typed Studio DOM tree builder
│   │   ├── studio-sidebar.ts             # Sidebar explorer, top table bar & SQL templates
│   │   ├── studio-columns-popover.ts     # Column visibility, reordering & pin popover
│   │   ├── studio-export.ts              # Export dropdown & file download orchestration
│   │   ├── db-icons.ts                   # Engine SVG icons & select dropdown helpers
│   │   ├── connection-modal.ts           # Connection Manager Modal (multi-hop SSH, TLS/mTLS + probe fix, local drivers, auto-discovery)
│   │   ├── result-set-controller.ts      # Shared multi-result tab bar, Visual EXPLAIN Tree switcher, filtering & inline edit controller
│   │   ├── driver-manager-modal.ts       # Built-in & local Driver Manager Modal
│   │   ├── file-picker-modal.ts          # In-app file and folder picker modal
│   │   ├── studio-modals.ts              # Command Palette, Shortcuts, Create/Drop & modal types
│   │   ├── feedback-modal.ts             # In-app Feedback / Bug Report modal
│   │   ├── bind-params-modal.ts          # Studio bind-parameters wrapper delegating to shared-bind-params-modal.js
│   │   ├── danger-sql-modal.ts           # Destructive SQL confirmation modal
│   │   ├── data-import.ts                # CSV/TSV/JSON/NDJSON parser, mapper & coercer
│   │   ├── import-modal.ts               # File Import modal (grid staging, Postgres COPY streaming & chunked commit)
│   │   ├── saved-queries-modal.ts        # Saved Queries library modal
│   │   ├── query-history-drawer.ts       # Searchable Query History drawer
│   │   ├── value-inspector.ts            # Value & JSON Inspector drawer
│   │   ├── console.ts                    # CodeMirror 6 SQL & Redis console (default/Vim keymaps & custom shortcuts)
│   │   ├── console-tabs.ts               # Multi-Tab SQL Console state & persistence
│   │   ├── sql-params.ts                 # Thin re-export wrapper over src/shared-sql-params.js
│   │   ├── sql-safety.ts                 # Dangerous SQL statement detector (shared logic in src/shared-sql-safety.js)
│   │   ├── sql-column-filter.ts          # Column filter predicate builder & WHERE injector
│   │   ├── grid.ts                       # Virtualized data grid, wrapped multi-line rows, column reorder & inline batch staging
│   │   ├── grid-icons.ts                 # Data grid DOM helpers, SVG icons & popup clamping
│   │   ├── grid-data-ops.ts              # Grid filtering, sorting, clipboard paste & exporters
│   │   ├── grid-menus.ts                 # Context menus, bulk-fill, conditional highlighting & filter popovers
│   │   ├── grid-formatters.ts            # Cell coercion, window math & clipboard helpers
│   │   ├── grid-selection.ts             # Multi-cell selection & aggregate math
│   │   ├── select-editability.ts         # Single-table SELECT inline editability analyzer
│   │   ├── transaction-toolbar.ts        # Transaction & Auto-Commit status bar
│   │   ├── schema-inspector.ts           # Visual Table Designer & migration confirmation
│   │   ├── schema-ddl.ts                 # DDL syntax highlighter & dialect type catalogs
│   │   ├── theme.ts                      # Dark & Light Mode stylesheet
│   │   ├── theme-grid.ts                 # Grid, pinned column, conditional highlight, filter & inspector styles
│   │   └── theme-modals.ts               # Table designer, ER diagram, EXPLAIN SVG, SSH modal & combobox styles
│   ├── panel/                            # Docked Right Sidebar Panel
│   │   ├── panel.html                    # Side Panel DOM markup
│   │   ├── panel.css                     # Side Panel Dark & Light Mode stylesheet
│   │   ├── panel-app.js                  # Side Panel composition root & shared state
│   │   ├── panel-core.js                 # Side Panel SQL, clipboard paste, migration & feedback helpers
│   │   ├── panel-utils.js                # Brand SVGs, RPC bridge, clipboard & virtual window
│   │   ├── panel-selection.js            # Side Panel multi-cell selection & aggregates
│   │   ├── panel-connection-form.js      # Connection form, URI parser, TLS probe actions & .env / Docker Compose / .db discovery
│   │   ├── panel-explorer.js             # Schema explorer tree & context menus
│   │   ├── panel-data-grid.js            # Virtualized data grid, wrapped rows, table display state, staging & inspector
│   │   ├── panel-cm.js                   # CodeMirror 6 SQL adapter, Vim/shortcut keymaps & schema completion for Side Panel
│   │   ├── panel-sql-tabs.js             # Side Panel multi-tab SQL state & persistence
│   │   ├── panel-result-sets.js          # Side Panel multi-result & Visual EXPLAIN Tree tab controller
│   │   ├── panel-sql.js                  # SQL runner, bind parameters, multi-EXPLAIN, autocomplete & history
│   │   ├── panel-structure.js            # Visual Table Designer & type combobox
│   │   └── panel-feedback-palette.js     # Command Palette, confirmation modals & shortcuts
│   └── worker/
│       ├── index.ts                      # Trusted Worker entry & DAG lifecycle
│       ├── tx-ownership.ts               # Serialized cross-panel transaction ownership lock controller
│       ├── worker-utils.ts               # Sanitization, serialized queues, IPC cap & backup
│       ├── ai-client.ts                  # Multi-provider AI HTTP client (FIM, chat & statement edits), URL guard, secret blocklist & telemetry
│       ├── ai-config-store.ts            # Dual-role AI settings resolver, per-role host-pinned keyring & v1.2.1 migration
│       ├── ai-nep.ts                     # Mini-NEP statement windowing, shadow healing, token diff & edit filtering
│       ├── ai-sql-context.ts             # 3-tier schema pruning, history masking, EXPLAIN & Fix prompt/parsers
│       ├── sql-grammar.ts                # Bundled node-sql-parser AST grammar validation for PG/CockroachDB, MySQL/MariaDB, SQLite/LibSQL/D1 & MSSQL
│       ├── schema-catalog.ts             # Unified SchemaCatalog (single-flight + 1-queued follow-up, epoch fence, stale-while-error)
│       ├── copy-import-registry.ts       # Bounded PostgreSQL COPY FROM STDIN import session registry & idle reaper
│       ├── table-display-state-store.ts  # Bounded LRU store (200 tables / <= 300 KB) & delta broadcaster for grid display state
│       ├── er-layout-state-store.ts      # Bounded LRU store (50 schemas / <= 150 KB) for persisted ER diagram coordinates
│       ├── ssh-host-key-challenge-store.ts # Server-minted single-use SSH host-key challenge store (TTL 5m, max 64)
│       ├── rpc-ai.ts                     # Dual-role AI completion, statement edits, EXPLAIN/Fix, keyring & stats RPCs
│       ├── rpc-connections.ts            # Connection, SSH host-key resolution, workspace discovery & local driver RPCs
│       ├── rpc-data-schema.ts            # Schema catalog, ER graph, data browse/mutation, COPY import & UI state RPCs
│       ├── rpc-query-tx.ts               # Query execution, Visual EXPLAIN parsing, cancellation, history & transactions
│       ├── session-manager.ts            # Connection profile storage, lazy driver loader & secrets vault manager
│       ├── discovery.ts                  # Bounded .env parser & async BFS SQLite scanner
│       └── docker-compose-discovery.ts   # Hybrid Docker CLI & static Compose YAML discovery parser
├── tests/                                # Local gitignored Vitest unit, property-based & E2E suites (excluded from release payload)
└── vitest.config.ts                      # Local gitignored Vitest & v8 coverage configuration
```

---

## Verification Pipeline & Test Suites

Datanoa validates bundle limits/CSP rules (including a 25,000,000-byte total workspace payload budget and `< 1 MiB` per vendor file), strict TypeScript types, Orca manifest/frame loading, and Vitest test coverage via:

```bash
# Run full static & bundle verification (build + size + typecheck + validate + check)
npm run verify

# Run all Vitest test suites
npm test

# Run Vitest with v8 coverage report
npm run test:coverage

# Run tests through Orca CLI plugin test harness
orca plugin test .

# Or run individual build/check stages
npm run build
npm run size
npm run typecheck
npm run validate
npm run check
```

---

## Coding & Quality Standards

Before opening a Pull Request, please ensure your changes satisfy all repository invariants:

1. **Strict TypeScript Hygiene:** Zero `: any`, zero `as any`, and zero `!` non-null assertions across `src/` and `vendor/*.d.ts`.
2. **CSP & Bundle Limits:** No `eval(`, no `new Function(`, no obfuscated/escaped non-ASCII runs in worker bundles, zero `<foreignObject>` in SVG output, zero `.ts` imports or `node:` built-ins in `src/shared-*.js` and `src/panel/*.js`, and every file under `vendor/` must remain strictly `< 1 MiB`.
3. **Dark & Light Theme Parity:** Always use `--orca-*` CSS custom properties with clean dark fallbacks (`#000000`) and verify dark mode, `html.light`, and `body.light`. Never override `:root` `--orca-*` host tokens.
4. **Secret Redaction:** Never log or persist database passwords, bearer tokens, per-hop SSH secrets, or unmasked connection URIs outside `orca.secrets`.
5. **Verification Gate:** Run `npm run verify` and `npm test` and confirm `0` errors across build, size (`<= 25 MB`), typecheck, `orca plugin validate`, `orca plugin check`, and all test suites.
