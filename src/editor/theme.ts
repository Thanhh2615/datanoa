// src/editor/theme.ts
// High-craft dark UI + adaptive light mode tokens for Datanoa Studio
// Strict 4-group token hierarchy: Surface Palette, Text Hierarchy, Border Opacity Scale, Accent & Semantic Status

import { GEIST_FONT_DATA_URI } from '../assets/geist-font.js'
import { EDITOR_GRID_STYLE } from './theme-grid.js'
import { EDITOR_MODALS_STYLE } from './theme-modals.js'

export { EDITOR_GRID_STYLE, EDITOR_MODALS_STYLE }

export const EDITOR_BASE_STYLE = `
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


  /* Responsive Toolbar Adjustments under 720px */
  @media (max-width: 720px) {
    .datanoa-tabs {
      margin-left: 0;
    }
  }
`

export const EDITOR_STYLE = `${EDITOR_BASE_STYLE}
${EDITOR_GRID_STYLE}
${EDITOR_MODALS_STYLE}
`