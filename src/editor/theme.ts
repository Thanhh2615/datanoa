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
    --warn-fg: #1a1204;
    --warn-tint: rgba(251, 191, 36, 0.14);
    --warn-border: rgba(251, 191, 36, 0.42);
    --danger-tint: rgba(248, 113, 113, 0.16);
    --danger-border: rgba(248, 113, 113, 0.4);
    --danger-border-strong: rgba(248, 113, 113, 0.62);
    --cm-sel-match-bg: rgba(56, 189, 248, 0.16);
    --cm-search-match-bg: rgba(250, 204, 21, 0.3);
    --cm-search-match-outline: rgba(250, 204, 21, 0.55);
    --cm-search-selected-bg: rgba(56, 189, 248, 0.36);
    --cm-bracket-match-bg: rgba(56, 189, 248, 0.18);
    --cm-bracket-match-focus-bg: rgba(56, 189, 248, 0.22);
    --cm-bracket-mismatch-bg: rgba(248, 113, 113, 0.25);
    --cm-bracket-mismatch-outline: var(--danger);
    --db-sqlite: #38bdf8;
    --db-postgres: #5b8def;
    --db-mysql: #f29111;
    --db-mariadb: #d4896a;
    --db-cockroachdb: #8b5cf6;
    --db-clickhouse: #ffcc01;
    --db-redis: #dc382d;
    --db-libsql: #4ff8d2;
    --db-d1: #f38020;
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
    --warn-fg: #ffffff;
    --warn-tint: rgba(180, 83, 9, 0.1);
    --warn-border: rgba(180, 83, 9, 0.3);
    --danger-tint: rgba(185, 28, 28, 0.1);
    --danger-border: rgba(185, 28, 28, 0.35);
    --danger-border-strong: rgba(185, 28, 28, 0.55);
    --cm-sel-match-bg: rgba(3, 105, 161, 0.12);
    --cm-search-match-bg: rgba(202, 138, 4, 0.25);
    --cm-search-match-outline: rgba(202, 138, 4, 0.5);
    --cm-search-selected-bg: rgba(3, 105, 161, 0.25);
    --cm-bracket-match-bg: rgba(3, 105, 161, 0.12);
    --cm-bracket-match-focus-bg: rgba(3, 105, 161, 0.12);
    --cm-bracket-mismatch-bg: rgba(185, 28, 28, 0.12);
    --cm-bracket-mismatch-outline: rgba(185, 28, 28, 0.45);
    --db-sqlite: #003b57;
    --db-postgres: #336791;
    --db-mysql: #00758f;
    --db-mariadb: #9e5338;
    --db-cockroachdb: #6933ff;
    --db-clickhouse: #d99b00;
    --db-redis: #dc382d;
    --db-libsql: #0f766e;
    --db-d1: #f38020;
    color-scheme: light;
  }

  .db-svg {
    display: block;
    flex-shrink: 0;
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
    gap: 8px;
    font-weight: 600;
    font-size: 12.5px;
    letter-spacing: 0;
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
    flex-wrap: nowrap;
    gap: 6px;
    min-width: 0;
    white-space: nowrap;
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
    flex-shrink: 0;
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
    transition: background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
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
    height: 24px;
    padding: 0 8px;
  }

  .datanoa-conn-cluster .datanoa-add-conn-btn,
  .datanoa-conn-cluster .datanoa-edit-conn-btn {
    height: 26px;
  }

  .datanoa-btn-primary {
    background: var(--primary);
    color: var(--primary-fg);
    border-color: var(--primary);
    font-weight: 600;
  }

  .datanoa-btn-primary.has-staged:not(:disabled) {
    background: var(--info);
    color: #04131d;
    border-color: var(--info);
    box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.28);
  }

  html.light .datanoa-btn-primary.has-staged:not(:disabled),
  body.light .datanoa-btn-primary.has-staged:not(:disabled) {
    background: var(--info);
    color: #ffffff;
    border-color: var(--info);
  }

  .datanoa-btn-primary:hover:not(:disabled) {
    background: var(--primary);
    border-color: var(--primary);
    opacity: 0.88;
  }

  .datanoa-btn-primary.has-staged:hover:not(:disabled) {
    background: var(--info);
    border-color: var(--info);
    opacity: 0.92;
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
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .datanoa-select-sm {
    height: 24px;
    min-width: 112px;
    max-width: 165px;
    padding: 0 6px;
  }

  .datanoa-select:focus {
    border-color: var(--info);
  }

  .datanoa-sr-only-select {
    display: none !important;
  }

  .datanoa-custom-select-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    height: 26px;
    padding: 0 8px;
    border-radius: var(--radius);
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    cursor: pointer;
    min-width: 155px;
    max-width: 100%;
    text-align: left;
    overflow: hidden;
  }

  .datanoa-conn-cluster .datanoa-custom-select-trigger {
    max-width: 245px;
  }

  .datanoa-conn-field .datanoa-custom-select-trigger {
    width: 100%;
    min-width: 0;
    height: 28px;
  }

  .datanoa-custom-select-trigger:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--btn-hover-bg);
  }

  .datanoa-custom-select-trigger:focus-visible {
    outline: 2px solid var(--info);
    outline-offset: -1px;
  }

  .datanoa-custom-select-lead-icon {
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    flex-shrink: 0;
  }

  .datanoa-custom-select-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-custom-select-chev {
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    flex-shrink: 0;
  }

  .datanoa-custom-select-popover {
    position: fixed;
    z-index: 10090;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: var(--surface);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-custom-select-head {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .datanoa-custom-select-head .datanoa-btn {
    flex-shrink: 0;
    height: 28px;
    width: 28px;
    padding: 0;
  }

  .datanoa-custom-select-search {
    flex: 1 1 auto;
    min-width: 0;
    width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    box-sizing: border-box;
  }

  .datanoa-custom-select-search:focus {
    outline: none;
    border-color: var(--info);
  }

  .datanoa-custom-select-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    flex: 1 1 auto;
    padding-right: 2px;
  }

  .datanoa-custom-select-folder-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 4px 8px;
    margin-top: 6px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: var(--raised);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .datanoa-custom-select-folder-head:first-child {
    margin-top: 0;
  }

  .datanoa-custom-select-folder-head:hover {
    color: var(--text);
    background: var(--btn-hover-bg);
  }

  .datanoa-custom-select-folder-chev {
    font-size: 11px;
    width: 12px;
    text-align: center;
    flex-shrink: 0;
  }

  .datanoa-custom-select-folder-icon {
    display: inline-flex;
    align-items: center;
    color: var(--info);
    flex-shrink: 0;
  }

  .datanoa-custom-select-folder-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-custom-select-folder-count {
    font-size: 11px;
    font-family: var(--mono-font);
    font-variant-numeric: tabular-nums;
    color: var(--muted-dim);
    flex-shrink: 0;
  }

  .datanoa-custom-select-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 32px;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    min-width: 0;
    transition: background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .datanoa-custom-select-item.is-indented {
    padding-left: 24px;
  }

  .datanoa-custom-select-item:hover:not(:disabled) {
    background: var(--btn-hover-bg);
  }

  .datanoa-custom-select-item.active {
    background: var(--raised);
    border-color: var(--border-strong);
    font-weight: 600;
  }

  .datanoa-custom-select-item-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    flex-shrink: 0;
  }

  .datanoa-custom-select-item-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .datanoa-custom-select-item-label {
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-custom-select-item-sub {
    font-size: 11px;
    line-height: 1.35;
    font-family: var(--mono-font);
    color: var(--muted-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-custom-select-item-check {
    color: var(--info);
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .datanoa-custom-select-empty {
    padding: 10px 8px;
    text-align: center;
    font-size: 11.5px;
    color: var(--muted-dim);
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
    transition: background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
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
    transition: background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .datanoa-topbar-pill:hover {
    color: var(--text);
    background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border);
  }

  .datanoa-topbar-pill.active {
    background: color-mix(in srgb, var(--info) 15%, transparent);
    border-color: var(--info);
    color: var(--info);
    font-weight: 600;
  }

  .datanoa-topbar-pill-kind {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .datanoa-topbar-all-btn,
  .datanoa-topbar-new-table-btn {
    height: 24px;
    padding: 0 8px;
    flex-shrink: 0;
  }

  .datanoa-topbar-popover {
    position: fixed;
    z-index: 10040;
    width: 300px;
    max-width: calc(100vw - 16px);
    max-height: 380px;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--menu-shadow);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .datanoa-topbar-popover-head {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .datanoa-topbar-popover-head .datanoa-btn {
    flex-shrink: 0;
    height: 28px;
    width: 28px;
    padding: 0;
  }

  .datanoa-topbar-popover-search {
    flex: 1 1 auto;
    min-width: 0;
    width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    box-sizing: border-box;
  }

  .datanoa-topbar-popover-search:focus {
    outline: none;
    border-color: var(--info);
  }

  .datanoa-topbar-popover-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
    flex: 1 1 auto;
    padding-right: 2px;
  }

  .datanoa-topbar-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-topbar-group-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 4px 8px;
    margin-top: 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: var(--raised);
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .datanoa-topbar-group:first-child .datanoa-topbar-group-header {
    margin-top: 0;
  }

  .datanoa-topbar-group-header:hover {
    background: var(--btn-hover-bg);
    color: var(--text);
  }

  .datanoa-topbar-group-chev {
    width: 12px;
    text-align: center;
    font-size: 11px;
    line-height: 1;
    flex-shrink: 0;
  }

  .datanoa-topbar-group-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-topbar-group-count {
    font-family: var(--mono-font);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--muted-dim);
    flex-shrink: 0;
  }

  .datanoa-topbar-group-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-topbar-popover-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-width: 0;
    min-height: 28px;
    padding: 5px 8px 5px 20px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .datanoa-topbar-popover-item:hover {
    background: var(--btn-hover-bg);
  }

  .datanoa-topbar-popover-item.active {
    background: color-mix(in srgb, var(--info) 14%, transparent);
    border-color: color-mix(in srgb, var(--info) 34%, transparent);
    color: var(--info);
    font-weight: 600;
  }

  .datanoa-topbar-popover-item-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.35;
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

  .datanoa-sidebar-controls {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 6px;
    min-width: 0;
  }

  .datanoa-schema-select {
    flex: 1 1 auto;
    min-width: 0;
    height: 25px;
    padding: 0 6px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .datanoa-schema-select:focus {
    border-color: var(--info);
  }

  .datanoa-export-ddl-btn {
    flex: 0 0 auto;
    height: 25px;
    padding: 0 8px;
    font-size: 11.5px;
    white-space: nowrap;
  }

  .datanoa-sidebar-group {
    display: flex;
    flex-direction: column;
  }

  .datanoa-sidebar-group-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 28px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    cursor: pointer;
  }

  .datanoa-sidebar-group-header:hover {
    background: var(--hover);
    color: var(--text);
  }

  .datanoa-sidebar-group-chevron {
    width: 10px;
    flex-shrink: 0;
    font-size: 10px;
    line-height: 1;
  }

  .datanoa-sidebar-group-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }

  .datanoa-sidebar-group-count {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 9px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--muted);
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .datanoa-sidebar-group-items {
    display: flex;
    flex-direction: column;
  }

  .datanoa-object-kind-badge {
    flex-shrink: 0;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid transparent;
    font-family: var(--mono-font);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.03em;
    line-height: 1.4;
    text-transform: uppercase;
  }

  .datanoa-object-kind-badge.datanoa-kind-table {
    color: var(--muted);
    background: var(--card);
    border-color: var(--border);
  }

  .datanoa-object-kind-badge.datanoa-kind-view {
    color: var(--cm-function);
    background: color-mix(in srgb, var(--cm-function) 12%, transparent);
    border-color: color-mix(in srgb, var(--cm-function) 32%, transparent);
  }

  .datanoa-object-kind-badge.datanoa-kind-materialized_view {
    color: var(--cm-keyword);
    background: color-mix(in srgb, var(--cm-keyword) 14%, transparent);
    border-color: color-mix(in srgb, var(--cm-keyword) 36%, transparent);
  }

  .datanoa-object-kind-badge.datanoa-kind-function {
    color: var(--cm-string);
    background: color-mix(in srgb, var(--cm-string) 12%, transparent);
    border-color: color-mix(in srgb, var(--cm-string) 30%, transparent);
  }

  .datanoa-object-kind-badge.datanoa-kind-procedure {
    color: var(--cm-type);
    background: color-mix(in srgb, var(--cm-type) 12%, transparent);
    border-color: color-mix(in srgb, var(--cm-type) 32%, transparent);
  }

  .datanoa-object-kind-badge.datanoa-kind-trigger {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    border-color: color-mix(in srgb, var(--warn) 32%, transparent);
  }

  .datanoa-object-kind-badge.datanoa-kind-sequence {
    color: var(--cm-number);
    background: color-mix(in srgb, var(--cm-number) 12%, transparent);
    border-color: color-mix(in srgb, var(--cm-number) 32%, transparent);
  }

  .datanoa-object-kind-badge.datanoa-kind-type {
    color: var(--info);
    background: color-mix(in srgb, var(--info) 12%, transparent);
    border-color: color-mix(in srgb, var(--info) 32%, transparent);
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

  .datanoa-toolbar-sep {
    width: 1px;
    height: 18px;
    background: var(--border-strong);
    margin: 0 2px;
    flex-shrink: 0;
  }

  .datanoa-tx-group {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .datanoa-tx-group .datanoa-btn {
    height: 24px;
    padding: 0 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .datanoa-tx-autocommit-btn.active {
    background: var(--warn);
    border-color: var(--warn);
    color: var(--warn-fg);
  }

  .datanoa-tx-autocommit-btn.active:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  .datanoa-tx-badge {
    display: inline-flex;
    align-items: center;
    height: 19px;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--warn-tint);
    border: 1px solid var(--warn-border);
    color: var(--warn);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .datanoa-tx-rollback-btn:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger-border);
  }

  .datanoa-tx-rollback-btn:not(:disabled):hover {
    background: var(--danger-tint);
    border-color: var(--danger-border-strong);
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

  /* CodeMirror Find & Replace + Folding (Phase 5A) */
  .datanoa-sql-area .cm-panels {
    background: var(--surface);
    color: var(--text);
    border-bottom: 1px solid var(--border);
    font-family: var(--ui-font);
    font-size: 12px;
  }

  .datanoa-sql-area .cm-panels.cm-panels-top {
    border-bottom: 1px solid var(--border);
  }

  .datanoa-sql-area .cm-search {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
  }

  .datanoa-sql-area .cm-search .cm-textfield {
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    padding: 3px 6px;
    font-family: var(--mono-font);
    font-size: 12px;
  }

  .datanoa-sql-area .cm-search .cm-textfield:focus-visible {
    border-color: var(--info);
    outline: 2px solid var(--info);
    outline-offset: 1px;
  }

  .datanoa-sql-area .cm-search input[type='checkbox'] {
    accent-color: var(--info);
  }

  .datanoa-sql-area .cm-search .cm-button {
    background: var(--btn-bg);
    background-image: none;
    color: var(--text);
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
  }

  .datanoa-sql-area .cm-search .cm-button:hover {
    background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border);
  }

  .datanoa-sql-area .cm-search label {
    color: var(--muted);
    font-size: 11px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .datanoa-sql-area .cm-search [name='close'],
  .datanoa-sql-area .cm-panel.cm-search [name='close'] {
    color: var(--muted);
    margin-left: auto;
  }

  .datanoa-sql-area .cm-search [name='close']:hover,
  .datanoa-sql-area .cm-panel.cm-search [name='close']:hover {
    color: var(--text);
  }

  .datanoa-sql-area .cm-foldGutter .cm-gutterElement {
    color: var(--muted-dim);
    cursor: pointer;
    padding: 0 2px;
  }

  .datanoa-sql-area .cm-foldGutter .cm-gutterElement:hover {
    color: var(--info);
  }

  .datanoa-sql-area .cm-foldPlaceholder {
    background: var(--hover);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--muted);
    padding: 0 6px;
    margin: 0 2px;
  }

  .datanoa-sql-area .cm-selectionMatch {
    background: var(--cm-sel-match-bg);
  }

  .datanoa-sql-area .cm-searchMatch {
    background: var(--cm-search-match-bg);
    outline: 1px solid var(--cm-search-match-outline);
  }

  .datanoa-sql-area .cm-searchMatch-selected {
    background: var(--cm-search-selected-bg);
    outline: 1px solid var(--info);
  }

  .datanoa-sql-area .cm-matchingBracket,
  .datanoa-sql-area .cm-nonmatchingBracket {
    background: var(--cm-bracket-match-bg);
    outline: 1px solid var(--sel-edge);
  }

  .datanoa-sql-area .cm-nonmatchingBracket,
  .datanoa-sql-area .cm-editor.cm-focused .cm-nonmatchingBracket {
    background: var(--cm-bracket-mismatch-bg);
    outline: 1px solid var(--cm-bracket-mismatch-outline);
  }

  .datanoa-sql-area .cm-editor.cm-focused .cm-matchingBracket {
    background: var(--cm-bracket-match-focus-bg);
    outline: 1px solid var(--sel-edge);
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


  /* Multi-Tab SQL Console & Multi Result-Set Switcher */
  .datanoa-console-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px 6px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
    scrollbar-width: thin;
    user-select: none;
  }

  .datanoa-console-tab {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    max-width: 220px;
    padding: 0 6px 0 9px;
    border: 1px solid transparent;
    border-radius: 4px 4px 0 0;
    background: transparent;
    color: var(--muted);
    font-size: 11.5px;
    white-space: nowrap;
    cursor: pointer;
    flex-shrink: 0;
  }

  .datanoa-console-tab:hover {
    background: var(--hover);
    color: var(--text);
  }

  .datanoa-console-tab.active {
    background: var(--raised);
    color: var(--text);
    border-color: var(--border);
    border-bottom-color: var(--raised);
    font-weight: 600;
  }

  .datanoa-console-tab-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }

  .datanoa-console-tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--muted);
    font-size: 13px;
    line-height: 1;
    opacity: 0.6;
    cursor: pointer;
  }

  .datanoa-console-tab-close:hover {
    background: var(--btn-hover-bg);
    color: var(--danger);
    opacity: 1;
  }

  .datanoa-console-tab-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    margin-left: 2px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: var(--surface);
    color: var(--muted);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
    position: sticky;
    right: 0;
    z-index: 1;
  }

  .datanoa-console-tab-add:hover {
    background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border);
    color: var(--text);
  }

  .datanoa-console-tab-rename {
    height: 20px;
    width: 130px;
    padding: 0 4px;
    border: 1px solid var(--info);
    border-radius: 3px;
    background: var(--input-bg);
    color: var(--text);
    font-size: 11.5px;
    outline: none;
  }

  .datanoa-result-sets-bar {
    display: none;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
    scrollbar-width: thin;
  }

  .datanoa-result-set-btn {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 9px;
    border: 1px solid var(--btn-border);
    border-radius: 4px;
    background: var(--btn-bg);
    color: var(--muted);
    font-size: 11.5px;
    white-space: nowrap;
    cursor: pointer;
    flex-shrink: 0;
  }

  .datanoa-result-set-btn:hover {
    background: var(--btn-hover-bg);
    border-color: var(--btn-hover-border);
    color: var(--text);
  }

  .datanoa-result-set-btn.active {
    background: var(--sel-fill);
    border-color: var(--info);
    color: var(--info);
    font-weight: 600;
  }

  html.light .datanoa-console-tab.active,
  body.light .datanoa-console-tab.active {
    background: var(--bg);
    box-shadow: inset 0 -2px 0 var(--info);
  }

  html.light .datanoa-result-set-btn.active,
  body.light .datanoa-result-set-btn.active {
    background: var(--sel-fill);
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