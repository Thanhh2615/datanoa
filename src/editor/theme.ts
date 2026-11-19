// src/editor/theme.ts
// True Orca OLED (#000000) + Light Mode design tokens and DataGrip Studio styles for Datanoa Studio.
// Reads Orca host-injected --orca-* variables directly without overriding :root host tokens.

import { GEIST_FONT_DATA_URI } from '../assets/geist-font.js'

export const EDITOR_STYLE = `
  @font-face {
    /* impeccable-disable-next-line overused-font -- Native Orca Desktop Geist variable font required for host parity */
    font-family: 'Geist';
    src: url('${GEIST_FONT_DATA_URI}') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    font-display: block;
  }

  :root {
    --bg: var(--orca-background, #000000);
    --surface: var(--orca-editor-surface, #0a0a0a);
    --card: var(--orca-secondary, #0f0f0f);
    --raised: var(--orca-secondary, #141414);
    --hover: var(--orca-accent, #1a1a1a);
    --border: var(--orca-border, #1f1f1f);
    --border-strong: var(--orca-input, #2a2a2a);
    --input-bg: #080808;
    --input-border: var(--orca-input, #2a2a2a);
    --text: var(--orca-foreground, #e6e6e6);
    --muted: var(--orca-muted-foreground, var(--orca-foreground-muted, #a3a3a3));
    --muted-dim: #8c8c8c;
    --primary: var(--orca-primary, #e6e6e6);
    --primary-fg: var(--orca-primary-foreground, #000000);
    --accent: var(--orca-accent, #38bdf8);
    --danger: var(--orca-destructive, #f87171);
    --ok: #4ade80;
    --warn: #fbbf24;
    --info: #38bdf8;
    --sel-fill: rgba(56, 189, 248, 0.065);
    --sel-edge: rgba(56, 189, 248, 0.42);
    --sel-focus: rgba(56, 189, 248, 0.62);
    --btn-bg: #171717;
    --btn-border: #303030;
    --btn-hover-bg: #242424;
    --btn-hover-border: #474747;
    --btn-disabled-bg: #0d0d0d;
    --btn-disabled-border: #1e1e1e;
    --btn-disabled-fg: #595959;
    --menu-shadow: 0 10px 28px rgba(0, 0, 0, 0.65);
    --radius: var(--orca-radius, 6px);
    --ui-font: var(--app-font-family, 'Geist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    --mono-font: var(--orca-font-mono, 'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace);

    /* stablyai.orca-oled-theme syntax palette */
    --cm-keyword: #c7a8ff;
    --cm-string: #9ee39e;
    --cm-number: #ffb070;
    --cm-function: #7cc4ff;
    --cm-type: #6fe0d0;
    --cm-comment: #8c8c8c;
    --cm-operator: #d4d4d4;
    color-scheme: dark;
  }

  html.light, body.light {
    --bg: var(--orca-background, #ffffff);
    --surface: var(--orca-editor-surface, #f8fafc);
    --card: var(--orca-secondary, #f6f8fa);
    --raised: var(--orca-secondary, #eef2f6);
    --hover: var(--orca-accent, #eaeef2);
    --border: var(--orca-border, #d0d7de);
    --border-strong: var(--orca-input, #b6c0cc);
    --input-bg: #ffffff;
    --input-border: var(--orca-input, #cbd5e1);
    --text: var(--orca-foreground, #0f172a);
    --muted: var(--orca-muted-foreground, var(--orca-foreground-muted, #475569));
    --muted-dim: #64748b;
    --primary: var(--orca-primary, #0f172a);
    --primary-fg: var(--orca-primary-foreground, #ffffff);
    --accent: var(--orca-accent, #0969da);
    --danger: var(--orca-destructive, #b91c1c);
    --ok: #15803d;
    --warn: #b45309;
    --info: #0369a1;
    --sel-fill: rgba(3, 105, 161, 0.065);
    --sel-edge: rgba(3, 105, 161, 0.48);
    --sel-focus: rgba(3, 105, 161, 0.65);
    --btn-bg: #f1f5f9;
    --btn-border: #cbd5e1;
    --btn-hover-bg: #e2e8f0;
    --btn-hover-border: #94a3b8;
    --btn-disabled-bg: #f1f5f9;
    --btn-disabled-border: #e2e8f0;
    --btn-disabled-fg: #94a3b8;
    --menu-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);

    --cm-keyword: #7c3aed;
    --cm-string: #15803d;
    --cm-number: #c2410c;
    --cm-function: #0369a1;
    --cm-type: #0f766e;
    --cm-comment: #64748b;
    --cm-operator: #334155;
    color-scheme: light;
  }

  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font: 12.5px/1.45 var(--ui-font);
    letter-spacing: 0.01em;
    box-sizing: border-box;
    caret-color: var(--primary);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  *, *::before, *::after {
    box-sizing: inherit;
  }

  ::selection {
    background: rgba(56, 189, 248, 0.28);
    color: var(--text);
  }

  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  ::-webkit-scrollbar-track {
    background: transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: 3px;
  }

  ::-webkit-scrollbar-thumb:hover {
    background: var(--muted-dim);
  }

  button, input, select, textarea {
    font: inherit;
    color: inherit;
  }

  :focus-visible,
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  .datanoa-combo-item:focus-visible {
    outline: 2px solid var(--info);
    outline-offset: -1px;
  }

  :focus:not(:focus-visible) {
    outline: none;
  }

  svg {
    flex-shrink: 0;
    display: block;
  }

  .datanoa-editor-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: var(--bg);
    color: var(--text);
    position: relative;
  }

  /* Top Studio Toolbar */
  .datanoa-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 40px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }

  .datanoa-sidebar-toggle {
    display: inline-flex;
    width: 26px;
    padding: 0;
    justify-content: center;
    flex-shrink: 0;
  }

  .datanoa-brand-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: 600;
    font-size: 12.5px;
    letter-spacing: -0.01em;
    color: var(--text);
    padding-right: 8px;
    border-right: 1px solid var(--border);
    white-space: nowrap;
  }

  .datanoa-brand-logo {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    border: 1px solid var(--btn-border);
    background: #ffffff;
    padding: 1px;
    object-fit: contain;
    display: block;
    flex-shrink: 0;
  }

  .datanoa-conn-cluster {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .datanoa-db-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 5px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    flex-shrink: 0;
  }

  .datanoa-env-pill {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    border: 1px solid var(--border);
    white-space: nowrap;
  }

  .datanoa-env-pill.env-dev {
    color: var(--info);
    border-color: rgba(56, 189, 248, 0.4);
    background: rgba(56, 189, 248, 0.12);
  }

  .datanoa-env-pill.env-staging {
    color: var(--warn);
    border-color: rgba(251, 191, 36, 0.4);
    background: rgba(251, 191, 36, 0.12);
  }

  .datanoa-env-pill.env-prod {
    color: var(--danger);
    border-color: rgba(248, 113, 113, 0.45);
    background: rgba(248, 113, 113, 0.14);
  }

  .datanoa-ro-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--warn);
    border: 1px solid rgba(251, 191, 36, 0.4);
    background: rgba(251, 191, 36, 0.1);
    white-space: nowrap;
  }

  .datanoa-btn-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .datanoa-btn {
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    height: 26px;
    padding: 0 9px;
    border-radius: var(--radius);
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    user-select: none;
    white-space: nowrap;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
  }

  .datanoa-btn:hover:not(:disabled) {
    background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border);
  }

  .datanoa-btn:disabled {
    opacity: 1;
    background: var(--btn-disabled-bg);
    border-color: var(--btn-disabled-border);
    color: var(--btn-disabled-fg);
    cursor: not-allowed;
  }

  .datanoa-btn.active {
    background: var(--raised);
    border-color: var(--info);
    color: var(--info);
  }

  .datanoa-btn.is-loading {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: wait;
    pointer-events: none;
  }

  .datanoa-btn-sm {
    height: 23px;
    padding: 0 8px;
  }

  .datanoa-btn-primary {
    background: var(--primary);
    color: var(--primary-fg);
    border-color: var(--primary);
    font-weight: 600;
  }

  .datanoa-btn-primary:hover:not(:disabled) {
    background: var(--primary);
    border-color: var(--primary);
    opacity: 0.88;
  }

  .datanoa-btn-primary:disabled {
    opacity: 1;
    background: var(--btn-disabled-bg);
    border-color: var(--btn-disabled-border);
    color: var(--btn-disabled-fg);
    cursor: not-allowed;
  }

  .datanoa-btn-danger {
    color: var(--danger);
    border-color: rgba(248, 113, 113, 0.4);
    background: rgba(248, 113, 113, 0.08);
  }

  .datanoa-btn-danger:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.18);
    border-color: var(--danger);
  }

  .datanoa-btn-danger:disabled {
    opacity: 1;
    background: var(--btn-disabled-bg);
    border-color: var(--btn-disabled-border);
    color: var(--btn-disabled-fg);
    cursor: not-allowed;
  }

  .datanoa-select {
    font: inherit;
    font-size: 12px;
    height: 26px;
    padding: 0 8px;
    border-radius: var(--radius);
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    cursor: pointer;
    min-width: 155px;
    max-width: 240px;
  }

  .datanoa-select-sm {
    height: 23px;
    min-width: 112px;
    max-width: 165px;
    padding: 0 6px;
  }

  .datanoa-select:focus {
    border-color: var(--info);
  }

  /* Segmented Tabs Switcher */
  .datanoa-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
    padding: 2px;
    border-radius: var(--radius);
    background: var(--bg);
    border: 1px solid var(--border);
  }

  .datanoa-tab-btn {
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    height: 22px;
    padding: 0 10px;
    border-radius: 4px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .datanoa-tab-btn:hover {
    color: var(--text);
  }

  .datanoa-tab-btn.active {
    background: var(--raised);
    color: var(--text);
    border-color: var(--border);
    font-weight: 600;
  }

  /* Caution Strip (PROD / Read-Only) */
  .datanoa-caution-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 12px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    background: rgba(251, 191, 36, 0.08);
    color: var(--warn);
    flex-shrink: 0;
  }

  .datanoa-caution-strip.prod {
    background: rgba(248, 113, 113, 0.1);
    color: var(--danger);
  }

  /* Three-Pane Studio Body */
  .datanoa-workspace-body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    overflow: hidden;
    position: relative;
  }

  /* Left Schema Explorer Sidebar */
  .datanoa-sidebar {
    width: 220px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--surface);
    min-height: 0;
  }

  .datanoa-sidebar.collapsed {
    display: none !important;
  }

  /* Horizontal Top Table Switcher Bar (Mode 2 when Sidebar is collapsed) */
  .datanoa-table-topbar {
    display: none;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-width: 0;
    position: relative;
  }

  .datanoa-table-topbar.visible {
    display: flex;
  }

  .datanoa-topbar-filter-wrap {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }

  .datanoa-topbar-filter {
    width: 144px;
    height: 24px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .datanoa-topbar-filter:focus {
    border-color: var(--info);
  }

  .datanoa-topbar-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--card);
    border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .datanoa-topbar-nav-btn {
    width: 22px;
    height: 24px;
    padding: 0;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1;
  }

  .datanoa-topbar-nav-btn:hover {
    color: var(--text);
    background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border);
  }

  .datanoa-table-topbar-track {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
    padding: 2px 0;
    scroll-behavior: smooth;
  }

  .datanoa-table-topbar-track::-webkit-scrollbar {
    display: none;
  }

  .datanoa-topbar-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 9px;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    user-select: none;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }

  .datanoa-topbar-pill:hover {
    color: var(--text);
    background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border);
  }

  .datanoa-topbar-pill.active {
    background: rgba(56, 189, 248, 0.15);
    border-color: var(--info);
    color: var(--info);
    font-weight: 600;
  }

  .datanoa-topbar-pill-kind {
    font-size: 10px;
    font-weight: 600;
    opacity: 0.65;
    text-transform: uppercase;
  }

  .datanoa-topbar-all-btn {
    height: 24px;
    padding: 0 8px;
    flex-shrink: 0;
  }

  .datanoa-topbar-popover {
    position: fixed;
    z-index: 10040;
    width: 250px;
    max-height: 320px;
    overflow-y: auto;
    background: var(--raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--menu-shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-sidebar-header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .datanoa-search-input {
    width: 100%;
    height: 25px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .datanoa-search-input::placeholder {
    color: var(--muted-dim);
  }

  .datanoa-search-input:focus {
    border-color: var(--info);
  }

  .datanoa-sidebar-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 6px 0;
  }

  .datanoa-sidebar-group-title {
    padding: 6px 12px 4px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    display: flex;
    justify-content: space-between;
  }

  .datanoa-sidebar-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    height: 26px;
    padding: 0 12px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .datanoa-sidebar-item:hover {
    background: var(--hover);
  }

  .datanoa-sidebar-item.active {
    background: rgba(56, 189, 248, 0.14);
    color: var(--info);
    font-weight: 600;
  }

  .datanoa-sidebar-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1 1 auto;
    font-family: var(--ui-font);
    font-size: 12.5px;
    font-weight: 500;
    letter-spacing: 0.01em;
  }

  .datanoa-sidebar-item.active .datanoa-sidebar-item-name {
    font-weight: 600;
  }

  .datanoa-sidebar-item-kind {
    font-size: 12px;
    color: var(--muted);
    font-family: var(--mono-font);
    flex-shrink: 0;
  }

  /* Main Center View */
  .datanoa-main-view {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--bg);
  }

  .datanoa-sql-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }

  .datanoa-sql-area {
    flex: 0 0 34%;
    min-height: 80px;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    position: relative;
    background: var(--bg);
  }

  .datanoa-split-resizer {
    height: 5px;
    flex-shrink: 0;
    cursor: row-resize;
    background: var(--border);
    position: relative;
    transition: background 0.15s ease;
    user-select: none;
  }

  .datanoa-split-resizer::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 32px;
    height: 2px;
    border-radius: 1px;
    background: var(--muted-dim);
    opacity: 0.7;
  }

  .datanoa-split-resizer:hover,
  .datanoa-split-resizer.resizing {
    background: var(--info);
  }

  .datanoa-split-resizer:hover::after,
  .datanoa-split-resizer.resizing::after {
    background: var(--primary-fg);
    opacity: 1;
  }

  .datanoa-sql-area .cm-editor {
    height: 100%;
    width: 100%;
    max-width: 100%;
    font-family: var(--mono-font);
    font-size: 12.5px;
  }

  .datanoa-sql-area .cm-scroller {
    overflow: auto !important;
  }

  /* Query History Drawer */
  .datanoa-history-drawer {
    max-height: 175px;
    overflow-y: auto;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .datanoa-drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }

  .datanoa-history-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 5px 12px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
    font-size: 12px;
  }

  .datanoa-history-row:hover {
    background: var(--hover);
  }

  .datanoa-history-sql {
    font-family: var(--mono-font);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }

  .datanoa-history-meta {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* Sub-header Bar for Data Grid (Summary, Primary Actions & Pagination) */
  .datanoa-grid-subbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 5px;
    min-height: 30px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    font-size: 12px;
    color: var(--muted);
    flex-shrink: 0;
  }

  .datanoa-grid-subbar-left,
  .datanoa-grid-subbar-right {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .datanoa-grid-subbar-title {
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    margin-right: 4px;
  }

  .datanoa-page-info {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    padding: 0 2px;
  }

  /* DataGrip Grid Filter Toolbar */
  .datanoa-grid-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
    flex-shrink: 0;
  }

  .datanoa-filter-group {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 1 1 190px;
    min-width: 140px;
  }

  .datanoa-filter-label {
    font-size: 12px;
    font-weight: 600;
    font-family: var(--mono-font);
    color: var(--muted);
    white-space: nowrap;
  }

  .datanoa-filter-input {
    flex: 1 1 110px;
    min-width: 80px;
    height: 23px;
    padding: 0 7px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: var(--mono-font);
    font-size: 12px;
  }

  .datanoa-filter-input::placeholder {
    color: var(--muted-dim);
    font-family: var(--ui-font);
  }

  .datanoa-filter-input:focus {
    border-color: var(--info);
  }

  .datanoa-client-search {
    width: 150px;
    flex: 0 1 180px;
    min-width: 110px;
    height: 23px;
    padding: 0 7px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font-size: 12px;
  }

  .datanoa-client-search:focus {
    border-color: var(--info);
  }

  /* DML Preview Inline Drawer */
  .datanoa-dml-preview {
    max-height: 160px;
    overflow: auto;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }

  .datanoa-dml-pre {
    margin: 0;
    padding: 8px 12px;
    font-family: var(--mono-font);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .datanoa-grid-area {
    flex: 1 1 66%;
    overflow: hidden;
    position: relative;
    background: var(--bg);
    min-height: 0;
  }

  /* Virtualized Data Grid */
  .datanoa-grid-container {
    width: 100%;
    height: 100%;
    overflow: auto;
    position: relative;
  }

  .datanoa-grid-container:focus-visible {
    outline: 2px solid var(--info);
    outline-offset: -2px;
  }

  .datanoa-grid-table {
    border-collapse: separate;
    border-spacing: 0;
    width: max-content;
    font-size: 12px;
    table-layout: fixed;
    font-variant-numeric: tabular-nums;
    box-sizing: border-box;
  }

  .datanoa-grid-table.datanoa-grid-empty-table {
    min-width: 100%;
  }

  .datanoa-grid-table.datanoa-grid-empty-no-cols {
    width: 100%;
  }

  .datanoa-grid-table.datanoa-grid-empty-no-cols .datanoa-grid-empty-cell {
    border-right: 0;
    border-bottom: 0;
    padding: 44px 24px;
  }

  .datanoa-grid-table.transposed {
    min-width: 100%;
    table-layout: auto;
  }

  .datanoa-grid-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--card);
    border-bottom: 1px solid var(--border);
  }

  .datanoa-th {
    position: relative;
    height: 26px;
    padding: 0 8px;
    text-align: left;
    font-weight: 600;
    font-size: 12px;
    color: var(--muted);
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: var(--card);
    white-space: nowrap;
    overflow: visible;
    user-select: none;
    cursor: pointer;
    box-sizing: border-box;
  }

  .datanoa-th.datanoa-th-rownum {
    position: sticky;
    left: 0;
    z-index: 15;
    text-align: right;
    color: var(--muted-dim);
    cursor: pointer;
  }

  .datanoa-th.datanoa-th-rownum:hover {
    color: var(--text);
    background: var(--raised);
  }

  .datanoa-th:hover:not(.datanoa-th-rownum),
  .datanoa-th.sorted {
    color: var(--text);
    background: var(--raised);
  }

  .datanoa-th.datanoa-th-selected {
    color: rgba(186, 230, 253, 0.92);
    background: color-mix(in srgb, var(--info) 8%, var(--card));
  }

  html.light .datanoa-th.datanoa-th-selected {
    color: var(--info);
    background: color-mix(in srgb, var(--info) 9%, var(--card));
  }

  .datanoa-th-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .datanoa-th-rownum .datanoa-th-inner {
    justify-content: flex-end;
  }

  .datanoa-th-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-th-pin-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--info);
    font-size: 10px;
    opacity: 0.9;
  }

  .datanoa-col-select-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: var(--muted-dim);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .datanoa-th:hover .datanoa-col-select-btn,
  .datanoa-th.datanoa-th-selected .datanoa-col-select-btn,
  .datanoa-col-select-btn:focus-visible {
    opacity: 1;
  }

  .datanoa-col-select-btn:hover {
    background: var(--hover);
    border-color: var(--border-strong);
    color: var(--info);
  }

  .datanoa-th.datanoa-th-selected .datanoa-col-select-btn {
    color: var(--info);
  }

  .datanoa-th-row-label {
    position: sticky;
    left: 0;
    z-index: 5;
    background: var(--card);
    color: var(--text);
    font-weight: 600;
    min-width: 160px;
    max-width: 240px;
  }

  .datanoa-th-sort-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    color: var(--muted);
  }

  .datanoa-th.sorted .datanoa-th-sort-icon {
    color: var(--text);
  }

  .datanoa-resize-handle {
    position: absolute;
    right: -3px;
    top: 0;
    bottom: 0;
    width: 7px;
    cursor: col-resize;
    user-select: none;
    z-index: 12;
  }

  .datanoa-resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    background: transparent;
    transition: background 0.1s ease;
  }

  .datanoa-resize-handle:hover::after,
  .datanoa-resize-handle.resizing::after {
    background: var(--info);
  }

  .datanoa-tr {
    height: 22px;
    line-height: 21px;
    max-height: 22px;
    box-sizing: border-box;
  }

  .datanoa-tr.datanoa-tr-even {
    background: rgba(255, 255, 255, 0.02);
  }

  html.light .datanoa-tr.datanoa-tr-even {
    background: rgba(15, 23, 42, 0.02);
  }

  .datanoa-tr:hover {
    background: var(--hover);
  }

  .datanoa-tr.datanoa-row-selected {
    background: rgba(255, 255, 255, 0.028);
  }

  html.light .datanoa-tr.datanoa-row-selected {
    background: rgba(15, 23, 42, 0.03);
  }

  .datanoa-tr.datanoa-row-inserted,
  .datanoa-tr.datanoa-row-inserted:hover {
    background: rgba(74, 222, 128, 0.12);
  }

  .datanoa-tr.datanoa-row-deleted,
  .datanoa-tr.datanoa-row-deleted:hover {
    background: rgba(248, 113, 113, 0.14);
  }

  .datanoa-tr.datanoa-row-deleted .datanoa-td {
    text-decoration: line-through;
    color: var(--danger);
  }

  .datanoa-td {
    height: 22px;
    line-height: 21px;
    padding: 0 8px;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
    cursor: default;
    box-sizing: border-box;
    position: relative;
  }

  .datanoa-td.datanoa-cell-selected {
    outline: 1px solid var(--sel-focus);
    outline-offset: -1px;
    z-index: 2;
  }

  .datanoa-td.datanoa-cell-in-range {
    --sel-t: 0 0 0 0 transparent;
    --sel-r: 0 0 0 0 transparent;
    --sel-b: 0 0 0 0 transparent;
    --sel-l: 0 0 0 0 transparent;
    background: var(--sel-fill);
    box-shadow: var(--sel-t), var(--sel-r), var(--sel-b), var(--sel-l);
  }

  .datanoa-td.datanoa-cell-in-range.datanoa-cell-selected {
    background: rgba(56, 189, 248, 0.025);
    outline: 1px solid rgba(56, 189, 248, 0.5);
    outline-offset: -1px;
  }

  html.light .datanoa-td.datanoa-cell-in-range.datanoa-cell-selected {
    background: rgba(3, 105, 161, 0.03);
    outline: 1px solid rgba(3, 105, 161, 0.55);
  }

  .datanoa-td.datanoa-range-top {
    --sel-t: inset 0 1px 0 0 var(--sel-edge);
  }

  .datanoa-td.datanoa-range-right {
    --sel-r: inset -1px 0 0 0 var(--sel-edge);
  }

  .datanoa-td.datanoa-range-bottom {
    --sel-b: inset 0 -1px 0 0 var(--sel-edge);
  }

  .datanoa-td.datanoa-range-left {
    --sel-l: inset 1px 0 0 0 var(--sel-edge);
  }

  .datanoa-td.datanoa-cell-staged {
    background: rgba(56, 189, 248, 0.18);
    font-weight: 500;
  }

  .datanoa-td.datanoa-cell-match {
    background: rgba(251, 191, 36, 0.22);
  }

  .datanoa-td.datanoa-cell-match-active {
    background: rgba(251, 191, 36, 0.42);
    outline: 1.5px solid var(--warn);
    outline-offset: -1.5px;
    z-index: 3;
  }

  /* Pinned / Frozen Columns (strictly opaque color-mix in Dark OLED & Light modes) */
  .datanoa-col-pinned {
    position: sticky;
    z-index: 5;
    background: var(--bg);
  }

  .datanoa-tr.datanoa-tr-even .datanoa-col-pinned {
    background: color-mix(in srgb, var(--text) 2.5%, var(--bg));
  }

  html.light .datanoa-tr.datanoa-tr-even .datanoa-col-pinned {
    background: color-mix(in srgb, var(--text) 2.5%, var(--bg));
  }

  .datanoa-tr:hover .datanoa-col-pinned,
  html.light .datanoa-tr:hover .datanoa-col-pinned {
    background: color-mix(in srgb, var(--text) 7%, var(--bg));
  }

  .datanoa-tr.datanoa-row-selected .datanoa-col-pinned,
  html.light .datanoa-tr.datanoa-row-selected .datanoa-col-pinned {
    background: color-mix(in srgb, var(--info) 12%, var(--bg));
  }

  .datanoa-tr.datanoa-row-inserted .datanoa-col-pinned,
  html.light .datanoa-tr.datanoa-row-inserted .datanoa-col-pinned {
    background: color-mix(in srgb, var(--ok) 12%, var(--bg));
  }

  .datanoa-tr.datanoa-row-deleted .datanoa-col-pinned,
  html.light .datanoa-tr.datanoa-row-deleted .datanoa-col-pinned {
    background: color-mix(in srgb, var(--danger) 14%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-in-range,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-in-range {
    background: color-mix(in srgb, var(--info) 9%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-selected,
  .datanoa-td.datanoa-col-pinned.datanoa-cell-in-range.datanoa-cell-selected,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-selected,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-in-range.datanoa-cell-selected {
    background: color-mix(in srgb, var(--info) 12%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-staged,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-staged {
    background: color-mix(in srgb, var(--info) 20%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-match,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-match {
    background: color-mix(in srgb, var(--warn) 22%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-match-active,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-match-active {
    background: color-mix(in srgb, var(--warn) 42%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-saving,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-saving {
    background: color-mix(in srgb, var(--info) 24%, var(--bg)) !important;
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-conflict,
  html.light .datanoa-td.datanoa-col-pinned.datanoa-cell-conflict {
    background: color-mix(in srgb, var(--danger) 26%, var(--bg)) !important;
  }

  .datanoa-th.datanoa-col-pinned {
    position: sticky;
    z-index: 14;
    background: var(--card);
  }

  .datanoa-th.datanoa-col-pinned:hover,
  .datanoa-th.datanoa-col-pinned.sorted {
    background: var(--raised);
  }

  .datanoa-th.datanoa-col-pinned.datanoa-th-selected {
    background: color-mix(in srgb, var(--info) 16%, var(--card));
  }

  .datanoa-col-pinned-last {
    border-right: 1px solid var(--border-strong);
    box-shadow: 3px 0 6px -2px rgba(0, 0, 0, 0.35);
  }

  html.light .datanoa-col-pinned-last {
    box-shadow: 3px 0 6px -2px rgba(15, 23, 42, 0.14);
  }

  .datanoa-td.datanoa-cell-in-range.datanoa-col-pinned-last {
    box-shadow: var(--sel-t), var(--sel-r), var(--sel-b), var(--sel-l), 3px 0 6px -2px rgba(0, 0, 0, 0.35);
  }

  html.light .datanoa-td.datanoa-cell-in-range.datanoa-col-pinned-last {
    box-shadow: var(--sel-t), var(--sel-r), var(--sel-b), var(--sel-l), 3px 0 6px -2px rgba(15, 23, 42, 0.14);
  }

  /* Foreign Key Jump Badge inside FK cells */
  .datanoa-td.datanoa-td-has-fk {
    padding-right: 24px;
  }

  .datanoa-fk-badge {
    position: absolute;
    right: 3px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border-radius: 3px;
    border: 1px solid rgba(56, 189, 248, 0.35);
    background: rgba(56, 189, 248, 0.12);
    color: var(--info);
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.72;
    transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease;
  }

  .datanoa-td:hover .datanoa-fk-badge,
  .datanoa-fk-badge:hover,
  .datanoa-fk-badge:focus-visible {
    opacity: 1;
    background: rgba(56, 189, 248, 0.24);
    border-color: var(--info);
  }

  .datanoa-td.editing {
    padding: 0;
    background: var(--input-bg);
  }

  .datanoa-td-rownum {
    position: sticky;
    left: 0;
    z-index: 6;
    font-family: var(--mono-font);
    font-size: 12px;
    font-style: normal;
    color: var(--muted-dim);
    text-align: right;
    padding: 0 8px;
    background: var(--surface);
    user-select: none;
    cursor: pointer;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    box-sizing: border-box;
  }

  .datanoa-tr:hover .datanoa-td-rownum,
  html.light .datanoa-tr:hover .datanoa-td-rownum {
    background: color-mix(in srgb, var(--text) 7%, var(--surface));
  }

  .datanoa-tr.datanoa-row-selected .datanoa-td-rownum {
    color: var(--text);
    background: var(--raised);
  }

  .datanoa-td-rownum.row-selected,
  .datanoa-tr.datanoa-row-selected .datanoa-td-rownum.row-selected {
    color: rgba(147, 197, 253, 0.92);
    background: color-mix(in srgb, var(--info) 14%, var(--surface));
    font-weight: 600;
  }

  html.light .datanoa-td-rownum.row-selected,
  html.light .datanoa-tr.datanoa-row-selected .datanoa-td-rownum.row-selected {
    color: var(--info);
    background: color-mix(in srgb, var(--info) 12%, var(--surface));
  }

  .datanoa-tr.datanoa-row-inserted .datanoa-td-rownum {
    color: var(--ok);
    font-weight: 600;
    box-shadow: inset 3px 0 0 0 var(--ok);
    background: color-mix(in srgb, var(--ok) 12%, var(--surface));
  }

  .datanoa-row-badge {
    display: inline-block;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.03em;
    line-height: 14px;
    background: rgba(74, 222, 128, 0.18);
    color: var(--ok);
    border: 1px solid rgba(74, 222, 128, 0.42);
    vertical-align: middle;
  }

  .datanoa-tr.datanoa-row-deleted .datanoa-td-rownum {
    color: var(--danger);
    box-shadow: inset 3px 0 0 0 var(--danger);
    background: color-mix(in srgb, var(--danger) 14%, var(--surface));
  }

  .datanoa-inline-input {
    width: 100%;
    height: 100%;
    font: inherit;
    font-size: 12px;
    padding: 0 7px;
    margin: 0;
    border: 1.5px solid var(--info);
    background: var(--input-bg);
    color: var(--text);
    user-select: text;
    box-sizing: border-box;
  }

  /* Cell Value Types */
  .datanoa-cell-null {
    color: var(--muted-dim);
    font-style: italic;
  }

  .datanoa-grid-empty-cell {
    padding: 28px 16px;
    text-align: center;
    color: var(--muted);
    font-style: italic;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    box-sizing: border-box;
  }

  .datanoa-cell-numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: var(--mono-font);
  }

  .datanoa-cell-json {
    font-family: var(--mono-font);
    color: var(--info);
  }

  .datanoa-cell-text {
    color: var(--text);
  }

  .datanoa-cell-saving {
    background: rgba(56, 189, 248, 0.22) !important;
  }

  .datanoa-cell-conflict {
    background: rgba(248, 113, 113, 0.26) !important;
    animation: flash-conflict 0.9s ease-out;
  }

  @keyframes flash-conflict {
    0% { background: var(--danger); color: var(--primary-fg); }
    100% { background: rgba(248, 113, 113, 0.26); }
  }

  /* Dockable Bottom Value / JSON Inspector Drawer */
  .datanoa-value-inspector {
    border-top: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    max-height: 200px;
    overflow-y: auto;
  }

  .datanoa-value-inspector-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px;
    min-height: 0;
    overflow-y: auto;
  }

  .datanoa-value-textarea {
    width: 100%;
    min-height: 78px;
    max-height: 130px;
    padding: 7px 9px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font-family: var(--mono-font);
    font-size: 12px;
    line-height: 1.45;
    resize: vertical;
    user-select: text;
  }

  .datanoa-value-textarea:focus {
    border-color: var(--info);
  }

  /* Fixed Right-Click Context Menu (Escapes overflow ancestors) */
  .datanoa-context-menu {
    position: fixed;
    z-index: 9999;
    min-width: 196px;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    padding: 4px;
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: var(--raised);
    box-shadow: var(--menu-shadow);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-context-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 5px 9px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .datanoa-context-item:hover:not(:disabled) {
    background: var(--hover);
  }

  .datanoa-context-item:disabled {
    opacity: 1;
    color: var(--btn-disabled-fg);
    cursor: not-allowed;
  }

  .datanoa-context-item.danger {
    color: var(--danger);
  }

  .datanoa-context-sep {
    height: 1px;
    background: var(--border);
    margin: 2px 4px;
  }

  /* Schema Inspector View + Pinned Header + Scrollable Body */
  .datanoa-inspector-view {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0;
    background: var(--bg);
  }

  .datanoa-inspector-top-zone {
    flex: 0 0 auto;
    width: 100%;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    z-index: 5;
  }

  .datanoa-inspector-scroll-body {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 14px 20px 28px 20px;
  }

  .datanoa-inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 38px;
    margin: 0;
    padding: 7px 16px;
    background: var(--surface);
    flex-shrink: 0;
  }

  .datanoa-inspector-top-zone .datanoa-struct-validation-bar,
  .datanoa-inspector-top-zone .datanoa-struct-preview-drawer {
    margin: 0 16px 10px 16px;
    max-height: 185px;
    overflow-y: auto;
  }

  .datanoa-inspector-title {
    font-size: 15px;
    font-weight: 600;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .datanoa-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .datanoa-badge-pk {
    background: rgba(56, 189, 248, 0.16);
    color: var(--info);
    border: 1px solid rgba(56, 189, 248, 0.45);
  }

  .datanoa-badge-unique {
    background: rgba(74, 222, 128, 0.14);
    color: var(--ok);
    border: 1px solid rgba(74, 222, 128, 0.45);
  }

  .datanoa-badge-fk {
    background: rgba(251, 191, 36, 0.14);
    color: var(--warn);
    border: 1px solid rgba(251, 191, 36, 0.45);
  }

  .datanoa-section-title {
    font-size: 12.5px;
    font-weight: 600;
    margin: 16px 0 8px 0;
    color: var(--text);
  }

  .datanoa-ddl-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    margin-bottom: 16px;
    overflow: hidden;
  }

  .datanoa-ddl-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
    font-size: 12px;
    font-weight: 600;
  }

  .datanoa-ddl-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .datanoa-ddl-pre {
    margin: 0;
    padding: 12px;
    overflow-x: auto;
    font-family: var(--mono-font);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text);
    background: var(--bg);
  }

  .datanoa-ddl-kw { color: var(--cm-keyword); font-weight: 500; }
  .datanoa-ddl-str { color: var(--cm-string); }
  .datanoa-ddl-num { color: var(--cm-number); }
  .datanoa-ddl-cmt { color: var(--cm-comment); font-style: italic; }
  .datanoa-ddl-type { color: var(--cm-type); }

  .datanoa-matrix-scroll {
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 16px;
    background: var(--card);
  }

  .datanoa-matrix-table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-bottom: 0;
    border: 0;
    border-radius: 0;
    background: var(--card);
  }

  .datanoa-matrix-table th {
    background: var(--surface);
    color: var(--muted);
    text-align: left;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    white-space: nowrap;
  }

  .datanoa-matrix-table td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    white-space: nowrap;
  }

  .datanoa-matrix-table tbody tr:last-child td {
    border-bottom: 0;
  }

  /* Query Execution Feedback Banner (Success & Error) */
  .datanoa-query-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 6px 10px 4px 10px;
    padding: 8px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    font-size: 12px;
    line-height: 1.4;
    flex-shrink: 0;
  }

  .datanoa-query-banner.success {
    background: rgba(74, 222, 128, 0.08);
    border-color: rgba(74, 222, 128, 0.28);
    border-left: 3px solid var(--ok);
    color: var(--text);
  }

  html.light .datanoa-query-banner.success {
    background: rgba(22, 163, 74, 0.07);
    border-color: rgba(22, 163, 74, 0.25);
    border-left: 3px solid var(--ok);
  }

  .datanoa-query-banner.error {
    background: rgba(248, 113, 113, 0.08);
    border-color: rgba(248, 113, 113, 0.28);
    border-left: 3px solid var(--danger);
    color: var(--text);
  }

  html.light .datanoa-query-banner.error {
    background: rgba(220, 38, 38, 0.06);
    border-color: rgba(220, 38, 38, 0.25);
    border-left: 3px solid var(--danger);
  }

  .datanoa-query-banner-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .datanoa-query-banner-title {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .datanoa-query-banner.success .datanoa-query-banner-title {
    color: var(--ok);
  }

  .datanoa-query-banner.error .datanoa-query-banner-title {
    color: var(--danger);
  }

  .datanoa-query-banner-detail {
    font-family: var(--mono-font);
    font-size: 12px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 88px;
    overflow-y: auto;
  }

  .datanoa-query-banner-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* Status Bar */
  .datanoa-status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    height: 25px;
    padding: 0 12px;
    font-size: 12px;
    color: var(--muted);
    background: var(--surface);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    user-select: none;
    font-variant-numeric: tabular-nums;
  }

  .datanoa-status-state {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-status-metrics {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .datanoa-shortcut-hint {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    margin-left: auto;
    flex: 0 1 auto;
    min-width: 0;
  }

  .datanoa-status-left, .datanoa-status-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  /* Visual Table Structure Designer (Staged Schema Inspector) */
  .datanoa-inspector-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .datanoa-struct-title-input {
    height: 26px;
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--input-border);
    border-radius: var(--radius);
    padding: 0 8px;
    font-family: var(--mono-font);
    font-size: 13px;
    font-weight: 600;
    min-width: 170px;
    transition: border-color 120ms ease, background 120ms ease;
  }

  .datanoa-struct-title-input:focus {
    border-color: var(--info);
  }

  .datanoa-struct-title-input.dirty {
    border-color: var(--info);
    background: color-mix(in srgb, var(--info) 12%, var(--input-bg));
  }

  .datanoa-struct-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .datanoa-struct-validation-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px;
    margin-bottom: 12px;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--danger) 10%, var(--bg));
    font-size: 12px;
    color: var(--text);
  }

  .datanoa-struct-validation-title {
    font-weight: 600;
    color: var(--danger);
  }

  .datanoa-struct-validation-list {
    margin: 0;
    padding-left: 16px;
    color: var(--text);
  }

  .datanoa-struct-section {
    margin-bottom: 16px;
  }

  .datanoa-struct-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .datanoa-struct-grid {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .datanoa-struct-grid th {
    height: 26px;
    text-align: left;
    padding: 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    background: var(--card);
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  .datanoa-struct-grid th:last-child,
  .datanoa-struct-grid td:last-child {
    border-right: 0;
  }

  .datanoa-struct-grid tbody tr {
    height: 28px;
  }

  .datanoa-struct-grid td {
    height: 28px;
    padding: 0;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .datanoa-struct-grid td.datanoa-struct-td-pad {
    padding: 0 8px;
  }

  .datanoa-struct-grid tbody tr:last-child td {
    border-bottom: 0;
  }

  .datanoa-struct-row-inserted td {
    background: color-mix(in srgb, var(--ok) 10%, var(--bg));
  }

  .datanoa-struct-row-deleted td {
    background: color-mix(in srgb, var(--danger) 10%, var(--bg));
    text-decoration: line-through;
    opacity: 0.65;
  }

  .datanoa-struct-cell-dirty {
    background: color-mix(in srgb, var(--info) 14%, var(--bg));
  }

  .datanoa-struct-cell-input,
  .datanoa-struct-cell-select {
    height: 27px;
    width: 100%;
    background: transparent;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: 0;
    padding: 0 8px;
    font-family: var(--mono-font);
    font-size: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }

  .datanoa-struct-cell-select option {
    background: var(--card);
    color: var(--text);
  }

  .datanoa-struct-cell-input:hover:not(:disabled),
  .datanoa-struct-cell-select:hover:not(:disabled) {
    background: var(--hover);
  }

  .datanoa-struct-cell-input:focus,
  .datanoa-struct-cell-select:focus {
    border-color: var(--info);
    background: var(--input-bg);
  }

  .datanoa-struct-cell-input:disabled,
  .datanoa-struct-cell-select:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .datanoa-struct-checkbox {
    accent-color: var(--info);
    width: 14px;
    height: 14px;
    cursor: pointer;
    vertical-align: middle;
  }

  .datanoa-struct-default-wrap {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 150px;
    padding-right: 4px;
  }

  .datanoa-clear-default-btn {
    height: 20px;
    width: 20px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--btn-bg);
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .datanoa-clear-default-btn:hover {
    color: var(--danger);
    border-color: var(--danger);
  }

  .datanoa-col-pills-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    flex-wrap: wrap;
  }

  .datanoa-col-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--muted);
    font-family: var(--mono-font);
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }

  .datanoa-col-pill.active {
    border-color: var(--info);
    background: color-mix(in srgb, var(--info) 16%, var(--bg));
    color: var(--text);
  }

  /* Migration Confirmation Modal (Full Studio) */
  .datanoa-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  html.light .datanoa-modal-backdrop {
    background: rgba(15, 23, 42, 0.42);
  }

  .datanoa-struct-confirm-modal {
    width: 100%;
    max-width: 620px;
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
  }

  .datanoa-modal-body {
    padding: 12px 14px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 12px;
  }

  .datanoa-modal-box {
    padding: 8px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .datanoa-modal-box.warn {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, var(--bg));
  }

  .datanoa-modal-box.error {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--bg));
  }

  .datanoa-modal-list {
    margin: 4px 0 0 0;
    padding-left: 18px;
    line-height: 1.5;
  }

  .datanoa-modal-sql {
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text);
    font-family: var(--mono-font);
    font-size: 12px;
    line-height: 1.5;
    max-height: 220px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .datanoa-modal-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }

  .datanoa-btn-danger-solid {
    background: var(--danger);
    color: #000000;
    border-color: var(--danger);
    font-weight: 600;
  }

  html.light .datanoa-btn-danger-solid,
  body.light .datanoa-btn-danger-solid {
    color: #ffffff;
  }

  .datanoa-btn-danger-solid:hover:not(:disabled) {
    filter: brightness(1.06);
  }

  /* In-DOM Aligned Combobox (Replaces broken iframe <datalist>) */
  .datanoa-combo-wrap {
    display: flex;
    align-items: center;
    width: 100%;
    height: 27px;
    position: relative;
  }

  .datanoa-combo-wrap .datanoa-struct-cell-input {
    flex: 1 1 auto;
    min-width: 0;
    padding-right: 4px;
  }

  .datanoa-combo-toggle {
    width: 22px;
    height: 27px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 10px;
    user-select: none;
  }

  .datanoa-combo-toggle:hover:not(:disabled) {
    color: var(--text);
    background: var(--hover);
  }

  .datanoa-combo-toggle:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .datanoa-combo-popover {
    position: fixed;
    z-index: 10060;
    max-height: 224px;
    overflow-y: auto;
    background: var(--raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--menu-shadow);
    padding: 3px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .datanoa-combo-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 4px 8px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--text);
    font-family: var(--mono-font);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .datanoa-combo-item:hover,
  .datanoa-combo-item.active {
    background: var(--hover);
    color: var(--info);
  }

  /* Shimmer Skeleton & Spinner Loading Primitives */
  @keyframes datanoa-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  @keyframes datanoa-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .datanoa-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    flex-shrink: 0;
    vertical-align: middle;
    animation: datanoa-spin 0.7s linear infinite;
  }

  .datanoa-live-timer {
    font-family: var(--mono-font);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    white-space: nowrap;
  }

  .datanoa-btn .datanoa-live-timer {
    color: inherit;
  }

  .datanoa-skeleton-bar {
    height: 11px;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--surface) 0%, var(--hover) 50%, var(--surface) 100%);
    background-size: 200% 100%;
    animation: datanoa-shimmer 1.25s infinite linear;
  }

  .datanoa-skeleton-cell {
    padding: 5px 10px !important;
  }

  .datanoa-sidebar-skeleton {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
  }

  .datanoa-sidebar-skeleton-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 20px;
  }

  .datanoa-inspector-skeleton {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 20px;
  }

  .datanoa-inspector-skeleton-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Status Bar Selection Aggregate Readout */
  .datanoa-status-selection {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 1px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-strong);
    background: var(--card);
    color: var(--text);
    font-size: 11.5px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background 0.12s ease, border-color 0.12s ease;
  }

  .datanoa-status-selection:hover {
    background: var(--raised);
    border-color: var(--sel-edge);
  }

  /* Columns Visibility & Pin Popover */
  .datanoa-cols-popover {
    position: fixed;
    z-index: 10045;
    width: 268px;
    max-height: 360px;
    display: flex;
    flex-direction: column;
    background: var(--raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-cols-popover-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .datanoa-cols-popover-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-cols-popover-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 12px;
  }

  .datanoa-cols-popover-row:hover {
    background: var(--hover);
  }

  /* Find & Highlight Inline Nav */
  .datanoa-find-nav {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .datanoa-find-count {
    font-family: var(--mono-font);
    font-size: 11.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    padding: 0 4px;
    white-space: nowrap;
  }

  /* Bulk Fill Value Inline Popover */
  .datanoa-bulk-fill-popover {
    position: fixed;
    z-index: 10050;
    width: 276px;
    padding: 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: var(--raised);
    box-shadow: var(--menu-shadow);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .datanoa-bulk-fill-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }

  .datanoa-bulk-fill-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }

  /* Command Palette (Ctrl+K / Ctrl+P) */
  .datanoa-cmd-palette {
    width: 100%;
    max-width: 540px;
    max-height: calc(100vh - 80px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-cmd-palette-input,
  .datanoa-cmd-palette .datanoa-cmd-palette-input {
    width: 100%;
    flex: 0 0 38px;
    height: 38px;
    min-height: 38px;
    max-height: 38px;
    padding: 0 12px;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
    font-family: var(--ui-font);
    font-size: 13px;
    box-sizing: border-box;
  }

  .datanoa-cmd-palette-list {
    flex: 1 1 auto;
    max-height: 340px;
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-cmd-palette-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 6px 10px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .datanoa-cmd-palette-item:hover,
  .datanoa-cmd-palette-item.active {
    background: rgba(56, 189, 248, 0.14);
    color: var(--info);
  }

  /* Keyboard Shortcuts Cheatsheet Modal */
  .datanoa-shortcuts-modal {
    width: 100%;
    max-width: 560px;
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-shortcuts-modal kbd {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    font-family: var(--mono-font);
    font-size: 11px;
    line-height: 1.4;
  }

  /* Create Table Modal & Danger Confirmation Modal */
  .datanoa-create-table-modal {
    width: 100%;
    max-width: 720px;
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-danger-modal {
    width: 100%;
    max-width: 520px;
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  /* Add / Edit Database Connection Modal (Full Studio) */
  .datanoa-conn-modal {
    width: min(640px, 94vw);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-conn-modal .datanoa-modal-body {
    flex: 1 1 auto;
    min-height: 0;
    gap: 12px;
  }

  .datanoa-conn-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .datanoa-conn-row.is-wrap {
    flex-wrap: wrap;
  }

  .datanoa-conn-input,
  .datanoa-conn-select {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    height: 26px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    box-sizing: border-box;
  }

  .datanoa-conn-input.is-mono {
    font-family: var(--mono-font);
  }

  .datanoa-conn-input::placeholder {
    color: var(--muted-dim);
  }

  .datanoa-conn-input:focus,
  .datanoa-conn-select:focus {
    outline: none;
    border-color: var(--info);
  }

  .datanoa-conn-input:disabled,
  .datanoa-conn-select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .datanoa-conn-uri-bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-conn-section-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .datanoa-engine-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }

  .datanoa-engine-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-height: 52px;
    padding: 6px 4px;
    border: 1px solid var(--btn-border);
    border-radius: var(--radius);
    background: var(--btn-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease;
  }

  .datanoa-engine-tile:hover:not(:disabled) {
    border-color: var(--btn-hover-border);
    background: var(--btn-hover-bg);
  }

  .datanoa-engine-tile.active {
    border-color: var(--info);
    background: color-mix(in srgb, var(--info) 14%, var(--bg));
    font-weight: 600;
  }

  .datanoa-engine-tile:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .datanoa-conn-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 10px;
  }

  .datanoa-conn-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .datanoa-conn-field.is-full {
    grid-column: 1 / -1;
  }

  .datanoa-conn-field > label {
    font-size: 11px;
    color: var(--muted);
  }

  .datanoa-conn-check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
  }

  .datanoa-conn-env-pills {
    display: inline-flex;
    gap: 4px;
  }

  .datanoa-conn-env-pill {
    height: 24px;
    padding: 0 9px;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .datanoa-conn-env-pill.active {
    border-color: var(--info);
    background: color-mix(in srgb, var(--info) 14%, var(--bg));
    font-weight: 600;
  }

  .datanoa-conn-env-pill.active.env-prod {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 14%, var(--bg));
    color: var(--danger);
  }

  .datanoa-conn-env-pill.active.env-staging {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 14%, var(--bg));
    color: var(--warn);
  }

  .datanoa-conn-discovered {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-conn-chip-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 140px;
    overflow-y: auto;
  }

  .datanoa-conn-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--card);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .datanoa-conn-chip:hover {
    border-color: var(--info);
    background: color-mix(in srgb, var(--info) 8%, var(--card));
  }

  .datanoa-conn-chip.selected {
    border-color: var(--info);
  }

  .datanoa-conn-chip-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .datanoa-conn-chip-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }

  .datanoa-conn-chip-sub {
    color: var(--muted);
    font-family: var(--mono-font);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 440px;
  }

  .datanoa-modal-box.success {
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 10%, var(--bg));
  }

  .datanoa-add-conn-btn,
  .datanoa-edit-conn-btn {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .datanoa-sidebar-empty-cta {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 12px;
  }

  @media (max-width: 700px) {
    .datanoa-engine-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .datanoa-conn-fields {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  /* Value Inspector Badges, History Search, Clear Filter & Error Retry CTAs */
  .datanoa-null-badge {
    display: inline-flex;
    align-items: center;
    height: 19px;
    padding: 0 6px;
    border-radius: 4px;
    border: 1px solid var(--border-strong);
    background: var(--raised);
    color: var(--muted);
    font-family: var(--mono-font);
    font-size: 11px;
    font-weight: 600;
    font-style: italic;
  }

  .datanoa-json-status {
    display: inline-flex;
    align-items: center;
    height: 19px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }

  .datanoa-json-status.valid {
    color: var(--ok);
    border: 1px solid rgba(74, 222, 128, 0.4);
    background: rgba(74, 222, 128, 0.12);
  }

  .datanoa-json-status.invalid {
    color: var(--danger);
    border: 1px solid rgba(248, 113, 113, 0.45);
    background: rgba(248, 113, 113, 0.12);
  }

  .datanoa-history-search {
    height: 22px;
    width: 180px;
    padding: 0 7px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .datanoa-filter-clear-btn {
    height: 23px;
    min-width: 23px;
    padding: 0 6px;
    border-radius: 4px;
    border: 1px solid var(--btn-border);
    background: var(--btn-bg);
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    flex-shrink: 0;
  }

  .datanoa-filter-clear-btn:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
    background: rgba(248, 113, 113, 0.1);
  }

  .datanoa-error-retry-btn {
    border-color: var(--info);
    color: var(--info);
  }

  .datanoa-error-retry-btn:hover:not(:disabled) {
    background: rgba(56, 189, 248, 0.14);
  }

  @media (prefers-reduced-motion: reduce) {
    .datanoa-spinner {
      animation: none;
      border-right-color: currentColor;
      opacity: 0.72;
    }

    .datanoa-skeleton-bar {
      animation: none;
    }
  }

  /* Compact Responsive Grid Chrome under 900px */
  @media (max-width: 900px) {
    .datanoa-toolbar {
      padding: 4px 8px;
      gap: 6px;
    }

    .datanoa-sql-toolbar {
      padding: 3px 8px;
      gap: 4px;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .datanoa-grid-subbar {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      padding: 3px 8px;
      gap: 4px;
      min-height: 28px;
    }

    .datanoa-grid-subbar-left,
    .datanoa-grid-subbar-right {
      flex-wrap: nowrap;
      flex-shrink: 0;
      gap: 4px;
    }

    .datanoa-grid-subbar .datanoa-btn-sm,
    .datanoa-grid-toolbar .datanoa-btn-sm {
      padding: 0 6px;
      height: 22px;
      font-size: 11.5px;
    }

    .datanoa-grid-toolbar {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      padding: 3px 8px;
      gap: 4px;
    }

    .datanoa-filter-group {
      flex: 1 0 115px;
      min-width: 110px;
      gap: 4px;
    }

    .datanoa-client-search {
      width: 115px;
      flex: 0 0 115px;
      min-width: 95px;
    }
  }

  /* Responsive Toolbar Adjustments under 720px */
  @media (max-width: 720px) {
    .datanoa-tabs {
      margin-left: 0;
    }
  }
`
