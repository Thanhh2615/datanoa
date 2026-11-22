export interface SharedFilePickerEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  size?: number
}

export interface SharedFilePickerListResult {
  ok: boolean
  currentDir: string
  parentDir: string | null
  roots: string[]
  entries: SharedFilePickerEntry[]
  truncated?: boolean
  error?: string
}

export interface SharedFilePickerClasses {
  overlay: string
  modal: string
  head: string
  title: string
  body?: string
  roots: string
  root: string
  nav: string
  upBtn: string
  pathInput: string
  filterInput: string
  list: string
  row: string
  icon: string
  name: string
  meta: string
  empty: string
  status: string
  foot: string
  selected: string
  actions: string
  btnSm: string
  btnPrimarySm: string
}

export interface SharedFilePickerConfig {
  title?: string
  mode?: 'file' | 'folder'
  initialDir?: string
  extensions?: string[]
  maxRoots?: number
  classes: SharedFilePickerClasses
  listDir: (input: {
    dir?: string
    mode: 'file' | 'folder'
    extensions?: string[]
    strictDir?: boolean
  }) => Promise<SharedFilePickerListResult>
}

export interface SharedFilePickerResult {
  ok: boolean
  path?: string
  cancelled?: boolean
}

export declare function formatPickerBytes(size?: number): string
export declare function compactPickerRootLabel(rootPath: string): string
export declare function openSharedFilePickerModal(
  config: SharedFilePickerConfig
): Promise<SharedFilePickerResult>
