// src/editor/theme-modals.ts
// Fullscreen Studio Schema Inspector, Migration Confirm, Command Palette, Shortcuts,
// Create/Danger Table, 9-Engine Connection Manager, Driver Manager & Feedback Modals CSS

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
    background: color-mix(in srgb, var(--info) 16%, transparent);
    color: var(--info);
    border: 1px solid color-mix(in srgb, var(--info) 45%, transparent);
  }

  .datanoa-badge-unique {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent);
  }

  .datanoa-badge-fk {
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
    border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  }

  .datanoa-badge-danger {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  }

  html.light .datanoa-badge-danger,
  body.light .datanoa-badge-danger {
    background: color-mix(in srgb, var(--danger) 12%, var(--surface));
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  }

  .datanoa-object-schema-badge,
  .datanoa-object-detail-pill {
    background: var(--card);
    color: var(--muted);
    border: 1px solid var(--border);
    font-family: var(--mono-font);
    font-size: 11px;
  }

  .datanoa-object-detail-pill {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-readonly-object-ddl-card {
    margin: 0;
  }

  .datanoa-readonly-object-ddl-card .datanoa-ddl-pre {
    max-height: none;
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
    border-radius: var(--radius-control);
    padding: 0 8px;
    font-family: var(--mono-font);
    font-size: 13px;
    font-weight: 600;
    min-width: 170px;
    transition: border-color 120ms ease, background 120ms ease;
  }

  .datanoa-struct-title-input:focus {
    border-color: var(--accent-ring);
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
    max-width: 100%;
    background: transparent;
    color: var(--text);
    border: 1px solid transparent;
    border-radius: 0;
    padding: 0 8px;
    font-family: var(--mono-font);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    border-color: var(--accent-ring);
    background: var(--input-bg);
  }

  .datanoa-struct-cell-input:disabled,
  .datanoa-struct-cell-select:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .datanoa-struct-checkbox {
    accent-color: var(--accent-ring);
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
    border-color: color-mix(in srgb, var(--accent-ring) 65%, var(--border-strong));
    background: color-mix(in srgb, var(--accent-ring) 16%, var(--bg));
    color: var(--text);
  }

  /* Migration Confirmation Modal (Full Studio) */
  .datanoa-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10100;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  html.light .datanoa-modal-backdrop,
  body.light .datanoa-modal-backdrop {
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
    background: var(--popover);
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
    color: var(--danger-fg);
    border-color: var(--danger);
    font-weight: 600;
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
    background: var(--popover);
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
    background: color-mix(in srgb, var(--accent-ring) 14%, transparent);
    color: var(--text);
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
    background: var(--popover);
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
    padding: 4px 4px 8px 4px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-cmd-palette-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
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
    background: color-mix(in srgb, var(--accent-ring) 15%, transparent);
    color: var(--text);
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
    background: var(--popover);
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
  .datanoa-bind-params-modal {
    width: min(680px, 94vw);
    max-height: 88vh;
  }

  .datanoa-bind-params-modal .datanoa-matrix-table td {
    vertical-align: middle;
  }

  .datanoa-bind-params-modal .datanoa-modal-sql {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--input-bg);
    color: var(--text);
    font-family: var(--mono-font);
    font-size: 11.5px;
    padding: 8px 10px;
  }

  .datanoa-bind-params-modal .datanoa-modal-box.error {
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--danger);
    padding: 6px 9px;
    margin-bottom: 8px;
    font-size: 11.5px;
  }

  html.light .datanoa-bind-params-modal .datanoa-modal-sql,
  body.light .datanoa-bind-params-modal .datanoa-modal-sql {
    background: var(--surface);
  }

  .datanoa-create-table-modal {
    width: 100%;
    max-width: 720px;
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--popover);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-create-table-modal.datanoa-bind-params-modal {
    width: min(680px, 94vw);
    max-width: min(680px, 94vw);
    max-height: 88vh;
  }

  .datanoa-danger-modal {
    width: 100%;
    max-width: 520px;
    max-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--popover);
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
    background: var(--popover);
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
    max-width: 100%;
    height: 26px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    box-sizing: border-box;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    border-color: var(--accent-ring);
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
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--muted);
  }

  .datanoa-engine-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
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
    border-color: color-mix(in srgb, var(--accent-ring) 65%, var(--border-strong));
    background: color-mix(in srgb, var(--accent-ring) 14%, var(--bg));
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

  .datanoa-conn-collapsible {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  }

  .datanoa-conn-collapsible-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 30px;
    padding: 6px 10px;
    border: 0;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .datanoa-conn-collapsible-head:hover:not(:disabled) {
    background: var(--hover);
  }

  .datanoa-conn-collapsible-head:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .datanoa-conn-collapsible.is-expanded .datanoa-conn-collapsible-head {
    border-bottom-color: var(--border);
  }

  .datanoa-conn-chevron {
    display: inline-block;
    width: 10px;
    font-size: 10px;
    color: var(--muted);
    transition: transform 0.12s ease;
  }

  .datanoa-conn-collapsible.is-expanded .datanoa-conn-chevron {
    transform: rotate(90deg);
  }

  .datanoa-conn-collapsible-title {
    flex: 1 1 auto;
    min-width: 0;
  }

  .datanoa-conn-collapsible-pill {
    flex: 0 0 auto;
    padding: 1px 7px;
    border: 1px solid var(--info);
    border-radius: 999px;
    background: color-mix(in srgb, var(--info) 14%, transparent);
    color: var(--info);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .datanoa-conn-collapsible-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
  }

  .datanoa-conn-hint {
    grid-column: 1 / -1;
    font-size: 11px;
    line-height: 1.4;
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
    border-color: color-mix(in srgb, var(--accent-ring) 65%, var(--border-strong));
    background: color-mix(in srgb, var(--accent-ring) 14%, var(--bg));
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
    gap: 8px;
    padding: 8px 10px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-discovery-search {
    width: 100%;
    box-sizing: border-box;
  }

  .datanoa-discovery-groups {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .datanoa-discovery-group {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    overflow: hidden;
  }

  .datanoa-discovery-head {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    min-height: 30px;
    padding: 5px 10px;
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .datanoa-discovery-head:hover {
    background: var(--hover);
  }

  .datanoa-discovery-chevron {
    display: inline-block;
    width: 10px;
    font-size: 10px;
    color: var(--muted);
    transition: transform 0.12s ease;
    flex-shrink: 0;
  }

  .datanoa-discovery-group.is-expanded .datanoa-discovery-chevron {
    transform: rotate(90deg);
  }

  .datanoa-discovery-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 4px;
    font-family: var(--mono-font);
    font-size: 10.5px;
    font-weight: 600;
    flex-shrink: 0;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
  }

  .datanoa-discovery-pill.is-env {
    border-color: color-mix(in srgb, var(--warn) 42%, var(--border));
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, var(--bg));
  }

  .datanoa-discovery-pill.is-docker {
    border-color: color-mix(in srgb, var(--info) 42%, var(--border));
    color: var(--info);
    background: color-mix(in srgb, var(--info) 10%, var(--bg));
  }

  .datanoa-discovery-pill.is-sqlite {
    border-color: color-mix(in srgb, var(--ok) 42%, var(--border));
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 10%, var(--bg));
  }

  .datanoa-discovery-title {
    flex: 1 1 auto;
    min-width: 0;
  }

  .datanoa-discovery-count {
    font-family: var(--mono-font);
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .datanoa-discovery-body {
    padding: 8px;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg) 55%, var(--surface));
  }

  .datanoa-discovery-badges {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }

  .datanoa-badge-neutral {
    background: var(--surface);
    color: var(--muted);
    border: 1px solid var(--border);
  }

  .datanoa-badge-ok {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent);
  }

  .datanoa-badge-info {
    background: color-mix(in srgb, var(--info) 14%, transparent);
    color: var(--info);
    border: 1px solid color-mix(in srgb, var(--info) 45%, transparent);
  }

  .datanoa-badge-warn {
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    color: var(--warn);
    border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  }

  .datanoa-conn-chip-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 180px;
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
    border-color: color-mix(in srgb, var(--accent-ring) 65%, var(--border-strong));
    background: color-mix(in srgb, var(--accent-ring) 10%, var(--card));
  }

  .datanoa-conn-chip.selected {
    border-color: var(--accent-ring);
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

  .datanoa-modal-box.is-pinned,
  .datanoa-saved-notice.is-pinned {
    margin: 12px 16px 0;
    flex-shrink: 0;
    max-height: 160px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text);
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

  .datanoa-sidebar-error {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 8px;
    padding: 8px;
    border-radius: var(--radius);
    border: 1px solid var(--danger-border);
    background: var(--danger-tint);
    font-size: 12px;
    line-height: 1.4;
  }

  .datanoa-sidebar-error-title {
    font-weight: 500;
    color: var(--danger);
    word-break: break-word;
  }

  .datanoa-sidebar-error-msg {
    font-family: var(--mono-font);
    color: var(--text);
    max-height: 120px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .datanoa-sidebar-error-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .datanoa-topbar-error-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    height: 24px;
    padding: 0 8px;
    border-radius: var(--radius-sm, 6px);
    border: 1px solid var(--danger-border);
    background: var(--danger-tint);
    color: var(--danger);
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .datanoa-topbar-error-pill:hover {
    border-color: var(--danger);
  }

  .datanoa-topbar-error-pill:focus-visible {
    outline: 2px solid var(--danger);
    outline-offset: 1px;
  }

  .datanoa-topbar-count.has-error {
    color: var(--danger);
    font-variant-numeric: tabular-nums;
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
    background: var(--popover);
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

  /* Import Data (CSV / TSV / JSON / NDJSON) Modal */
  .datanoa-import-modal {
    width: min(860px, 95vw);
    max-height: calc(100vh - 44px);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--popover);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-import-dropzone {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface);
    transition: border-color 120ms ease, background 120ms ease;
  }

  .datanoa-import-dropzone.dragover {
    border-color: var(--accent-ring);
    background: color-mix(in srgb, var(--accent-ring) 12%, var(--surface));
  }

  .datanoa-import-dropzone-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 240px;
  }

  .datanoa-import-dropzone-title {
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-import-dropzone-sub {
    font-size: 11px;
    color: var(--muted);
  }

  .datanoa-import-options-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-import-flags-row {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    grid-column: 1 / -1;
    padding-top: 2px;
  }

  .datanoa-import-section-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .datanoa-import-mapping-wrap {
    max-height: 210px;
    overflow: auto;
    margin-bottom: 0;
  }

  .datanoa-import-preview-wrap {
    max-height: 175px;
    overflow: auto;
    margin-bottom: 0;
  }

  .datanoa-import-sample-cell {
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
    font-family: var(--mono-font);
    font-size: 11.5px;
  }

  .datanoa-import-mode-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-import-mode-option {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
  }

  .datanoa-import-mode-option.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .datanoa-import-actions {
    justify-content: space-between;
  }

  .datanoa-import-summary {
    font-size: 11.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 720px) {
    .datanoa-import-options-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }


  /* Driver Manager Modal (Built-in + BYOD Local Paths) */
  .datanoa-driver-mgr-modal {
    width: min(720px, 94vw);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--popover);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-driver-mgr-modal .datanoa-modal-body {
    flex: 1 1 auto;
    min-height: 0;
    gap: 10px;
  }

  .datanoa-driver-mgr-builtin-list,
  .datanoa-driver-mgr-byod-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .datanoa-driver-mgr-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-driver-mgr-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  .datanoa-driver-mgr-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .datanoa-driver-mgr-name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
  }

  .datanoa-driver-mgr-meta {
    font-size: 11.5px;
    color: var(--muted);
    overflow-wrap: anywhere;
    white-space: normal;
    max-width: 100%;
  }

  .datanoa-driver-mgr-badges,
  .datanoa-driver-mgr-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .datanoa-driver-mgr-byod {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-driver-mgr-byod-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .datanoa-driver-mgr-pill {
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    color: var(--muted);
    white-space: nowrap;
  }

  .datanoa-driver-mgr-pill.is-verified {
    color: var(--ok);
    border-color: var(--ok);
    background: color-mix(in srgb, var(--ok) 12%, var(--bg));
  }

  .datanoa-driver-mgr-pill.is-error {
    color: var(--danger);
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 12%, var(--bg));
  }

  .datanoa-driver-mgr-badges .datanoa-badge {
    border: 1px solid var(--border-strong);
    background: var(--card);
    color: var(--muted);
  }

  .datanoa-driver-mgr-hash {
    font-family: var(--mono-font);
    font-size: 11px;
    color: var(--muted);
    user-select: text;
  }

  .datanoa-driver-mgr-guide {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 8px 10px;
  }

  .datanoa-driver-mgr-guide-summary {
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: var(--info);
    user-select: none;
  }

  .datanoa-driver-mgr-guide-body {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .datanoa-driver-mgr-guide-steps {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11.5px;
    color: var(--text);
    line-height: 1.45;
  }

  html.light .datanoa-driver-mgr-modal,
  body.light .datanoa-driver-mgr-modal {
    background: var(--popover);
    border-color: var(--border-strong);
  }

  html.light .datanoa-driver-mgr-row,
  body.light .datanoa-driver-mgr-row,
  html.light .datanoa-driver-mgr-byod,
  body.light .datanoa-driver-mgr-byod {
    background: var(--surface);
    border-color: var(--border);
  }

  html.light .datanoa-driver-mgr-pill:not(.is-verified):not(.is-error),
  body.light .datanoa-driver-mgr-pill:not(.is-verified):not(.is-error) {
    color: var(--muted);
    border-color: var(--border-strong);
  }

  /* Saved Queries / SQL Snippets Library Modal */
  .datanoa-saved-queries-modal {
    width: min(860px, 96vw);
    max-width: 860px;
  }

  .datanoa-saved-queries-modal .datanoa-modal-body {
    gap: 10px;
  }

  .datanoa-saved-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .datanoa-saved-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .datanoa-saved-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
  }

  .datanoa-saved-form .datanoa-filter-input,
  .datanoa-saved-filter,
  .datanoa-create-table-modal .datanoa-filter-input,
  .datanoa-danger-modal .datanoa-filter-input {
    width: 100%;
    flex: 0 0 auto;
    height: 28px;
    box-sizing: border-box;
  }

  .datanoa-saved-sql-input {
    width: 100%;
    box-sizing: border-box;
  }

  .datanoa-saved-sql-input {
    min-height: 88px;
    padding: 8px;
    resize: vertical;
    border: 1px solid var(--input-border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--text);
    font-family: var(--mono-font);
    font-size: 12px;
    line-height: 1.5;
  }

  .datanoa-saved-form-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .datanoa-saved-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 300px;
    overflow-y: auto;
  }

  .datanoa-saved-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
  }

  .datanoa-saved-item.is-editing {
    border-color: var(--warn);
    box-shadow: inset 0 0 0 1px var(--warn);
  }

  .datanoa-saved-item-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  .datanoa-saved-item-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .datanoa-saved-tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    color: var(--info);
    background: color-mix(in srgb, var(--info) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--info) 40%, transparent);
  }

  .datanoa-saved-preview {
    font-family: var(--mono-font);
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .datanoa-saved-item-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .datanoa-saved-notice {
    padding: 7px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 12px;
  }

  .datanoa-saved-notice.error {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, var(--bg));
    color: var(--danger);
  }

  .datanoa-saved-empty {
    padding: 14px;
    text-align: center;
    font-size: 12px;
    color: var(--muted);
  }

  html.light .datanoa-saved-form,
  body.light .datanoa-saved-form,
  html.light .datanoa-saved-item,
  body.light .datanoa-saved-item {
    background: var(--surface);
    border-color: var(--border-strong);
  }

  html.light .datanoa-saved-notice:not(.error),
  body.light .datanoa-saved-notice:not(.error) {
    background: var(--surface);
  }

  /* In-app File & Folder Picker Modal */
  .datanoa-fp-overlay {
    z-index: 10120;
  }

  .datanoa-fp-modal {
    width: min(620px, 94vw);
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--popover);
    box-shadow: var(--menu-shadow);
    overflow: hidden;
  }

  .datanoa-fp-body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .datanoa-fp-roots {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .datanoa-fp-root {
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }

  .datanoa-fp-root:hover {
    background: var(--hover);
    color: var(--text);
    border-color: var(--border-strong);
  }

  .datanoa-fp-root.is-active {
    background: color-mix(in srgb, var(--accent-ring) 14%, var(--surface));
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent-ring) 65%, var(--border-strong));
  }

  .datanoa-fp-root:focus-visible,
  .datanoa-fp-row:focus-visible {
    outline: 1.5px solid var(--accent-ring);
    outline-offset: -1.5px;
  }

  .datanoa-fp-nav {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .datanoa-fp-up {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .datanoa-fp-path {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 12px;
  }

  .datanoa-fp-filter {
    width: 100%;
    font-size: 12px;
  }

  .datanoa-fp-list {
    flex: 1 1 auto;
    min-height: 220px;
    max-height: 360px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .datanoa-fp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 32px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition: background-color 100ms ease, border-color 100ms ease;
  }

  .datanoa-fp-row:hover {
    background: var(--hover);
  }

  .datanoa-fp-row.is-selected {
    background: color-mix(in srgb, var(--accent-ring) 14%, var(--surface));
    border-color: color-mix(in srgb, var(--accent-ring) 65%, var(--border-strong));
  }

  .datanoa-fp-icon {
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    flex-shrink: 0;
  }

  .datanoa-fp-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-fp-meta {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .datanoa-fp-empty {
    padding: 24px 12px;
    text-align: center;
    font-size: 12px;
    color: var(--muted);
  }

  .datanoa-fp-status {
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .datanoa-fp-status.is-error {
    color: var(--danger);
  }

  .datanoa-fp-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  .datanoa-fp-selected {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--mono-font);
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .datanoa-fp-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
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