// src/editor/file-picker-modal.ts
// Studio theme binding for the shared in-app file and folder picker modal.

import {
  openSharedFilePickerModal,
  type SharedFilePickerClasses,
  type SharedFilePickerListResult,
  type SharedFilePickerResult,
} from '../shared-file-picker.js'
import type { StudioRpcModalContext } from './studio-modals.js'

export interface FilePickerOptions {
  title: string
  mode: 'file' | 'folder'
  initialDir?: string
  extensions?: string[]
}

const STUDIO_PICKER_CLASSES: SharedFilePickerClasses = {
  overlay: 'datanoa-modal-backdrop datanoa-fp-overlay',
  modal: 'datanoa-fp-modal',
  head: 'datanoa-modal-head',
  title: 'datanoa-modal-title',
  body: 'datanoa-fp-body',
  roots: 'datanoa-fp-roots',
  root: 'datanoa-fp-root',
  nav: 'datanoa-fp-nav',
  upBtn: 'datanoa-btn datanoa-btn-sm datanoa-fp-up',
  pathInput: 'datanoa-conn-input is-mono datanoa-fp-path',
  filterInput: 'datanoa-conn-input datanoa-fp-filter',
  list: 'datanoa-fp-list',
  row: 'datanoa-fp-row',
  icon: 'datanoa-fp-icon',
  name: 'datanoa-fp-name',
  meta: 'datanoa-fp-meta',
  empty: 'datanoa-fp-empty',
  status: 'datanoa-fp-status',
  foot: 'datanoa-fp-foot',
  selected: 'datanoa-fp-selected is-mono',
  actions: 'datanoa-fp-actions',
  btnSm: 'datanoa-btn datanoa-btn-sm',
  btnPrimarySm: 'datanoa-btn datanoa-btn-primary datanoa-btn-sm',
}

export function openStudioFilePickerModal(
  ctx: StudioRpcModalContext,
  options: FilePickerOptions
): Promise<SharedFilePickerResult> {
  return openSharedFilePickerModal({
    title: options.title,
    mode: options.mode,
    initialDir: options.initialDir,
    extensions: options.extensions,
    maxRoots: 10,
    classes: STUDIO_PICKER_CLASSES,
    listDir: (input) => ctx.requestPlugin<SharedFilePickerListResult>('fs.listDir', input),
  })
}
