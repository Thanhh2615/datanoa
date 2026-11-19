// src/editor/theme-modals.ts
// Fullscreen Studio Schema Inspector, Migration Confirm, Command Palette, Shortcuts,
// Create/Danger Table, 8-Engine Connection Manager & Feedback Modals CSS

export const EDITOR_MODALS_STYLE = `
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

  /* In-DOM Aligned Combobox (Replaces broken native datalist) */
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


  /* In-App Feedback & Bug Report Modal */
  .datanoa-feedback-modal {
    width: min(560px, 94vw);
    max-height: calc(100vh - 56px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--card);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-feedback-kind-group {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .datanoa-feedback-kind-btn {
    flex: 1 1 180px;
    justify-content: center;
  }

  .datanoa-feedback-title-input {
    width: 100%;
    box-sizing: border-box;
  }

  .datanoa-feedback-body-input {
    width: 100%;
    min-height: 88px;
    max-height: 180px;
    resize: vertical;
    box-sizing: border-box;
  }

  .datanoa-feedback-diag {
    margin: 0;
    max-height: 120px;
    overflow-y: auto;
    user-select: text;
    white-space: pre-wrap;
  }

  .datanoa-feedback-btn {
    height: 19px;
    padding: 0 7px;
    font-size: 11px;
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
`