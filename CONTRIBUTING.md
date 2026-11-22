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

# 3. Bundle vendor drivers (pg, mysql2, CodeMirror 6) into vendor/ (< 1 MiB & CSP audit)
npm run build

# 4. Run the full verification pipeline (build + size + typecheck + validate + check)
npm run verify

# 5. Hot-load the plugin into your local Orca Desktop instance
orca plugin dev load .
```

> **Note on "Install plugin -> Local folder" in Orca Desktop:**
> All runtime dependencies (`vendor/pg.js`, `vendor/mysql2.js`, `vendor/codemirror.js`) are pre-bundled into `vendor/` (`~1.14 MB` total; total packaged workspace payload `<= 5,000,000` bytes). However, Orca Desktop's **Local folder** installer scans the entire folder on disk (including untracked directories) against a 50 MiB / file-count limit. Before installing from a local checkout via **Install plugin -> Local folder** (or inspecting with `orca plugin inspect .`), remove dev-only directories (`rm -rf node_modules .serena .orca`) or use `orca plugin dev load .`.

---

## Architecture & Module Layout

Datanoa is organized into deep, single-responsibility modules across four layers:

```text
datanoa/
├── assets/
│   └── icon.png                          # 256x256 plugin icon
├── build/
│   ├── build-askpass.mjs                 # Deterministic Windows PE SSH askpass builder & verifier
│   ├── bundle-drivers.mjs                # esbuild bundler + < 1 MiB & CSP static auditor
│   ├── check-package-size.mjs            # 5,000,000-byte total & < 1 MiB vendor ceiling guard
│   └── ssh-askpass/
│       └── askpass.cs                    # Minimal zero-shell Windows SSH_ASKPASS source
├── images/                               # 1600x1000 (16:10) showcase screenshots & cover
├── src/
│   ├── protocol.ts                       # Canonical IPC contracts & JsonValue payload sanitizer
│   ├── shared-constants.ts               # Shared version, RPC timeout, chunk & storage key constants
│   ├── assets/
│   │   ├── geist-font.js                 # Shared embedded WOFF2 data URI for Studio & Side Panel
│   │   ├── geist-font.d.ts               # TypeScript companion declaration for geist-font.js
│   │   └── logo.ts                       # Embedded 64x64 brand logo data URI
│   ├── drivers/
│   │   ├── index.ts                      # 9-engine driver registry
│   │   ├── driver-manager.ts             # BYOD local driver manager with SHA-256 & in-memory hooks
│   │   ├── common/
│   │   │   ├── byod-templates.ts         # Canonical BYOD starter adapter templates
│   │   │   ├── connection-uri.ts         # Multi-dialect URI parser & Cloud Auto-SSL detector
│   │   │   ├── driver.ts                 # Shared driver contracts, abort signal, test & tx helpers
│   │   │   ├── engine-catalog.ts         # 9-engine metadata & capability definitions
│   │   │   ├── schema.ts                 # Dialect catalog introspection, DDL export & TableDetailsCache
│   │   │   ├── sql-credentials.ts        # Dialect-aware credential & secret literal scanner
│   │   │   ├── sql-lexer.ts              # Dialect-aware SQL splitter, comment stripper & guards
│   │   │   ├── sql-formatter.ts          # Dialect SQL formatter & multi-format data exporters
│   │   │   ├── sql-migration.ts          # Visual table structure planner & 12-step SQLite rebuild
│   │   │   ├── sql-tools.ts              # Backward-compatible barrel re-export
│   │   │   ├── ssh-askpass-win-bin.ts    # Embedded SHA-256-verified Windows PE askpass binary
│   │   │   ├── tls-and-tunnel.ts         # TLS/mTLS options, IPv4 bridge & SSH tunnel manager
│   │   │   └── update-builder.ts         # Parameterized DML, PK reload, chunked INSERT & pagination
│   │   ├── sqlite/                       # node:sqlite driver + isolated worker_threads runner
│   │   ├── postgres/                     # PostgreSQL & CockroachDB driver + Supabase IPv4 bridge
│   │   ├── mysql/                        # MySQL & MariaDB pooled driver
│   │   ├── clickhouse/                   # ClickHouse HTTP(S) JSONCompact driver
│   │   ├── redis/                        # Zero-dependency TCP/TLS RESP2 client
│   │   ├── libsql/                       # Turso / LibSQL Hrana v2 HTTP pipeline client
│   │   └── d1/                           # Cloudflare D1 pure-TS HTTP REST client (SQLite-compatible)
│   ├── editor/                           # Isolated Custom Editor (.sql / .datanoa)
│   │   ├── index.ts                      # Fullscreen Studio controller & IPC orchestration
│   │   ├── document-meta.ts              # .datanoa metadata header & warm-cache snapshot helpers
│   │   ├── studio-dom.ts                 # Typed Studio DOM tree builder (StudioDomRefs)
│   │   ├── studio-sidebar.ts             # Sidebar explorer, horizontal topbar & SQL template builders
│   │   ├── studio-columns-popover.ts     # Column visibility & pin popover
│   │   ├── studio-export.ts              # Studio export dropdown & multi-format download orchestration
│   │   ├── db-icons.ts                   # 9-engine + BYOD brand SVG icons & select dropdown helpers
│   │   ├── connection-modal.ts           # 9-Engine Connection Manager Modal (SSH, TLS/mTLS, BYOD)
│   │   ├── driver-manager-modal.ts       # Built-in & BYOD Local Driver Manager Modal
│   │   ├── studio-modals.ts              # Command Palette, Shortcuts, Create/Drop & modal base types
│   │   ├── feedback-modal.ts             # Privacy-safe in-app Feedback / Bug Report modal
│   │   ├── bind-params-modal.ts          # Interactive SQL Bind Parameters modal & live preview
│   │   ├── danger-sql-modal.ts           # Dangerous SQL execution guard modal (PROD/STAGING aware)
│   │   ├── data-import.ts                # Pure CSV/TSV/JSON/NDJSON import parser, mapper & coercer
│   │   ├── import-modal.ts               # File Import modal (grid staging & chunked resumable commit)
│   │   ├── saved-queries-modal.ts        # Saved Queries / SQL Snippets library modal
│   │   ├── query-history-drawer.ts       # Searchable Query History slide-out drawer
│   │   ├── value-inspector.ts            # Collapsible Value & JSON Inspector drawer
│   │   ├── console.ts                    # CodeMirror 6 SQL & Redis console, find/replace & folding
│   │   ├── console-tabs.ts               # Multi-Tab SQL Console state & persistence manager
│   │   ├── sql-params.ts                 # Dialect-aware SQL bind parameter extractor & binder
│   │   ├── sql-safety.ts                 # Lexer-based dangerous SQL statement detector
│   │   ├── sql-column-filter.ts          # Column header filter predicate builder & WHERE injector
│   │   ├── grid.ts                       # Virtualized data grid & inline batch staging
│   │   ├── grid-icons.ts                 # Data grid DOM helpers, SVG icons & popup clamping
│   │   ├── grid-data-ops.ts              # Pure grid filtering, sorting, Smart Paste & exporters
│   │   ├── grid-menus.ts                 # Cell/header/canvas context menus, bulk-fill & filter popovers
│   │   ├── grid-formatters.ts            # Pure cell coercion, window math & clipboard helpers
│   │   ├── grid-selection.ts             # Rectangular multi-cell selection & live aggregate math
│   │   ├── select-editability.ts         # Single-table SELECT inline editability analyzer
│   │   ├── transaction-toolbar.ts        # Sticky Transaction & Auto-Commit status bar
│   │   ├── schema-inspector.ts           # Visual Table Structure Designer & migration confirmation
│   │   ├── schema-ddl.ts                 # Multi-line DDL syntax highlighter & dialect type catalogs
│   │   ├── theme.ts                      # Assembled Dark & Light Mode stylesheet
│   │   ├── theme-grid.ts                 # Grid, pinned column, filter & value inspector styles
│   │   └── theme-modals.ts               # Schema designer, combobox & modal styles
│   ├── panel/                            # Docked Right Sidebar Panel
│   │   ├── panel.html                    # Side Panel DOM markup
│   │   ├── panel.css                     # Side Panel Dark & Light Mode stylesheet
│   │   ├── panel-app.js                  # Side Panel composition root & shared state orchestrator
│   │   ├── panel-core.js                 # Pure Side Panel SQL, Smart Paste, migration & feedback helpers
│   │   ├── panel-utils.js                # Brand SVGs, RPC bridge, clipboard & virtual table window engine
│   │   ├── panel-selection.js            # Side Panel rectangular cell selection & aggregates
│   │   ├── panel-connection-form.js      # Connection form, URI parser & workspace discovery
│   │   ├── panel-explorer.js             # Schema explorer tree & object context menus
│   │   ├── panel-data-grid.js            # Virtualized data grid, staging, Smart Paste & inspector
│   │   ├── panel-sql.js                  # SQL runner, autocomplete, EXPLAIN & history
│   │   ├── panel-structure.js            # Visual Table Structure Designer & type combobox
│   │   └── panel-feedback-palette.js     # Command Palette, confirmation modals & shortcuts
│   └── worker/
│       ├── index.ts                      # Trusted Worker composition root
│       ├── worker-utils.ts               # Sanitization, serialized queues, IPC shield & backup helpers
│       ├── rpc-connections.ts            # Connection, workspace discovery & BYOD driver RPCs
│       ├── rpc-data-schema.ts            # Schema introspection & data browse/mutation RPCs
│       ├── rpc-query-tx.ts               # Query execution, cancellation, history & transaction RPCs
│       ├── session-manager.ts            # Connection profile storage & secrets:own vault manager
│       └── discovery.ts                  # Bounded .env parser & async BFS SQLite file scanner
```

---

## Verification Pipeline

Datanoa validates bundle limits/CSP rules (including a 5,000,000-byte total workspace payload budget and `< 1 MiB` per vendor file), strict TypeScript types, and Orca manifest/frame loading via:

```bash
# Run full verification (build + size + typecheck + validate + check)
npm run verify

# Or run individual checks
npm run build
node build/build-askpass.mjs --check
npm run size
npm run typecheck
npm run validate
npm run check
```

---

## Coding & Quality Standards

Before opening a Pull Request, please ensure your changes satisfy all repository invariants:

1. **Strict TypeScript Hygiene:** Zero `: any`, zero `as any`, and zero `!` non-null assertions across `src/`.
2. **CSP & Bundle Limits:** No `eval(`, no `new Function(`, no obfuscated/escaped non-ASCII runs in worker bundles, and every file under `vendor/` must remain strictly `< 1 MiB`.
3. **Dark & Light Theme Parity:** Always use `--orca-*` CSS custom properties with clean dark fallbacks (`#000000`) and verify both dark mode and `html.light`. Never override `:root` `--orca-*` host tokens.
4. **Secret Redaction:** Never log or persist database passwords, bearer tokens, or unmasked connection URIs outside `orca.secrets`.
5. **Verification Gate:** Run `npm run verify` and confirm `0` errors across build, size (`<= 5 MB`), typecheck, `orca plugin validate`, and `orca plugin check`.
