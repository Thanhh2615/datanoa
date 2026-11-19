# Contributing to Datanoa

Thank you for helping improve **Datanoa** — the Multi-Engine OLED Database Studio for **Orca** (`>=1.4.248`)!

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

# 4. Run the full verification pipeline (build + typecheck + validate + check + 385+ tests)
npm run verify

# 5. Hot-load the plugin into your local Orca Desktop instance
orca plugin dev load .
```

---

## Architecture & Module Layout

Datanoa is organized into deep, single-responsibility modules across four layers:

```text
datanoa/
├── assets/
│   ├── fonts/Geist-Variable.woff2        # Bundled Orca Geist variable font (SIL OFL-1.1)
│   └── icon.png                          # 256x256 plugin icon
├── build/
│   └── bundle-drivers.mjs                # esbuild bundler + < 1 MiB & CSP static auditor
├── images/                               # 1600x1000 (16:10) showcase screenshots & cover
├── src/
│   ├── protocol.ts                       # Canonical IPC contracts & JsonValue payload sanitizer
│   ├── assets/
│   │   ├── geist-font.ts                 # Embedded WOFF2 data URI for isolated iframe parity
│   │   └── logo.ts                       # Embedded 64x64 brand logo data URI
│   ├── drivers/
│   │   ├── index.ts                      # 8-engine driver registry
│   │   ├── common/
│   │   │   ├── connection-uri.ts         # Multi-dialect URI parser & Cloud Auto-SSL detector
│   │   │   ├── driver.ts                 # Shared IDatabaseDriver / IDatabaseSession contracts
│   │   │   ├── schema.ts                 # Dialect catalog introspection & TableDetailsCache
│   │   │   ├── sql-lexer.ts              # Dialect-aware SQL splitter, comment stripper & guards
│   │   │   ├── sql-formatter.ts          # Dialect SQL formatter & multi-format data exporters
│   │   │   ├── sql-migration.ts          # Visual table structure planner & 12-step SQLite rebuild
│   │   │   ├── sql-tools.ts              # Backward-compatible barrel re-export
│   │   │   └── update-builder.ts         # Parameterized DML & pagination SQL builder
│   │   ├── sqlite/                       # node:sqlite driver + isolated worker_threads runner
│   │   ├── postgres/                     # PostgreSQL & CockroachDB driver + Supabase IPv4 bridge
│   │   ├── mysql/                        # MySQL & MariaDB pooled driver
│   │   ├── clickhouse/                   # ClickHouse HTTP(S) JSONCompact driver
│   │   ├── redis/                        # Zero-dependency TCP/TLS RESP2 client
│   │   └── libsql/                       # Turso / LibSQL Hrana v2 HTTP pipeline client
│   ├── editor/                           # Isolated Custom Editor (.sql / .datanoa)
│   │   ├── index.ts                      # Fullscreen Studio controller & IPC orchestration
│   │   ├── db-icons.ts                   # 8-engine vector SVG icon factory & pure DOM helpers
│   │   ├── connection-modal.ts           # 8-Engine Connection Manager Modal
│   │   ├── studio-modals.ts              # Command Palette, Shortcuts, Create/Drop & Feedback modals
│   │   ├── console.ts                    # CodeMirror 6 SQL & Redis console + smart autocomplete
│   │   ├── grid.ts                       # 60fps virtualized data grid & inline batch staging
│   │   ├── grid-formatters.ts            # Pure cell coercion, window math & clipboard helpers
│   │   ├── grid-selection.ts             # Rectangular multi-cell selection & live aggregate math
│   │   ├── schema-inspector.ts           # Visual Table Structure Designer & migration confirmation
│   │   ├── schema-ddl.ts                 # Multi-line DDL syntax highlighter & dialect type catalogs
│   │   ├── theme.ts                      # Assembled True OLED (#000000) & Light Mode stylesheet
│   │   ├── theme-grid.ts                 # Grid, pinned column, filter & value inspector styles
│   │   └── theme-modals.ts               # Schema designer, combobox & modal styles
│   ├── panel/                            # Docked Right Sidebar Panel
│   │   ├── panel.html                    # Side Panel DOM markup & controller
│   │   ├── panel.css                     # Side Panel True OLED & Light Mode stylesheet
│   │   └── panel-core.js                 # Pure Side Panel SQL, migration & feedback helpers
│   └── worker/
│       ├── index.ts                      # Trusted Worker IPC request handlers
│       ├── session-manager.ts            # Connection profile storage & secrets:own vault manager
│       └── discovery.ts                  # Bounded .env parser & async BFS SQLite file scanner
└── test/
    ├── drivers/                          # All 8 database engine wire-protocol & unit suites
    ├── worker/                           # URI parser, SQL tools & trusted-worker RPC suites
    └── e2e/                              # Full Studio, Side Panel & Gate A static compiler tests
```

---

## Running the Test Suite (`385+` Tests)

Datanoa enforces a comprehensive verification suite covering all 8 database drivers, worker IPC contracts, SQL lexing/formatting/migration planners, and full DOM E2E interactions:

```bash
# Run all 18 test suites (385+ tests)
npm test

# Run only database driver tests (SQLite, Postgres, MySQL, MariaDB, CockroachDB, ClickHouse, Redis, LibSQL)
npm run test:drivers

# Run only Studio & Side Panel E2E + Gate A static script compilation tests
npm run test:e2e

# Run strict TypeScript typechecking + Orca manifest/code validation
npm run typecheck
npm run validate
npm run check
```

---

## Coding & Quality Standards

Before opening a Pull Request, please ensure your changes satisfy all repository invariants:

1. **Strict TypeScript Hygiene:** Zero `: any`, zero `as any`, and zero `!` non-null assertions across `src/` and `test/`.
2. **CSP & Bundle Limits:** No `eval(`, no `new Function(`, and every file under `vendor/` must remain strictly `< 1 MiB`.
3. **True OLED & Light Theme Parity:** Always use `--orca-*` CSS custom properties with `#000000` OLED dark fallbacks and test both dark mode and `html.light`. Never override `:root` `--orca-*` host tokens.
4. **Secret Redaction:** Never log or persist database passwords, bearer tokens, or unmasked connection URIs outside `orca.secrets`.
5. **Verification Gate:** Run `npm run verify` and confirm `0` errors across build, typecheck, `orca plugin validate`, `orca plugin check`, and `vitest`.
