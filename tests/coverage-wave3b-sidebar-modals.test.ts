import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { installDomHarness, type DomHarness } from './helpers/dom-harness.js'
import type {
  ConnectionProfile,
  DriverInspectResult,
  DriverRegistryItem,
  DriverVerifyResult,
  SavedQueryEntry,
  SchemaObject,
  SchemaObjectKind,
} from '../src/protocol.js'
import {
  getObjectKindShortLabel,
  isTabularObjectKind,
  formatQualifiedSqlTable,
  buildSelectPreviewSql,
  buildSqlTemplateForObject,
  createSidebarContextMenu,
  renderStudioSidebarSkeleton,
  renderStudioTopbarObjects,
  renderStudioTopbarObjectsPopover,
  SCHEMA_OBJECT_GROUPS,
  getSidebarObjectGroupLabel,
  renderStudioSidebarList,
} from '../src/editor/studio-sidebar.js'
import { openStudioSavedQueriesModal } from '../src/editor/saved-queries-modal.js'
import {
  getByodStarterTemplate,
  getByodNpmPackage,
  buildByodInstallCommand,
  openStudioDriverManagerModal,
} from '../src/editor/driver-manager-modal.js'

let dom: DomHarness

beforeEach(() => {
  dom = installDomHarness()
})

afterEach(() => {
  vi.useRealTimers()
  dom.teardown()
})

describe('Wave 3B Step 2: studio-sidebar.ts, saved-queries-modal.ts & driver-manager-modal.ts', () => {
  it('covers src/editor/studio-sidebar.ts SQL templates, context menus, topbar & sidebar lists + PBT', () => {
    const allKinds: SchemaObjectKind[] = [
      'table',
      'view',
      'materialized_view',
      'function',
      'procedure',
      'trigger',
      'sequence',
      'type',
    ]
    expect(allKinds.map(getObjectKindShortLabel)).toEqual([
      'TBL',
      'VIEW',
      'MAT VIEW',
      'FN',
      'PROC',
      'TRIG',
      'SEQ',
      'TYPE',
    ])
    expect(allKinds.map(isTabularObjectKind)).toEqual([true, true, true, false, false, false, false, false])

    const tblPublic: SchemaObject = { name: 'orders', schema: 'analytics', kind: 'table', detail: '4 cols' }
    const tblMain: SchemaObject = { name: 'items', schema: 'main', kind: 'table' }
    expect(formatQualifiedSqlTable(tblPublic, 'postgres')).toBe('"analytics"."orders"')
    expect(formatQualifiedSqlTable(tblPublic, 'sqlite')).toBe('"orders"')
    expect(formatQualifiedSqlTable(tblMain, 'postgres')).toBe('"items"')

    expect(buildSelectPreviewSql(tblPublic, 'mongodb')).toContain('db.getCollection("orders").find({})')
    expect(buildSelectPreviewSql(tblPublic, 'mssql')).toContain('SELECT TOP 100 *')
    expect(buildSelectPreviewSql(tblPublic, 'oracle')).toContain('FETCH FIRST 100 ROWS ONLY')
    expect(buildSelectPreviewSql(tblPublic, 'postgres')).toContain('LIMIT 100;')

    const cols = [
      { name: 'id', type: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
      { name: 'price', type: 'NUMERIC(10,2)', nullable: false, defaultValue: null, isPrimaryKey: false },
      { name: 'active', type: 'BOOLEAN', nullable: false, defaultValue: null, isPrimaryKey: false },
      { name: 'created_at', type: 'DATETIME', nullable: true, defaultValue: null, isPrimaryKey: false },
      { name: 'note', type: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false },
    ]
    // MongoDB templates (with writable cols & only _id fallback)
    expect(buildSqlTemplateForObject(tblPublic, 'select', 'mongodb', cols, ['id'])).toContain('.find({})')
    expect(buildSqlTemplateForObject(tblPublic, 'insert', 'mongodb', cols, ['id'])).toContain('.insertOne(')
    expect(
      buildSqlTemplateForObject(tblPublic, 'update', 'mongodb', [{ name: '_id', type: 'ObjectId', nullable: false, defaultValue: null, isPrimaryKey: true }], ['_id'])
    ).toContain('.updateOne(')

    // SQL dialects (mssql, oracle, postgres) across select/insert/update + empty/all-PK fallbacks
    expect(buildSqlTemplateForObject(tblPublic, 'select', 'mssql', cols, ['id'])).toContain('SELECT TOP 100')
    expect(buildSqlTemplateForObject(tblPublic, 'select', 'oracle', cols, ['id'])).toContain('FETCH FIRST 100 ROWS ONLY')
    expect(buildSqlTemplateForObject(tblPublic, 'select', 'postgres', [], [])).toContain('SELECT *')
    expect(buildSqlTemplateForObject(tblPublic, 'insert', 'postgres', cols, ['id'])).toContain('INSERT INTO')
    expect(
      buildSqlTemplateForObject(
        tblPublic,
        'insert',
        'postgres',
        [{ name: 'id', type: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }],
        ['id']
      )
    ).toContain('VALUES (0);')
    expect(buildSqlTemplateForObject(tblPublic, 'insert', 'postgres', [], [])).toContain('VALUES ();')
    expect(buildSqlTemplateForObject(tblPublic, 'update', 'postgres', cols, ['id'])).toContain('WHERE "id" = \'\';')
    expect(
      buildSqlTemplateForObject(
        tblPublic,
        'update',
        'postgres',
        [{ name: 'id', type: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true }],
        ['id']
      )
    ).toContain('"id" = 0')
    expect(buildSqlTemplateForObject(tblPublic, 'update', 'postgres', [], [])).toContain('WHERE 1 = 0;')

    fc.assert(
      fc.property(
        fc.constantFrom<'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'oracle' | 'mongodb'>(
          'sqlite',
          'postgres',
          'mysql',
          'mssql',
          'oracle',
          'mongodb'
        ),
        fc.constantFrom<'select' | 'insert' | 'update'>('select', 'insert', 'update'),
        fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/),
        (drv, kind, tbl) => {
          const out = buildSqlTemplateForObject({ name: tbl, kind: 'table' }, kind, drv, cols, ['id'])
          expect(out.length).toBeGreaterThan(5)
        }
      ),
      { numRuns: 24 }
    )

    expect(getSidebarObjectGroupLabel('table', 'mongodb')).toBe('Collections')
    expect(getSidebarObjectGroupLabel('table', 'redis')).toBe('Keyspaces')
    expect(getSidebarObjectGroupLabel('table', 'postgres')).toBe('Tables')
    expect(getSidebarObjectGroupLabel('view', 'postgres')).toBe('Views')
    expect(getSidebarObjectGroupLabel('custom_unknown' as SchemaObjectKind, 'postgres')).toBe('custom_unknown')

    // createSidebarContextMenu across function, materialized_view, postgres table, mongo collection, redis key & readOnly view
    const closeMenus = vi.fn()
    const onSelectReadOnlyObject = vi.fn()
    const onSelectSidebarObject = vi.fn()
    const onSwitchMode = vi.fn()
    const onUpdateStatus = vi.fn()
    const onCopyObjectDdl = vi.fn()
    const onOpenObjectDdlInConsole = vi.fn()
    const onCountRows = vi.fn()
    const onGenerateSql = vi.fn()
    const onOpenImportModal = vi.fn()
    const onOpenDangerModal = vi.fn()

    const menuKinds: Array<{ item: SchemaObject; driver: 'postgres' | 'mongodb' | 'redis'; readOnly: boolean; mode: 'inspector' | 'split' }> = [
      { item: { name: 'calc_fn', schema: 'public', kind: 'function' }, driver: 'postgres', readOnly: false, mode: 'split' },
      { item: { name: 'mv_sales', schema: 'public', kind: 'materialized_view' }, driver: 'postgres', readOnly: false, mode: 'inspector' },
      { item: tblPublic, driver: 'postgres', readOnly: false, mode: 'inspector' },
      { item: { name: 'docs', kind: 'table' }, driver: 'mongodb', readOnly: false, mode: 'split' },
      { item: { name: 'v_orders', schema: 'public', kind: 'view' }, driver: 'postgres', readOnly: true, mode: 'split' },
      { item: { name: 'keys', kind: 'table' }, driver: 'redis', readOnly: false, mode: 'split' },
    ]
    for (const cfg of menuKinds) {
      const m = createSidebarContextMenu({
        clientX: 1999,
        clientY: 1999,
        item: cfg.item,
        driver: cfg.driver,
        isReadOnly: cfg.readOnly,
        activeViewMode: cfg.mode,
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
      })
      for (const btn of m.querySelectorAll('button')) {
        dom.click(btn)
        if ((btn as HTMLButtonElement).disabled) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) // hits disabled guard L225
        }
      }
      m.remove()
    }
    expect(onSelectReadOnlyObject).toHaveBeenCalled()
    expect(onCopyObjectDdl).toHaveBeenCalled()
    expect(onOpenObjectDdlInConsole).toHaveBeenCalled()
    expect(onSwitchMode).toHaveBeenCalledWith('split')
    expect(onSwitchMode).toHaveBeenCalledWith('inspector')
    expect(onOpenImportModal).toHaveBeenCalled()
    expect(onOpenDangerModal).toHaveBeenCalledWith('truncate', expect.any(Object))
    expect(onOpenDangerModal).toHaveBeenCalledWith('drop', expect.any(Object))

    // Skeleton
    renderStudioSidebarSkeleton(null, null, null)
    const sideEl = dom.document.createElement('div')
    const trackEl = dom.document.createElement('div')
    const countEl = dom.document.createElement('span')
    renderStudioSidebarSkeleton(sideEl, trackEl, countEl)
    expect(countEl.textContent).toBe('...')

    // renderStudioTopbarObjects
    const allBtn = dom.document.createElement('button') as unknown as HTMLButtonElement
    const onActivateObject = vi.fn()
    const onOpenContextMenu = vi.fn()
    const onScrollActiveIntoView = vi.fn()
    renderStudioTopbarObjects({
      filtered: [],
      totalCount: 0,
      filterQuery: 'missing',
      sidebarCollapsed: false,
      topbarCountEl: countEl,
      topbarAllBtn: allBtn,
      topbarTrackEl: null,
      isObjectActive: () => false,
      onActivateObject,
      onOpenContextMenu,
      onScrollActiveIntoView,
    })
    renderStudioTopbarObjects({
      filtered: [],
      totalCount: 5,
      totalTableCount: 2,
      filterQuery: 'missing',
      sidebarCollapsed: false,
      topbarCountEl: countEl,
      topbarAllBtn: allBtn,
      topbarTrackEl: trackEl,
      isObjectActive: () => false,
      onActivateObject,
      onOpenContextMenu,
      onScrollActiveIntoView,
    })
    expect(trackEl.textContent).toContain('No tables match "missing"')
    expect(countEl.textContent).toBe('0/2')

    renderStudioTopbarObjects({
      filtered: [],
      totalCount: 0,
      filterQuery: '',
      sidebarCollapsed: false,
      topbarCountEl: countEl,
      topbarAllBtn: allBtn,
      topbarTrackEl: trackEl,
      isObjectActive: () => false,
      onActivateObject,
      onOpenContextMenu,
      onScrollActiveIntoView,
    })
    expect(trackEl.textContent).toBe('No tables')

    renderStudioTopbarObjects({
      filtered: [tblPublic, tblMain],
      totalCount: 2,
      totalTableCount: 2,
      filterQuery: '',
      sidebarCollapsed: true,
      topbarCountEl: countEl,
      topbarAllBtn: allBtn,
      topbarTrackEl: trackEl,
      isObjectActive: (n) => n === 'orders',
      onActivateObject,
      onOpenContextMenu,
      onScrollActiveIntoView,
    })
    expect(onScrollActiveIntoView).toHaveBeenCalledTimes(1)
    const pills = trackEl.querySelectorAll('.datanoa-topbar-pill')
    dom.click(pills[0])
    pills[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 11, clientY: 22 }))
    expect(onActivateObject).toHaveBeenCalledWith(tblPublic)
    expect(onOpenContextMenu).toHaveBeenCalledWith(11, 22, tblMain)

    // renderStudioTopbarObjectsPopover
    const popEl = dom.document.createElement('div')
    const collapsedGroups = new Set<SchemaObjectKind>()
    const onClosePop = vi.fn()
    const objectsAll: SchemaObject[] = [
      tblPublic,
      { name: 'v_sales', kind: 'view' },
      { name: 'seq_1', schema: 'public', kind: 'sequence' },
    ]
    const popHandle = renderStudioTopbarObjectsPopover({
      popoverEl: popEl,
      objects: objectsAll,
      collapsedGroups,
      isObjectActive: (n) => n === 'orders',
      onSelectObject: onActivateObject,
      onOpenContextMenu,
      onClose: onClosePop,
    })
    popHandle.focusSearch()
    const popSearch = popEl.querySelector('input[type="search"]')!
    // Filter by group label ('Views'), no match, clear, collapse/expand all, group header click, item click/contextmenu, Escape
    dom.setInput(popSearch, 'Views', 'input')
    expect(popEl.querySelectorAll('.datanoa-topbar-popover-item')).toHaveLength(1)
    // Header click ignored while filtering
    dom.click(popEl.querySelector('.datanoa-topbar-group-header')!)
    dom.setInput(popSearch, 'zzz-none', 'input')
    expect(popEl.textContent).toContain('No objects match "zzz-none"')
    dom.setInput(popSearch, '', 'input')
    dom.click(popEl.querySelector('.datanoa-topbar-collapse-all-btn')!)
    expect(collapsedGroups.size).toBe(3)
    dom.click(popEl.querySelector('.datanoa-topbar-group-header')!) // re-expand first group
    expect(collapsedGroups.size).toBe(2)
    dom.click(popEl.querySelector('.datanoa-topbar-expand-all-btn')!)
    expect(collapsedGroups.size).toBe(0)
    // Re-collapse first group to cover else branch
    dom.click(popEl.querySelector('.datanoa-topbar-group-header')!)
    dom.click(popEl.querySelector('.datanoa-topbar-expand-all-btn')!)
    const popItem = popEl.querySelector('.datanoa-topbar-popover-item')!
    dom.click(popItem)
    popItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 6 }))
    dom.fireKey(popSearch, 'Escape')
    expect(onClosePop).toHaveBeenCalledTimes(1)

    const emptyPopEl = dom.document.createElement('div')
    renderStudioTopbarObjectsPopover({
      popoverEl: emptyPopEl,
      objects: [],
      collapsedGroups: new Set(),
      isObjectActive: () => false,
      onSelectObject: onActivateObject,
    })
    expect(emptyPopEl.textContent).toContain('No objects available')

    // renderStudioSidebarList
    const onOpenConn = vi.fn()
    const onOpenCreate = vi.fn()
    const onToggleGroup = vi.fn()
    renderStudioSidebarList(
      {
        sidebarListEl: null,
        schemaObjects: [],
        filterQuery: '',
        activeConnectionId: null,
        activeConnection: undefined,
        collapsedGroups: new Set(),
        isObjectActive: () => false,
        onOpenConnectionModal: onOpenConn,
        onOpenCreateTableModal: onOpenCreate,
        onToggleGroup,
        onActivateObject,
        onOpenContextMenu,
      },
      []
    )

    // No connection CTA
    renderStudioSidebarList(
      {
        sidebarListEl: sideEl,
        schemaObjects: [],
        filterQuery: '',
        activeConnectionId: null,
        activeConnection: undefined,
        collapsedGroups: new Set(),
        isObjectActive: () => false,
        onOpenConnectionModal: onOpenConn,
        onOpenCreateTableModal: onOpenCreate,
        onToggleGroup,
        onActivateObject,
        onOpenContextMenu,
      },
      []
    )
    dom.click(sideEl.querySelector('button')!)
    expect(onOpenConn).toHaveBeenCalledTimes(1)

    // Empty objects with active connection (+ New Collection on mongodb, + New Table on pg, no matches with filter)
    const mongoConn: ConnectionProfile = { id: 'c1', name: 'M', driver: 'mongodb' } as ConnectionProfile
    renderStudioSidebarList(
      {
        sidebarListEl: sideEl,
        schemaObjects: [],
        filterQuery: '',
        activeConnectionId: 'c1',
        activeConnection: mongoConn,
        collapsedGroups: new Set(),
        isObjectActive: () => false,
        onOpenConnectionModal: onOpenConn,
        onOpenCreateTableModal: onOpenCreate,
        onToggleGroup,
        onActivateObject,
        onOpenContextMenu,
      },
      []
    )
    dom.click(sideEl.querySelector('button')!)
    expect(onOpenCreate).toHaveBeenCalledTimes(1)

    renderStudioSidebarList(
      {
        sidebarListEl: sideEl,
        schemaObjects: [],
        filterQuery: 'xyz',
        activeConnectionId: 'c1',
        activeConnection: { id: 'c1', name: 'P', driver: 'postgres' } as ConnectionProfile,
        collapsedGroups: new Set(),
        isObjectActive: () => false,
        onOpenConnectionModal: onOpenConn,
        onOpenCreateTableModal: onOpenCreate,
        onToggleGroup,
        onActivateObject,
        onOpenContextMenu,
      },
      []
    )
    expect(sideEl.textContent).toContain('No objects match "xyz"')

    // Populated groups: one collapsed, one expanded + filtering disables toggle
    renderStudioSidebarList(
      {
        sidebarListEl: sideEl,
        schemaObjects: objectsAll,
        filterQuery: '',
        activeConnectionId: 'c1',
        activeConnection: { id: 'c1', name: 'P', driver: 'postgres' } as ConnectionProfile,
        collapsedGroups: new Set<SchemaObjectKind>(['view']),
        isObjectActive: (n) => n === 'orders',
        onOpenConnectionModal: onOpenConn,
        onOpenCreateTableModal: onOpenCreate,
        onToggleGroup,
        onActivateObject,
        onOpenContextMenu,
      },
      objectsAll
    )
    dom.click(sideEl.querySelector('.datanoa-sidebar-group-header')!)
    expect(onToggleGroup).toHaveBeenCalledWith('table')
    const sItem = sideEl.querySelector('.datanoa-sidebar-item')!
    dom.click(sItem)
    sItem.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 9, clientY: 8 }))

    renderStudioSidebarList(
      {
        sidebarListEl: sideEl,
        schemaObjects: objectsAll,
        filterQuery: 'ord',
        activeConnectionId: 'c1',
        activeConnection: { id: 'c1', name: 'P', driver: 'postgres' } as ConnectionProfile,
        collapsedGroups: new Set<SchemaObjectKind>(['view']),
        isObjectActive: () => false,
        onOpenConnectionModal: onOpenConn,
        onOpenCreateTableModal: onOpenCreate,
        onToggleGroup,
        onActivateObject,
        onOpenContextMenu,
      },
      [tblPublic]
    )
    dom.click(sideEl.querySelector('.datanoa-sidebar-group-header')!) // ignored when filterQuery set
    expect(SCHEMA_OBJECT_GROUPS.length).toBe(8)
  })

  it('covers src/editor/saved-queries-modal.ts CRUD, timers, filter & close guards', async () => {
    vi.useFakeTimers()
    const flushAsync = async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1)
    }

    let mountedEl: HTMLElement | null = null
    let canCloseFn: (() => boolean) | undefined
    const closeModal = vi.fn(() => {
      mountedEl?.remove()
    })
    const updateStatus = vi.fn()
    const onInsertSql = vi.fn()

    let entriesData: SavedQueryEntry[] = [
      {
        id: 'sq1',
        name: 'Active Users',
        sql: `SELECT * FROM users WHERE note = '${'x'.repeat(130)}';`,
        dialect: 'postgres',
        tags: ['users', 'ops'],
        updatedAt: 1000,
        createdAt: 900,
      },
      {
        id: 'sq2',
        name: 'Quick Check',
        sql: 'SELECT 1;',
        updatedAt: 500,
        createdAt: 400,
      },
    ]

    let nextBehavior: 'ok' | 'fail-list-err' | 'fail-save' | 'fail-del' | 'hang-save' = 'fail-list-err'
    let pendingSaveRes: ((v: { ok: boolean; entry: SavedQueryEntry }) => void) | null = null

    const requestPlugin = vi.fn(async (method: string, payload: Record<string, unknown> = {}) => {
      if (method === 'queries.saved.list') {
        if (nextBehavior === 'fail-list-err') throw new Error('storage error')
        return { entries: entriesData }
      }
      if (method === 'queries.saved.save') {
        if (nextBehavior === 'fail-save') throw 'save-denied'
        if (nextBehavior === 'hang-save') {
          return new Promise((res) => {
            pendingSaveRes = res as (v: { ok: boolean; entry: SavedQueryEntry }) => void
          })
        }
        const entry: SavedQueryEntry = {
          id: (payload.id as string) || 'sq3',
          name: payload.name as string,
          sql: payload.sql as string,
          dialect: payload.dialect as 'postgres' | undefined,
          tags: (payload.tags as string[]) || [],
          updatedAt: 3000,
          createdAt: 3000,
        }
        return { ok: true, entry }
      }
      if (method === 'queries.saved.delete') {
        if (nextBehavior === 'fail-del') throw new Error('delete blocked')
        return { ok: true }
      }
      return {}
    })

    // First open triggers initial list error
    openStudioSavedQueriesModal({
      currentSql: 'SELECT 42;',
      activeDialect: 'postgres',
      onInsertSql,
      mountModal: (el, canClose) => {
        mountedEl = el
        canCloseFn = canClose
        dom.body.appendChild(el)
      },
      closeModal,
      updateStatus,
      requestPlugin: requestPlugin as never,
    })
    await flushAsync()
    await vi.advanceTimersByTimeAsync(60)
    expect(mountedEl!.querySelector('[role="alert"]')?.textContent).toContain('Failed to load saved queries: storage error')
    dom.click(mountedEl!.querySelector('.datanoa-modal-actions button')!)
    expect(closeModal).toHaveBeenCalledTimes(1)

    // Second open succeeds
    nextBehavior = 'ok'
    openStudioSavedQueriesModal({
      currentSql: 'SELECT 42;',
      activeDialect: 'postgres',
      onInsertSql,
      mountModal: (el, canClose) => {
        mountedEl = el
        canCloseFn = canClose
        dom.body.appendChild(el)
      },
      closeModal,
      updateStatus,
      requestPlugin: requestPlugin as never,
    })
    await flushAsync()
    await vi.advanceTimersByTimeAsync(60)
    expect(mountedEl!.querySelectorAll('.datanoa-saved-item')).toHaveLength(2)

    const nameInput = mountedEl!.querySelector('#datanoa-saved-query-name') as HTMLInputElement
    const tagsInput = mountedEl!.querySelector('#datanoa-saved-query-tags') as HTMLInputElement
    const sqlInput = mountedEl!.querySelector('#datanoa-saved-query-sql') as HTMLTextAreaElement
    const filterInput = mountedEl!.querySelector('.datanoa-saved-filter') as HTMLInputElement
    const [resetBtn, saveBtn] = mountedEl!.querySelectorAll('.datanoa-saved-form-actions button')

    // Validation: empty name & empty SQL
    dom.click(saveBtn)
    expect(mountedEl!.querySelector('[role="alert"]')?.textContent).toContain('Query name is required')
    dom.setInput(nameInput, 'New Q')
    dom.setInput(sqlInput, '   ')
    dom.click(saveBtn)
    expect(mountedEl!.querySelector('[role="alert"]')?.textContent).toContain('SQL text is required')

    // Filter match & no-match & clear
    dom.setInput(filterInput, 'ops', 'input')
    expect(mountedEl!.querySelectorAll('.datanoa-saved-item')).toHaveLength(1)
    dom.setInput(filterInput, 'nomatch-xyz', 'input')
    expect(mountedEl!.textContent).toContain('No saved queries match your filter.')
    dom.setInput(filterInput, '', 'input')

    // Save failure & success via Enter key
    dom.setInput(sqlInput, 'SELECT * FROM orders;')
    dom.setInput(tagsInput, 'orders, v1')
    nextBehavior = 'fail-save'
    dom.fireKey(mountedEl!, 'Tab') // non-Enter ignored
    dom.fireKey(sqlInput, 'Enter') // textarea Enter ignored
    dom.fireKey(nameInput, 'Enter')
    await flushAsync()
    expect(mountedEl!.querySelector('[role="alert"]')?.textContent).toContain('Save failed: save-denied')

    nextBehavior = 'ok'
    dom.fireKey(tagsInput, 'Enter')
    await flushAsync()
    expect(mountedEl!.querySelectorAll('.datanoa-saved-item')).toHaveLength(3)

    // Edit entry -> Update existing entry -> Cancel/Reset
    const firstEditBtn = mountedEl!.querySelectorAll('.datanoa-saved-item-actions button')[2]
    dom.click(firstEditBtn)
    expect(saveBtn.textContent).toBe('Update Query')
    dom.setInput(nameInput, 'Renamed Q')
    dom.click(saveBtn)
    await flushAsync()
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('Saved query "Renamed Q"'))

    // Edit again then Reset + Cancel Edit
    dom.click(mountedEl!.querySelectorAll('.datanoa-saved-item-actions button')[2])
    dom.click(resetBtn)
    expect(saveBtn.textContent).toBe('Save Query')

    // Delete 2-step confirmation: timeout clear, blur clear, filter clear, error, success (even while editing target!)
    const getDelBtn = () => mountedEl!.querySelectorAll('.datanoa-saved-item-actions button')[3]
    dom.click(getDelBtn())
    expect(getDelBtn().textContent).toBe('Confirm?')
    await vi.advanceTimersByTimeAsync(4050)
    expect(getDelBtn().textContent).toBe('Delete')

    dom.click(getDelBtn())
    getDelBtn().dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    expect(getDelBtn().textContent).toBe('Delete')

    dom.click(getDelBtn())
    dom.setInput(filterInput, 'a', 'input')
    dom.setInput(filterInput, '', 'input')

    // Confirm delete failure then success while editing that same entry
    dom.click(mountedEl!.querySelectorAll('.datanoa-saved-item-actions button')[2]) // Edit item 0
    nextBehavior = 'fail-del'
    dom.click(getDelBtn())
    dom.click(getDelBtn())
    await flushAsync()
    expect(mountedEl!.querySelector('[role="alert"]')?.textContent).toContain('Delete failed: delete blocked')

    nextBehavior = 'ok'
    dom.click(getDelBtn())
    dom.click(getDelBtn())
    await flushAsync()
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('Deleted saved query'))

    // Load & New Tab actions
    const loadBtn = mountedEl!.querySelectorAll('.datanoa-saved-item-actions button')[0]
    dom.click(loadBtn)
    expect(onInsertSql).toHaveBeenCalledWith(expect.any(String), 'replace', expect.any(String))

    // Re-open with empty entries & test New Tab + busy canClose + post-close settlement
    entriesData = [
      { id: 'n1', name: 'N1', sql: 'SELECT 1;', updatedAt: 10, createdAt: 10 },
    ]
    openStudioSavedQueriesModal({
      currentSql: 'SELECT 1;',
      onInsertSql,
      mountModal: (el, canClose) => {
        mountedEl = el
        canCloseFn = canClose
        dom.body.appendChild(el)
      },
      closeModal,
      updateStatus,
      requestPlugin: requestPlugin as never,
    })
    await flushAsync()
    dom.click(mountedEl!.querySelectorAll('.datanoa-saved-item-actions button')[1])
    expect(onInsertSql).toHaveBeenCalledWith('SELECT 1;', 'new-tab', 'N1')

    // Empty entries empty state + mid-save close (isClosed guards)
    entriesData = []
    openStudioSavedQueriesModal({
      currentSql: 'SELECT 2;',
      onInsertSql,
      mountModal: (el, canClose) => {
        mountedEl = el
        canCloseFn = canClose
        dom.body.appendChild(el)
      },
      closeModal,
      updateStatus,
      requestPlugin: requestPlugin as never,
    })
    await flushAsync()
    expect(mountedEl!.textContent).toContain('No saved queries yet.')
    nextBehavior = 'hang-save'
    dom.setInput(mountedEl!.querySelector('#datanoa-saved-query-name')!, 'Pending')
    dom.click(mountedEl!.querySelectorAll('.datanoa-saved-form-actions button')[1])
    expect(canCloseFn?.()).toBe(false)
    pendingSaveRes!({
      ok: true,
      entry: { id: 'x', name: 'Pending', sql: 'SELECT 2;', updatedAt: 1, createdAt: 1 },
    })
    await flushAsync()
    expect(canCloseFn?.()).toBe(true)
    mountedEl?.remove()
  })

  it('covers src/editor/driver-manager-modal.ts install commands, list, inspect, verify & remove flows', async () => {
    expect(getByodStarterTemplate('duckdb')).toContain('duckdb')
    expect(getByodNpmPackage('duckdb')).toBe('@duckdb/node-api')
    expect(getByodNpmPackage('snowflake')).toBe('snowflake-sdk')
    expect(getByodNpmPackage('bigquery')).toBe('@google-cloud/bigquery')
    expect(getByodNpmPackage('cassandra')).toBe('cassandra-driver')
    expect(getByodNpmPackage('elasticsearch')).toBe('@elastic/elasticsearch')
    expect(getByodNpmPackage('neo4j')).toBe('neo4j-driver')
    expect(getByodNpmPackage('unknown')).toBe('')

    expect(buildByodInstallCommand('duckdb', '', 'win32')).toContain('C:\\datanoa-drivers\\duckdb')
    expect(buildByodInstallCommand('duckdb', 'D:\\my%dir"1\\index.mjs', 'win32')).toContain('D:\\my%%dir1')
    expect(buildByodInstallCommand('snowflake', '', 'linux')).toContain('"$HOME/datanoa-drivers/snowflake"')
    expect(buildByodInstallCommand('unknown', "/opt/drv's", 'linux')).toContain("'/opt/drv'\\''s'")

    let mountedEl: HTMLElement | null = null
    let canCloseFn: (() => boolean) | undefined
    const closeModal = vi.fn(() => {
      mountedEl?.remove()
    })

    const registry: DriverRegistryItem[] = [
      { id: 'postgres', name: 'PostgreSQL', category: 'builtin', packaging: 'native', transport: 'TCP', description: 'PG', status: 'builtin' },
      { id: 'd1', name: 'Cloudflare D1', category: 'builtin', packaging: 'pure-ts-http', transport: 'HTTP', description: 'D1', status: 'builtin' },
      { id: 'mssql', name: 'SQL Server', category: 'builtin', packaging: 'bundled', transport: 'TDS', description: 'MS', status: 'builtin' },
      { id: 'sqlite', name: 'SQLite', category: 'builtin', packaging: 'custom-kind' as never, transport: 'File', description: 'SQ', status: 'builtin' },
      { id: 'duckdb', name: 'DuckDB', category: 'local-byod', packaging: 'native', transport: 'File', description: 'DuckDB local', status: 'not-configured' },
      {
        id: 'snowflake',
        name: 'Snowflake',
        category: 'local-byod',
        packaging: 'pure-ts-http',
        transport: 'HTTPS',
        description: 'Snowflake SDK',
        status: 'local-error',
        localPath: '/tmp/sf',
        resolvedEntry: '/tmp/sf/index.mjs',
        sha256: 'shortsha',
        error: 'Driver load error',
      },
    ]

    let listMode: 'ok' | 'fail-err' | 'fail-str' = 'fail-err'
    let inspectMode: 'ok' | 'invalid' | 'fail' = 'invalid'
    let configureMode: 'ok' | 'invalid' | 'fail' = 'invalid'
    let verifyMode: 'ok' | 'changed' | 'retrust' | 'fail-item' | 'invalid' | 'throw' = 'retrust'
    let removeMode: 'ok' | 'fail' = 'fail'
    let holdInspect = false
    let resolveHoldInspect: ((v: DriverInspectResult) => void) | null = null

    const requestPlugin = vi.fn(async (method: string, payload: Record<string, unknown> = {}) => {
      if (method === 'drivers.list') {
        if (listMode === 'fail-err') throw new Error('registry fail')
        if (listMode === 'fail-str') throw 'list-str-fail'
        return { drivers: registry }
      }
      if (method === 'drivers.inspectLocal') {
        if (inspectMode === 'fail') throw new Error('missing file')
        if (inspectMode === 'invalid') return {}
        if (holdInspect) {
          return new Promise((res) => {
            resolveHoldInspect = res as (v: DriverInspectResult) => void
          })
        }
        return {
          driverId: payload.driverId,
          sha256: '0123456789abcdef0123456789abcdef01234567',
          resolvedEntry: `${String(payload.localPath)}/index.mjs`,
          scopeNote: 'SHA-256 verified.',
        } satisfies DriverInspectResult
      }
      if (method === 'drivers.configureLocal') {
        if (configureMode === 'fail') throw new Error('sha mismatch')
        if (configureMode === 'invalid') return {}
        const item: DriverRegistryItem = {
          id: String(payload.driverId),
          name: 'DuckDB',
          category: 'local-byod',
          packaging: 'native',
          transport: 'File',
          description: 'DuckDB local',
          status: 'local-verified',
          localPath: String(payload.localPath),
          resolvedEntry: `${String(payload.localPath)}/index.mjs`,
          sha256: String(payload.trustedSha256),
        }
        return { ok: true, item }
      }
      if (method === 'drivers.verify') {
        if (verifyMode === 'throw') throw new Error('verify error')
        if (verifyMode === 'invalid') return {}
        const updated: DriverRegistryItem = {
          ...registry[5],
          status: verifyMode === 'fail-item' ? 'local-error' : 'local-verified',
          sha256: 'fedcba9876543210fedcba9876543210fedcba98',
          error: undefined,
        }
        if (verifyMode === 'retrust') {
          return {
            ok: false,
            item: updated,
            requiresTrust: true,
            pendingSha256: 'aaaaaaaaaaaaaaaaaaaa1111111111111111bbbb',
            message: 'Changed digest pending trust.',
          } satisfies DriverVerifyResult
        }
        if (verifyMode === 'fail-item') {
          return { ok: false, item: updated, message: 'Entry deleted' } satisfies DriverVerifyResult
        }
        return {
          ok: true,
          item: updated,
          sha256Changed: verifyMode === 'changed',
          message: verifyMode === 'changed' ? 'Updated hash trusted.' : 'Hash verified.',
        } satisfies DriverVerifyResult
      }
      if (method === 'drivers.removeLocal') {
        if (removeMode === 'fail') throw new Error('remove locked')
        return { ok: true }
      }
      return {}
    })

    // Open 1: list fails
    openStudioDriverManagerModal({
      mountModal: (el, canClose) => {
        mountedEl = el
        canCloseFn = canClose
        dom.body.appendChild(el)
      },
      closeModal,
      requestPlugin: requestPlugin as never,
    })
    await dom.flushMicrotasks()
    expect(mountedEl!.querySelector('[role="alert"]')?.textContent).toContain('Failed to load drivers: registry fail')
    expect(canCloseFn?.()).toBe(true)
    dom.click(mountedEl!.querySelector('.datanoa-modal-head button')!)

    // Open 2: list succeeds
    listMode = 'ok'
    openStudioDriverManagerModal({
      mountModal: (el, canClose) => {
        mountedEl = el
        canCloseFn = canClose
        dom.body.appendChild(el)
      },
      closeModal,
      requestPlugin: requestPlugin as never,
    })
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Zero-vendor HTTP')

    // Click guide starter Copy button
    dom.click(mountedEl!.querySelector('.datanoa-driver-mgr-guide .datanoa-driver-mgr-actions button')!)
    expect(dom.clipboardWrites.length).toBeGreaterThan(0)

    const getDuckRow = () => mountedEl!.querySelectorAll('.datanoa-driver-mgr-byod')[0]
    const getSnowRow = () => mountedEl!.querySelectorAll('.datanoa-driver-mgr-byod')[1]

    // Empty path -> error
    dom.click(getDuckRow().querySelector('.datanoa-driver-mgr-actions button')!)
    expect(mountedEl!.textContent).toContain('Enter a local driver path first.')

    // Fill path, test inspect invalid response, RPC fail, and success -> Trust & Verify
    dom.setInput(getDuckRow().querySelector('input')!, '/opt/duckdb')
    inspectMode = 'invalid'
    dom.click(getDuckRow().querySelector('.datanoa-driver-mgr-actions button')!)
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Invalid driver inspection response')

    inspectMode = 'fail'
    dom.click(getDuckRow().querySelector('.datanoa-driver-mgr-actions button')!)
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Inspection failed: missing file')

    inspectMode = 'ok'
    dom.click(getDuckRow().querySelector('.datanoa-driver-mgr-actions button')!)
    await dom.flushMicrotasks()
    expect(getDuckRow().textContent).toContain('Trust & Verify')

    // Input edit removes pending box cleanly
    dom.setInput(getDuckRow().querySelector('input')!, '/opt/duckdb2', 'input')
    expect(getDuckRow().textContent).not.toContain('Trust & Verify')

    // Re-inspect and test configure invalid/fail/success
    dom.click(getDuckRow().querySelector('.datanoa-driver-mgr-actions button')!)
    await dom.flushMicrotasks()
    const clickDuckTrust = () => {
      const trustBtn = Array.from(getDuckRow().querySelectorAll('button')).find((b) => b.textContent === 'Trust & Verify')!
      dom.click(trustBtn)
    }
    configureMode = 'invalid'
    clickDuckTrust()
    await dom.flushMicrotasks()
    configureMode = 'fail'
    clickDuckTrust()
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Verification failed: sha mismatch')
    configureMode = 'ok'
    clickDuckTrust()
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('trusted, verified, and saved')

    // Re-verify / Retrust / Remove on Snowflake row
    const clickSnowBtn = (label: string) => {
      const b = Array.from(getSnowRow().querySelectorAll('button')).find((el) => el.textContent === label)!
      dom.click(b)
    }
    verifyMode = 'invalid'
    clickSnowBtn('Re-Verify SHA-256')
    await dom.flushMicrotasks()
    verifyMode = 'throw'
    clickSnowBtn('Re-Verify SHA-256')
    await dom.flushMicrotasks()
    verifyMode = 'fail-item'
    clickSnowBtn('Re-Verify SHA-256')
    await dom.flushMicrotasks()
    verifyMode = 'retrust'
    clickSnowBtn('Re-Verify SHA-256')
    await dom.flushMicrotasks()
    expect(getSnowRow().textContent).toContain('Trust New SHA-256')

    verifyMode = 'changed'
    clickSnowBtn('Trust New SHA-256')
    await dom.flushMicrotasks()
    verifyMode = 'ok'
    clickSnowBtn('Re-Verify SHA-256')
    await dom.flushMicrotasks()

    removeMode = 'fail'
    clickSnowBtn('Remove')
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('Remove failed: remove locked')
    removeMode = 'ok'
    clickSnowBtn('Remove')
    await dom.flushMicrotasks()
    expect(mountedEl!.textContent).toContain('removed.')

    // Mid-flight modal close guards (!isOpen)
    holdInspect = true
    dom.setInput(getSnowRow().querySelector('input')!, '/opt/late')
    dom.click(getSnowRow().querySelector('.datanoa-driver-mgr-actions button')!)
    mountedEl!.remove() // disconnected while busy
    resolveHoldInspect?.({
      driverId: 'snowflake',
      sha256: '1234',
      resolvedEntry: '/opt/late/index.mjs',
      scopeNote: 'ok',
    })
    await dom.flushMicrotasks()
    dom.click(mountedEl!.querySelector('.datanoa-modal-head button')!)
    expect(closeModal).toHaveBeenCalled()
  })
})
