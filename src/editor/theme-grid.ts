// src/editor/theme-grid.ts
// Fullscreen Studio Data Grid, Selection, Pinned Columns, Filter Bar, Query Banner & Value Inspector CSS

export const EDITOR_GRID_STYLE = `
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
    height: 24px;
    padding: 0 8px;
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
    border-color: var(--accent-ring);
  }

  .datanoa-filter-input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    background: var(--surface);
  }

  .datanoa-client-search {
    width: 150px;
    flex: 0 1 180px;
    min-width: 110px;
    height: 24px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font-size: 12px;
  }

  .datanoa-client-search:focus {
    border-color: var(--accent-ring);
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
    outline: 2px solid var(--accent-ring);
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
    z-index: 16;
    text-align: right;
    color: var(--muted-dim);
    border-right: 1px solid var(--border-strong);
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
    color: var(--text);
    background: color-mix(in srgb, var(--accent-ring) 14%, var(--card));
  }

  html.light .datanoa-th.datanoa-th-selected,
  body.light .datanoa-th.datanoa-th-selected {
    color: var(--text);
    background: color-mix(in srgb, var(--accent-ring) 12%, var(--card));
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
    color: var(--accent-ring);
    font-size: 10px;
    opacity: 0.9;
  }

  .datanoa-col-filter-btn,
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

  .datanoa-th:hover .datanoa-col-filter-btn,
  .datanoa-col-filter-btn.active,
  .datanoa-col-filter-btn:focus-visible,
  .datanoa-th:hover .datanoa-col-select-btn,
  .datanoa-th.datanoa-th-selected .datanoa-col-select-btn,
  .datanoa-col-select-btn:focus-visible {
    opacity: 1;
  }

  .datanoa-col-filter-btn:hover,
  .datanoa-col-select-btn:hover {
    background: var(--hover);
    border-color: var(--border-strong);
    color: var(--text);
  }

  .datanoa-col-filter-btn.active {
    color: var(--text);
    background: color-mix(in srgb, var(--accent-ring) 16%, transparent);
    border-color: color-mix(in srgb, var(--accent-ring) 55%, transparent);
  }

  .datanoa-col-filter-popover {
    position: fixed;
    z-index: 10050;
    width: 230px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--popover);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--menu-shadow);
    font-size: 12px;
  }

  .datanoa-col-filter-title {
    font-weight: 600;
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-col-filter-select,
  .datanoa-col-filter-input {
    width: 100%;
    box-sizing: border-box;
  }

  .datanoa-col-filter-actions {
    display: flex;
    align-items: center;
    gap: 5px;
    justify-content: flex-end;
    margin-top: 2px;
  }

  .datanoa-th.datanoa-th-selected .datanoa-col-select-btn {
    color: var(--text);
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
    background: var(--accent-ring);
  }

  .datanoa-tr {
    height: 22px;
    line-height: 21px;
    max-height: 22px;
    box-sizing: border-box;
  }

  .datanoa-tr.datanoa-tr-even {
    background: color-mix(in srgb, var(--text) 2.5%, var(--bg));
  }

  .datanoa-tr:hover {
    background: var(--hover);
  }

  .datanoa-tr.datanoa-row-selected {
    background: color-mix(in srgb, var(--text) 4%, var(--bg));
  }

  .datanoa-tr.datanoa-row-inserted,
  .datanoa-tr.datanoa-row-inserted:hover {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
  }

  .datanoa-tr.datanoa-row-deleted,
  .datanoa-tr.datanoa-row-deleted:hover {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
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
    background: color-mix(in srgb, var(--accent-ring) 6%, transparent);
    outline: 1px solid var(--sel-focus);
    outline-offset: -1px;
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
    background: color-mix(in srgb, var(--info) 16%, transparent);
    font-weight: 500;
  }

  .datanoa-td.datanoa-cell-match {
    background: color-mix(in srgb, var(--warn) 22%, transparent);
  }

  .datanoa-td.datanoa-cell-match-active {
    background: color-mix(in srgb, var(--warn) 42%, transparent);
    outline: 1.5px solid var(--warn);
    outline-offset: -1.5px;
    z-index: 3;
  }

  /* Pinned / Frozen Columns (strictly opaque color-mix in Dark & Light modes) */
  .datanoa-col-pinned {
    position: sticky;
    z-index: 5;
    background: var(--bg);
  }

  .datanoa-tr.datanoa-tr-even .datanoa-col-pinned {
    background: color-mix(in srgb, var(--text) 2.5%, var(--bg));
  }

  .datanoa-tr:hover .datanoa-col-pinned {
    background: color-mix(in srgb, var(--text) 7%, var(--bg));
  }

  .datanoa-tr.datanoa-row-selected .datanoa-col-pinned {
    background: color-mix(in srgb, var(--accent-ring) 12%, var(--bg));
  }

  .datanoa-tr.datanoa-row-inserted .datanoa-col-pinned {
    background: color-mix(in srgb, var(--ok) 12%, var(--bg));
  }

  .datanoa-tr.datanoa-row-deleted .datanoa-col-pinned {
    background: color-mix(in srgb, var(--danger) 14%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-in-range {
    background: color-mix(in srgb, var(--accent-ring) 10%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-selected,
  .datanoa-td.datanoa-col-pinned.datanoa-cell-in-range.datanoa-cell-selected {
    background: color-mix(in srgb, var(--accent-ring) 14%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-staged {
    background: color-mix(in srgb, var(--info) 20%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-match {
    background: color-mix(in srgb, var(--warn) 22%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-match-active {
    background: color-mix(in srgb, var(--warn) 42%, var(--bg));
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-saving {
    background: color-mix(in srgb, var(--info) 24%, var(--bg)) !important;
  }

  .datanoa-td.datanoa-col-pinned.datanoa-cell-conflict {
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
    background: color-mix(in srgb, var(--accent-ring) 16%, var(--card));
  }

  .datanoa-col-pinned-last {
    border-right: 1px solid var(--border-strong);
    box-shadow: 3px 0 6px -2px rgba(0, 0, 0, 0.35);
  }

  html.light .datanoa-col-pinned-last,
  body.light .datanoa-col-pinned-last {
    box-shadow: 3px 0 6px -2px rgba(15, 23, 42, 0.14);
  }

  .datanoa-td.datanoa-cell-in-range.datanoa-col-pinned-last {
    box-shadow: var(--sel-t), var(--sel-r), var(--sel-b), var(--sel-l), 3px 0 6px -2px rgba(0, 0, 0, 0.35);
  }

  html.light .datanoa-td.datanoa-cell-in-range.datanoa-col-pinned-last,
  body.light .datanoa-td.datanoa-cell-in-range.datanoa-col-pinned-last {
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
    border: 1px solid color-mix(in srgb, var(--info) 38%, transparent);
    background: color-mix(in srgb, var(--info) 12%, transparent);
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
    background: color-mix(in srgb, var(--info) 24%, transparent);
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
    border-right: 1px solid var(--border-strong);
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
    color: var(--text);
    background: color-mix(in srgb, var(--accent-ring) 16%, var(--surface));
    font-weight: 600;
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
    background: color-mix(in srgb, var(--ok) 18%, transparent);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 42%, transparent);
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
    border: 1.5px solid var(--accent-ring);
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
    background: color-mix(in srgb, var(--info) 22%, transparent) !important;
  }

  .datanoa-cell-conflict {
    background: color-mix(in srgb, var(--danger) 26%, transparent) !important;
    animation: flash-conflict 0.9s ease-out;
  }

  @keyframes flash-conflict {
    0% { background: var(--danger); color: var(--danger-fg); }
    100% { background: color-mix(in srgb, var(--danger) 26%, transparent); }
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
    border-color: var(--accent-ring);
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
    background: var(--popover);
    box-shadow: var(--menu-shadow);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-context-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 6px 9px;
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
    background: color-mix(in srgb, var(--ok) 9%, var(--bg));
    border-color: color-mix(in srgb, var(--ok) 30%, var(--border));
    border-left: 3px solid var(--ok);
    color: var(--text);
  }

  .datanoa-query-banner.error {
    background: color-mix(in srgb, var(--danger) 9%, var(--bg));
    border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
    border-left: 3px solid var(--danger);
    color: var(--text);
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
    background: var(--popover);
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
    background: var(--popover);
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
    border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
    background: color-mix(in srgb, var(--ok) 12%, transparent);
  }

  .datanoa-json-status.invalid {
    color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }

  .datanoa-history-search {
    height: 22px;
    flex: 1 1 180px;
    width: 180px;
    max-width: 180px;
    min-width: 48px;
    padding: 0 7px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .datanoa-filter-clear-btn {
    height: 24px;
    min-width: 24px;
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
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }

  .datanoa-error-retry-btn {
    border-color: color-mix(in srgb, var(--accent-ring) 65%, var(--border-strong));
    color: var(--text);
  }

  .datanoa-error-retry-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-ring) 14%, transparent);
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

    .datanoa-grid-subbar .datanoa-btn-group {
      flex-wrap: nowrap;
      flex-shrink: 0;
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
`