export interface CollapsibleSelectOptions {
  tooltipPrefix?: string
  searchPlaceholder?: string
  searchAriaLabel?: string
  collapsedFolders?: Set<string>
  defaultCollapseNonActiveFolders?: boolean
  onFolderToggle?: (collapsedFolders: Set<string>) => void
  leadingIconType?: 'none' | 'workspace' | 'db'
  onOpen?: () => void
}

export interface CollapsibleSelectApi {
  refresh(options?: CollapsibleSelectOptions): void
  close(): void
  triggerBtn: HTMLButtonElement
}

export interface CollapsibleSelectClasses {
  srOnly: string
  trigger: string
  leadIcon: string
  label: string
  chev: string
  popover: string
  head: string
  search: string
  actionBtn: string
  list: string
  item: string
  itemIcon: string
  itemText: string
  itemLabel: string
  itemSub: string
  itemCheck: string
  folderHead: string
  folderIcon: string
  folderName: string
  folderCount: string
  empty: string
}

export interface CollapsibleSelectLayout {
  minWidth: number
  margin: number
  maxHeight: number
  vwFallback: number
  vhFallback: number
  gap: number
  rectFallback: { left: number; top: number; bottom: number; width: number; height: number }
}

export interface CollapsibleSelectAdapter {
  classes: CollapsibleSelectClasses
  layout: CollapsibleSelectLayout
  syncProp: string
  apiProp?: string
  mountedProp?: string
  closeOnRefresh: boolean
  fallbackQuerySelected: boolean
  setActionAriaLabel: boolean
  expandTitle: string
  collapseTitle: string
  beforeEnhance?: (selectEl: HTMLSelectElement | null, options?: CollapsibleSelectOptions) => void
  setLeadIconVisible: (el: HTMLSpanElement, visible: boolean) => void
  renderTriggerChevron: (span: HTMLSpanElement) => void
  syncLeadIcon: (
    span: HTMLSpanElement,
    leadingIconType: 'none' | 'workspace' | 'db',
    selectedOpt: HTMLOptionElement | null
  ) => void
  renderExpandIcon: (btn: HTMLButtonElement) => void
  renderCollapseIcon: (btn: HTMLButtonElement) => void
  renderItemIcon: (
    span: HTMLSpanElement,
    driver: string,
    leadingIconType: 'none' | 'workspace' | 'db'
  ) => void
  applyFolderChevron: (span: HTMLSpanElement, isCollapsed: boolean) => void
  renderFolderIcon: (span: HTMLSpanElement, isOpen: boolean) => void
}

export interface CollapsibleSelectController {
  enhance: (selectEl: HTMLSelectElement | null, options?: CollapsibleSelectOptions) => CollapsibleSelectApi | null
  isOpen: () => boolean
  closeActive: () => void
}

export declare function createCollapsibleSelectController(
  adapter: CollapsibleSelectAdapter
): CollapsibleSelectController
