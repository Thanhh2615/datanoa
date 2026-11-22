// src/editor/studio-sidebar.ts
// Schema Explorer sidebar rendering, horizontal topbar pills, SQL template builders,
// and object context menu for DatanoaStudioEditor.

import { quoteIdentForDialect } from '../drivers/common/sql-tools.js'
import type {
  ConnectionProfile,
  DatabaseDriverType,
  SchemaObject,
  SchemaObjectKind,
  TableDetails,
} from '../protocol.js'
import { copyTextFallback, createSvgElement } from './db-icons.js'

export function getObjectKindShortLabel(kind: SchemaObjectKind): string {
  switch (kind) {
    case 'table':
      return 'TBL'
    case 'view':
      return 'VIEW'
    case 'materialized_view':
      return 'MAT VIEW'
    case 'function':
      return 'FN'
    case 'procedure':
      return 'PROC'
    case 'trigger':
      return 'TRIG'
    case 'sequence':
      return 'SEQ'
    case 'type':
      return 'TYPE'
  }
}

export function isTabularObjectKind(kind: SchemaObjectKind): boolean {
  return kind === 'table' || kind === 'view' || kind === 'materialized_view'
}

export function formatQualifiedSqlTable(item: SchemaObject, driver: DatabaseDriverType): string {
  const quotedName = quoteIdentForDialect(item.name, driver)
  if (
    item.schema &&
    item.schema !== 'main' &&
    driver !== 'sqlite' &&
    driver !== 'libsql' &&
    driver !== 'd1' &&
    driver !== 'redis'
  ) {
    return `${quoteIdentForDialect(item.schema, driver)}.${quotedName}`
  }
  return quotedName
}

export function buildSqlTemplateForObject(
  item: SchemaObject,
  kind: 'select' | 'insert' | 'update',
  driver: DatabaseDriverType,
  columns: TableDetails['columns'],
  primaryKey: string[]
): string {
  const tableRef = formatQualifiedSqlTable(item, driver)
  const colNames = columns.map((c) => c.name)

  if (kind === 'select') {
    const colList =
      colNames.length > 0
        ? colNames.map((name) => quoteIdentForDialect(name, driver)).join(', ')
        : '*'
    return `SELECT ${colList}\nFROM ${tableRef}\nLIMIT 100;`
  }

  if (kind === 'insert') {
    const editableCols = columns.filter((c) => !c.isAutoIncrement)
    const targetCols = editableCols.length > 0 ? editableCols : columns
    if (targetCols.length > 0) {
      const colsSql = targetCols.map((c) => quoteIdentForDialect(c.name, driver)).join(', ')
      const valsSql = targetCols
        .map((c) =>
          /INT|REAL|FLOAT|NUMERIC|DECIMAL/i.test(c.type)
            ? '0'
            : /BOOL/i.test(c.type)
              ? 'false'
              : "''"
        )
        .join(', ')
      return `INSERT INTO ${tableRef} (${colsSql})\nVALUES (${valsSql});`
    }
    return `INSERT INTO ${tableRef} ()\nVALUES ();`
  }

  const pkSet = new Set(primaryKey)
  const setCols = columns.filter((c) => !pkSet.has(c.name) && !c.isAutoIncrement)
  const effectiveSetCols = setCols.length > 0 ? setCols : columns
  const setSql =
    effectiveSetCols.length > 0
      ? effectiveSetCols
          .map((c) => {
            const val = /INT|REAL|FLOAT|NUMERIC|DECIMAL/i.test(c.type)
              ? '0'
              : /BOOL/i.test(c.type)
                ? 'false'
                : "''"
            return `${quoteIdentForDialect(c.name, driver)} = ${val}`
          })
          .join(',\n  ')
      : `${quoteIdentForDialect('column_name', driver)} = ''`
  const whereCols = primaryKey.length > 0 ? primaryKey : colNames.slice(0, 1)
  const whereSql =
    whereCols.length > 0
      ? whereCols.map((c) => `${quoteIdentForDialect(c, driver)} = ''`).join(' AND ')
      : '1 = 0'
  return `UPDATE ${tableRef}\nSET ${setSql}\nWHERE ${whereSql};`
}

export interface SidebarContextMenuCallbacks {
  clientX: number
  clientY: number
  item: SchemaObject
  driver: DatabaseDriverType
  isReadOnly: boolean
  activeViewMode: 'split' | 'grid' | 'sql' | 'inspector'
  closeMenus: () => void
  onSelectReadOnlyObject: (item: SchemaObject) => void
  onSelectSidebarObject: (item: SchemaObject) => void
  onSwitchMode: (mode: 'split' | 'grid' | 'sql' | 'inspector') => void
  onUpdateStatus: (msg: string) => void
  onCopyObjectDdl: (item: SchemaObject) => void
  onOpenObjectDdlInConsole: (item: SchemaObject) => void
  onCountRows: (item: SchemaObject) => void
  onGenerateSql: (item: SchemaObject, kind: 'select' | 'insert' | 'update') => void
  onOpenImportModal: (item: SchemaObject) => void
  onOpenDangerModal: (action: 'truncate' | 'drop', item: SchemaObject) => void
}

const NON_TABULAR_KINDS: readonly SchemaObjectKind[] = [
  'function',
  'procedure',
  'trigger',
  'sequence',
  'type',
]

export function createSidebarContextMenu(opts: SidebarContextMenuCallbacks): HTMLDivElement {
  const {
    clientX,
    clientY,
    item,
    driver,
    isReadOnly,
    activeViewMode,
    closeMenus,
    onSelectReadOnlyObject,
    onSelectSidebarObject,
    onSwitchMode,
    onUpdateStatus,
    onCopyObjectDdl,
    onOpenObjectDdlInConsole,
    onCountRows,
    onGenerateSql,
    onOpenImportModal,
    onOpenDangerModal,
  } = opts

  const menu = document.createElement('div')
  menu.className = 'datanoa-context-menu'

  const addItem = (
    label: string,
    onClick: () => void,
    itemOpts?: { danger?: boolean; disabled?: boolean }
  ): void => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `datanoa-context-item${itemOpts?.danger ? ' danger' : ''}`
    btn.textContent = label
    if (itemOpts?.disabled) {
      btn.disabled = true
    }
    btn.addEventListener('click', () => {
      if (itemOpts?.disabled) return
      closeMenus()
      onClick()
    })
    menu.appendChild(btn)
  }

  const addSep = (): void => {
    const sep = document.createElement('div')
    sep.className = 'datanoa-context-sep'
    menu.appendChild(sep)
  }

  const placeMenu = (): HTMLDivElement => {
    document.body.appendChild(menu)
    const rect = menu.getBoundingClientRect()
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768
    const left = Math.max(6, Math.min(clientX, vw - rect.width - 8))
    const top = Math.max(6, Math.min(clientY, vh - rect.height - 8))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
    return menu
  }

  const isRedis = driver === 'redis'

  if (NON_TABULAR_KINDS.includes(item.kind)) {
    addItem('View DDL', () => onSelectReadOnlyObject(item))
    addItem('Copy Name', () => {
      copyTextFallback(item.name)
      onUpdateStatus(`Copied "${item.name}" to clipboard`)
    })
    addItem('Copy DDL', () => onCopyObjectDdl(item))
    addItem('Open DDL in Console', () => onOpenObjectDdlInConsole(item))
    return placeMenu()
  }

  if (item.kind === 'materialized_view') {
    addItem('Open Data', () => {
      onSelectSidebarObject(item)
      if (activeViewMode === 'inspector') {
        onSwitchMode('split')
      }
    })
    addItem('View DDL', () => onSelectReadOnlyObject(item))
    addItem('Copy Name', () => {
      copyTextFallback(item.name)
      onUpdateStatus(`Copied "${item.name}" to clipboard`)
    })
    addItem('Copy SELECT *', () => {
      const tableRef = formatQualifiedSqlTable(item, driver)
      const selectSql = `SELECT * FROM ${tableRef} LIMIT 100;`
      copyTextFallback(selectSql)
      onUpdateStatus(`Copied "${selectSql}" to clipboard`)
    })
    return placeMenu()
  }

  addItem('Open Data', () => {
    onSelectSidebarObject(item)
    if (activeViewMode === 'inspector') {
      onSwitchMode('split')
    }
  })
  addItem('Count Rows', () => onCountRows(item), { disabled: isRedis })
  addSep()
  addItem('Generate SELECT', () => onGenerateSql(item, 'select'))
  addItem('Generate INSERT', () => onGenerateSql(item, 'insert'))
  addItem('Generate UPDATE', () => onGenerateSql(item, 'update'))
  addSep()
  addItem('Inspect Schema & DDL', () => {
    onSelectSidebarObject(item)
    onSwitchMode('inspector')
  })
  if (item.kind === 'table') {
    addItem('Edit Table Structure', () => {
      onSelectSidebarObject(item)
      onSwitchMode('inspector')
    })
    if (!isRedis) {
      addItem('Import CSV / JSON...', () => onOpenImportModal(item), { disabled: isReadOnly })
    }
  }
  addItem('Copy Table Name', () => {
    copyTextFallback(item.name)
    onUpdateStatus(`Copied "${item.name}" to clipboard`)
  })
  addItem(
    'Copy SELECT *',
    () => {
      const tableRef = formatQualifiedSqlTable(item, driver)
      const selectSql = `SELECT * FROM ${tableRef} LIMIT 100;`
      copyTextFallback(selectSql)
      onUpdateStatus(`Copied "${selectSql}" to clipboard`)
    },
    { disabled: isRedis }
  )

  if (!isRedis) {
    addSep()
    if (item.kind === 'table') {
      addItem('Truncate Table...', () => onOpenDangerModal('truncate', item), {
        danger: true,
        disabled: isReadOnly,
      })
    }
    addItem(
      item.kind === 'view' ? 'Drop View...' : 'Drop Table...',
      () => onOpenDangerModal('drop', item),
      { danger: true, disabled: isReadOnly }
    )
  }

  return placeMenu()
}

export function renderStudioSidebarSkeleton(
  sidebarListEl: HTMLElement | null,
  topbarTrackEl: HTMLElement | null,
  topbarCountEl: HTMLElement | null
): void {
  if (sidebarListEl) {
    sidebarListEl.innerHTML = ''
    const skelWrap = document.createElement('div')
    skelWrap.className = 'datanoa-sidebar-skeleton'
    for (const w of [72, 58, 84, 64, 78, 52]) {
      const bar = document.createElement('div')
      bar.className = 'datanoa-skeleton-bar'
      bar.style.width = `${w}%`
      skelWrap.appendChild(bar)
    }
    sidebarListEl.appendChild(skelWrap)
  }
  if (topbarTrackEl) {
    topbarTrackEl.innerHTML = ''
    const topSkel = document.createElement('div')
    topSkel.className = 'datanoa-sidebar-skeleton'
    topSkel.style.flexDirection = 'row'
    topSkel.style.padding = '0 4px'
    for (let i = 0; i < 4; i++) {
      const bar = document.createElement('div')
      bar.className = 'datanoa-skeleton-bar'
      bar.style.width = `${64 + (i % 3) * 18}px`
      bar.style.height = '18px'
      topSkel.appendChild(bar)
    }
    topbarTrackEl.appendChild(topSkel)
  }
  if (topbarCountEl) {
    topbarCountEl.textContent = '...'
  }
}

export interface RenderTopbarObjectsOptions {
  filtered: SchemaObject[]
  totalCount: number
  totalTableCount?: number
  filterQuery: string
  sidebarCollapsed: boolean
  topbarCountEl: HTMLElement | null
  topbarAllBtn: HTMLButtonElement | null
  topbarTrackEl: HTMLElement | null
  isObjectActive: (name: string, schema: string | undefined, kind: SchemaObjectKind) => boolean
  onActivateObject: (item: SchemaObject) => void
  onOpenContextMenu: (clientX: number, clientY: number, item: SchemaObject) => void
  onScrollActiveIntoView: () => void
}

export function renderStudioTopbarObjects(opts: RenderTopbarObjectsOptions): void {
  const {
    filtered,
    totalTableCount,
    filterQuery,
    sidebarCollapsed,
    topbarCountEl,
    topbarAllBtn,
    topbarTrackEl,
    isObjectActive,
    onActivateObject,
    onOpenContextMenu,
    onScrollActiveIntoView,
  } = opts

  const filteredTables = filtered.filter((item) => item.kind === 'table')
  const effectiveTotalTables =
    typeof totalTableCount === 'number' && Number.isFinite(totalTableCount)
      ? totalTableCount
      : filteredTables.length

  if (topbarCountEl) {
    topbarCountEl.textContent =
      filterQuery && filteredTables.length !== effectiveTotalTables
        ? `${filteredTables.length}/${effectiveTotalTables}`
        : String(effectiveTotalTables)
    topbarCountEl.title = `${filteredTables.length} table(s) shown in bar`
  }
  if (topbarAllBtn) {
    topbarAllBtn.textContent = `All (${filtered.length}) ▾`
  }
  if (!topbarTrackEl) return
  topbarTrackEl.innerHTML = ''

  if (filteredTables.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'datanoa-cell-null'
    empty.style.padding = '0 8px'
    empty.textContent = filterQuery ? `No tables match "${filterQuery}"` : 'No tables'
    topbarTrackEl.appendChild(empty)
    return
  }

  for (const item of filteredTables) {
    const pill = document.createElement('button')
    pill.type = 'button'
    const isActive = isObjectActive(item.name, item.schema, item.kind)
    pill.className = `datanoa-topbar-pill${isActive ? ' active' : ''}`
    if (pill.dataset) {
      pill.dataset.tableName = item.name
      pill.dataset.tableSchema = item.schema || ''
      pill.dataset.objectKind = item.kind
    }
    pill.title = `${item.schema ? `${item.schema}.` : ''}${item.name} (TABLE)`

    const nameSpan = document.createElement('span')
    nameSpan.textContent = item.name
    pill.appendChild(nameSpan)

    pill.addEventListener('click', () => onActivateObject(item))
    pill.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      onOpenContextMenu(e.clientX, e.clientY, item)
    })
    topbarTrackEl.appendChild(pill)
  }

  if (sidebarCollapsed) {
    onScrollActiveIntoView()
  }
}

export interface RenderTopbarObjectsPopoverOptions {
  popoverEl: HTMLElement
  objects: SchemaObject[]
  initialFilterQuery?: string
  collapsedGroups: Set<SchemaObjectKind>
  isObjectActive: (name: string, schema: string | undefined, kind: SchemaObjectKind) => boolean
  onSelectObject: (item: SchemaObject) => void
  onOpenContextMenu?: (clientX: number, clientY: number, item: SchemaObject) => void
  onClose?: () => void
}

function createDoubleChevronSvg(expand: boolean): SVGElement {
  const svg = createSvgElement('svg', {
    width: '11',
    height: '11',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(
    createSvgElement('polyline', {
      points: expand ? '7 13 12 18 17 13' : '17 11 12 6 7 11',
    })
  )
  svg.appendChild(
    createSvgElement('polyline', {
      points: expand ? '7 6 12 11 17 6' : '17 18 12 13 7 18',
    })
  )
  return svg
}

export function renderStudioTopbarObjectsPopover(
  opts: RenderTopbarObjectsPopoverOptions
): { focusSearch: () => void } {
  const {
    popoverEl,
    objects,
    initialFilterQuery = '',
    collapsedGroups,
    isObjectActive,
    onSelectObject,
    onOpenContextMenu,
    onClose,
  } = opts

  popoverEl.innerHTML = ''
  popoverEl.setAttribute('role', 'listbox')

  let localQuery = initialFilterQuery

  const head = document.createElement('div')
  head.className = 'datanoa-topbar-popover-head'

  const searchInp = document.createElement('input')
  searchInp.type = 'search'
  searchInp.className = 'datanoa-topbar-popover-search'
  searchInp.placeholder = 'Filter objects by name or type...'
  searchInp.value = localQuery

  const expandAllBtn = document.createElement('button')
  expandAllBtn.type = 'button'
  expandAllBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-topbar-expand-all-btn'
  expandAllBtn.title = 'Expand all object types'
  expandAllBtn.setAttribute('aria-label', 'Expand all object types')
  expandAllBtn.appendChild(createDoubleChevronSvg(true))

  const collapseAllBtn = document.createElement('button')
  collapseAllBtn.type = 'button'
  collapseAllBtn.className = 'datanoa-btn datanoa-btn-sm datanoa-topbar-collapse-all-btn'
  collapseAllBtn.title = 'Collapse all object types'
  collapseAllBtn.setAttribute('aria-label', 'Collapse all object types')
  collapseAllBtn.appendChild(createDoubleChevronSvg(false))

  head.appendChild(searchInp)
  head.appendChild(expandAllBtn)
  head.appendChild(collapseAllBtn)

  const listEl = document.createElement('div')
  listEl.className = 'datanoa-topbar-popover-list'

  const getGroupedObjects = (q: string) => {
    const trimmed = q.trim().toLowerCase()
    return SCHEMA_OBJECT_GROUPS.map((group) => {
      const groupLabelMatches =
        !trimmed ||
        group.label.toLowerCase().includes(trimmed) ||
        group.badge.toLowerCase().includes(trimmed)
      const items = objects
        .filter((item) => {
          if (item.kind !== group.kind) return false
          if (!trimmed || groupLabelMatches) return true
          const qualified = item.schema ? `${item.schema}.${item.name}` : item.name
          return qualified.toLowerCase().includes(trimmed)
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      return { ...group, items }
    }).filter((group) => group.items.length > 0)
  }

  const renderGroups = (): void => {
    listEl.innerHTML = ''
    const q = localQuery.trim()
    const isFiltering = q.length > 0
    expandAllBtn.disabled = isFiltering
    collapseAllBtn.disabled = isFiltering
    expandAllBtn.title = isFiltering ? 'Clear filter to expand groups' : 'Expand all object types'
    collapseAllBtn.title = isFiltering ? 'Clear filter to collapse groups' : 'Collapse all object types'
    const nonEmptyGroups = getGroupedObjects(q)

    if (nonEmptyGroups.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'datanoa-cell-null'
      empty.style.padding = '10px 8px'
      empty.style.textAlign = 'center'
      empty.textContent = q ? `No objects match "${q}"` : 'No objects available'
      listEl.appendChild(empty)
      return
    }

    for (const group of nonEmptyGroups) {
      const groupWrap = document.createElement('div')
      groupWrap.className = 'datanoa-topbar-group'

      const isCollapsed = !q && collapsedGroups.has(group.kind)

      const headerBtn = document.createElement('button')
      headerBtn.type = 'button'
      headerBtn.className = 'datanoa-topbar-group-header'
      headerBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true')
      if (headerBtn.dataset) {
        headerBtn.dataset.groupKind = group.kind
      }
      headerBtn.title = q
        ? 'Clear filter to collapse groups'
        : `${isCollapsed ? 'Expand' : 'Collapse'} ${group.label} (${group.items.length})`

      const chev = document.createElement('span')
      chev.className = 'datanoa-topbar-group-chev'
      chev.textContent = isCollapsed ? '▸' : '▾'

      const labelSpan = document.createElement('span')
      labelSpan.className = 'datanoa-topbar-group-label'
      labelSpan.textContent = group.label

      const countSpan = document.createElement('span')
      countSpan.className = 'datanoa-topbar-group-count'
      countSpan.textContent = String(group.items.length)

      headerBtn.appendChild(chev)
      headerBtn.appendChild(labelSpan)
      headerBtn.appendChild(countSpan)
      headerBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (q) return
        if (collapsedGroups.has(group.kind)) {
          collapsedGroups.delete(group.kind)
        } else {
          collapsedGroups.add(group.kind)
        }
        renderGroups()
      })
      groupWrap.appendChild(headerBtn)

      if (!isCollapsed) {
        const itemsWrap = document.createElement('div')
        itemsWrap.className = 'datanoa-topbar-group-items'

        for (const item of group.items) {
          const btn = document.createElement('button')
          btn.type = 'button'
          const isActive = isObjectActive(item.name, item.schema, item.kind)
          btn.className = `datanoa-topbar-popover-item${isActive ? ' active' : ''}`
          const displayName = item.schema ? `${item.schema}.${item.name}` : item.name
          btn.title = `${displayName} (${group.label})`

          const nameSpan = document.createElement('span')
          nameSpan.className = 'datanoa-topbar-popover-item-name'
          nameSpan.textContent = displayName

          const kindSpan = document.createElement('span')
          kindSpan.className = `datanoa-topbar-pill-kind datanoa-object-kind-badge datanoa-kind-${item.kind}`
          kindSpan.textContent = group.badge

          btn.appendChild(nameSpan)
          btn.appendChild(kindSpan)
          btn.addEventListener('click', (e) => {
            e.stopPropagation()
            onSelectObject(item)
          })
          if (onOpenContextMenu) {
            btn.addEventListener('contextmenu', (e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenContextMenu(e.clientX, e.clientY, item)
            })
          }
          itemsWrap.appendChild(btn)
        }

        groupWrap.appendChild(itemsWrap)
      }

      listEl.appendChild(groupWrap)
    }
  }

  expandAllBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    collapsedGroups.clear()
    renderGroups()
  })

  collapseAllBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    for (const group of getGroupedObjects(localQuery)) {
      collapsedGroups.add(group.kind)
    }
    renderGroups()
  })

  searchInp.addEventListener('input', () => {
    localQuery = searchInp.value
    renderGroups()
  })

  searchInp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose?.()
    }
  })

  popoverEl.appendChild(head)
  popoverEl.appendChild(listEl)
  renderGroups()

  return {
    focusSearch: () => {
      searchInp.focus?.()
    },
  }
}

export interface RenderSidebarObjectsOptions {
  sidebarListEl: HTMLElement | null
  schemaObjects: SchemaObject[]
  filterQuery: string
  activeConnectionId: string | null
  activeConnection: ConnectionProfile | undefined
  collapsedGroups: Set<SchemaObjectKind>
  isObjectActive: (name: string, schema: string | undefined, kind: SchemaObjectKind) => boolean
  onOpenConnectionModal: () => void
  onOpenCreateTableModal: () => void
  onToggleGroup: (kind: SchemaObjectKind) => void
  onActivateObject: (item: SchemaObject) => void
  onOpenContextMenu: (clientX: number, clientY: number, item: SchemaObject) => void
}

export const SCHEMA_OBJECT_GROUPS: ReadonlyArray<{
  kind: SchemaObjectKind
  label: string
  badge: string
}> = [
  { kind: 'table', label: 'Tables', badge: 'TBL' },
  { kind: 'view', label: 'Views', badge: 'VIEW' },
  { kind: 'materialized_view', label: 'Materialized Views', badge: 'MAT VIEW' },
  { kind: 'sequence', label: 'Sequences', badge: 'SEQ' },
  { kind: 'function', label: 'Functions', badge: 'FN' },
  { kind: 'procedure', label: 'Procedures', badge: 'PROC' },
  { kind: 'trigger', label: 'Triggers', badge: 'TRIG' },
  { kind: 'type', label: 'Types', badge: 'TYPE' },
]

export function renderStudioSidebarList(
  opts: RenderSidebarObjectsOptions,
  filtered: SchemaObject[]
): void {
  const {
    sidebarListEl,
    filterQuery,
    activeConnectionId,
    activeConnection,
    collapsedGroups,
    isObjectActive,
    onOpenConnectionModal,
    onOpenCreateTableModal,
    onToggleGroup,
    onActivateObject,
    onOpenContextMenu,
  } = opts
  if (!sidebarListEl) return
  sidebarListEl.innerHTML = ''

  if (!activeConnectionId) {
    const emptyConnWrap = document.createElement('div')
    emptyConnWrap.className = 'datanoa-sidebar-empty-cta'
    const emptyConnText = document.createElement('div')
    emptyConnText.className = 'datanoa-cell-null'
    emptyConnText.textContent = 'No database connection selected'
    const connectBtn = document.createElement('button')
    connectBtn.type = 'button'
    connectBtn.className = 'datanoa-btn datanoa-btn-primary datanoa-btn-sm'
    connectBtn.textContent = '+ Connect Database'
    connectBtn.addEventListener('click', onOpenConnectionModal)
    emptyConnWrap.appendChild(emptyConnText)
    emptyConnWrap.appendChild(connectBtn)
    sidebarListEl.appendChild(emptyConnWrap)
    return
  }

  const nonEmptyGroups = SCHEMA_OBJECT_GROUPS.map((group) => ({
    ...group,
    items: filtered.filter((o) => o.kind === group.kind),
  })).filter((group) => group.items.length > 0)

  if (nonEmptyGroups.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'datanoa-cell-null'
    empty.style.padding = '12px'
    empty.textContent = filterQuery ? `No objects match "${filterQuery}"` : 'No objects'
    sidebarListEl.appendChild(empty)

    if (
      !filterQuery &&
      activeConnection &&
      !activeConnection.readOnly &&
      activeConnection.driver !== 'redis'
    ) {
      const ctaWrap = document.createElement('div')
      ctaWrap.style.padding = '0 12px 12px'
      const ctaBtn = document.createElement('button')
      ctaBtn.type = 'button'
      ctaBtn.className = 'datanoa-btn datanoa-btn-primary datanoa-btn-sm'
      ctaBtn.textContent = '+ New Table'
      ctaBtn.addEventListener('click', onOpenCreateTableModal)
      ctaWrap.appendChild(ctaBtn)
      sidebarListEl.appendChild(ctaWrap)
    }
    return
  }

  for (const group of nonEmptyGroups) {
    const groupWrap = document.createElement('div')
    groupWrap.className = 'datanoa-sidebar-group'

    const isCollapsed = !filterQuery && collapsedGroups.has(group.kind)

    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'datanoa-sidebar-group-header'
    header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true')
    if (filterQuery) {
      header.title = 'Clear filter to collapse groups'
    }

    const chevron = document.createElement('span')
    chevron.className = 'datanoa-sidebar-group-chevron'
    chevron.textContent = isCollapsed ? '▸' : '▾'

    const labelSpan = document.createElement('span')
    labelSpan.className = 'datanoa-sidebar-group-label'
    labelSpan.textContent = group.label

    const countSpan = document.createElement('span')
    countSpan.className = 'datanoa-sidebar-group-count'
    countSpan.textContent = String(group.items.length)

    header.appendChild(chevron)
    header.appendChild(labelSpan)
    header.appendChild(countSpan)
    header.addEventListener('click', () => {
      if (filterQuery) return
      onToggleGroup(group.kind)
    })
    groupWrap.appendChild(header)

    if (!isCollapsed) {
      const itemsWrap = document.createElement('div')
      itemsWrap.className = 'datanoa-sidebar-group-items'
      for (const item of group.items) {
        const btn = document.createElement('button')
        btn.type = 'button'
        const isActive = isObjectActive(item.name, item.schema, item.kind)
        btn.className = `datanoa-sidebar-item${isActive ? ' active' : ''}`
        if (btn.dataset) {
          btn.dataset.tableName = item.name
          btn.dataset.tableSchema = item.schema || ''
          btn.dataset.objectKind = item.kind
        }
        btn.title = item.detail ? `${item.name} (${item.detail})` : item.name
        const nameSpan = document.createElement('span')
        nameSpan.className = 'datanoa-sidebar-item-name'
        nameSpan.textContent = item.name
        const kindSpan = document.createElement('span')
        kindSpan.className = `datanoa-sidebar-item-kind datanoa-object-kind-badge datanoa-kind-${item.kind}`
        kindSpan.textContent = group.badge
        btn.appendChild(nameSpan)
        btn.appendChild(kindSpan)
        btn.addEventListener('click', () => onActivateObject(item))
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          onOpenContextMenu(e.clientX, e.clientY, item)
        })
        itemsWrap.appendChild(btn)
      }
      groupWrap.appendChild(itemsWrap)
    }

    sidebarListEl.appendChild(groupWrap)
  }
}
