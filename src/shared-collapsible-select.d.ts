export type CollapsibleSelectBadgeTone =
  | 'neutral'
  | 'dev'
  | 'staging'
  | 'prod'
  | 'info'
  | 'warn'

export interface CollapsibleSelectBadge {
  text: string
  tone?: CollapsibleSelectBadgeTone
}

export interface CollapsibleSelectOptions {
  tooltipPrefix?: string
  searchPlaceholder?: string
  searchAriaLabel?: string
  /**
   * Collapsed folder keys. When an `<optgroup>` sets `data-section-key` (or `data-group-key`),
   * that disambiguated key is stored here instead of the display label to avoid collisions
   * between user folders and built-in sections (such as "General (Ungrouped)").
   */
  collapsedFolders?: Set<string>
  defaultCollapseNonActiveFolders?: boolean
  onFolderToggle?: (collapsedFolders: Set<string>) => void
  leadingIconType?: 'none' | 'workspace' | 'db'
  popoverMinWidth?: number
  popoverMaxHeight?: number
  showTriggerBadges?: boolean
  reorderConnections?: boolean
  reorderFolders?: boolean
  onReorderConnections?: (folderKey: string, orderedIds: string[]) => void | Promise<unknown>
  onReorderFolders?: (orderedFolders: string[]) => void | Promise<unknown>
  onOpen?: () => void
}

export interface CollapsibleSelectApi {
  refresh(options?: CollapsibleSelectOptions): void
  close(): void
  destroy(): void
  triggerBtn: HTMLButtonElement
}

export interface CollapsibleSelectClasses {
  srOnly: string
  trigger: string
  leadIcon: string
  label: string
  triggerBadges?: string
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
  itemBadges?: string
  itemCheck: string
  badge?: string
  dragHandle?: string
  dragSpacer?: string
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
  destroy: () => void
}

export declare function createCollapsibleSelectController(
  adapter: CollapsibleSelectAdapter
): CollapsibleSelectController
