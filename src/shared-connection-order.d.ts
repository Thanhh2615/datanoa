export interface OrderableConnection {
  id: string
  folder?: string
}

export type ReorderPlacement = 'before' | 'after'
export type ReorderDirection = 'up' | 'down'

export interface ComputedFolderReorder {
  ok: boolean
  changed: boolean
  folder: string
  orderedIds: string[]
}

export interface AppliedFolderReorder<T extends OrderableConnection> {
  ok: boolean
  changed: boolean
  folder: string
  connections: T[]
  error?: string
}

export interface ConnectionReorderBounds {
  found: boolean
  folder: string
  index: number
  total: number
  canMoveUp: boolean
  canMoveDown: boolean
}

export function isReservedFolderName(folder: unknown): boolean

export function normalizeConnectionFolderKey(folder: unknown): string

export function getFolderConnectionIds(
  connections: readonly OrderableConnection[],
  folder: string | undefined
): string[]

export function getConnectionReorderBounds(
  connections: readonly OrderableConnection[],
  connectionId: string
): ConnectionReorderBounds

export function computeMovedFolderIds(
  connections: readonly OrderableConnection[],
  connectionId: string,
  direction: ReorderDirection
): ComputedFolderReorder

export function computeReorderedFolderIds(
  connections: readonly OrderableConnection[],
  sourceId: string,
  targetId: string,
  placement: ReorderPlacement
): ComputedFolderReorder

export interface FolderReorderBounds {
  found: boolean
  index: number
  total: number
  canMoveUp: boolean
  canMoveDown: boolean
  orderedFolders: string[]
}

export interface ComputedFoldersReorder {
  ok: boolean
  changed: boolean
  orderedFolders: string[]
}

export interface ReconciledFolderOrder {
  ok: boolean
  changed: boolean
  folderOrder: string[]
  error?: string
}

export function reorderConnectionsWithinFolder<T extends OrderableConnection>(
  connections: readonly T[],
  folder: string | undefined,
  orderedIds: readonly string[]
): AppliedFolderReorder<T>

export const UNGROUPED_FOLDER_ORDER_KEY: '__ungrouped__'

export function getConnectionFolderOrderKeys(
  connections: readonly Pick<OrderableConnection, 'folder'>[]
): string[]

export function normalizeFolderOrder(folderOrder: unknown): string[]

export function sortFoldersByOrder(
  folderNames: readonly string[],
  folderOrder?: readonly string[] | null
): string[]

export function getFolderReorderBounds(
  folderNames: readonly string[],
  folderName: string,
  folderOrder?: readonly string[] | null
): FolderReorderBounds

export function computeReorderedFolders(
  folderNames: readonly string[],
  sourceFolder: string,
  targetFolder: string,
  placement: ReorderPlacement,
  folderOrder?: readonly string[] | null
): ComputedFoldersReorder

export function computeMovedFolders(
  folderNames: readonly string[],
  folderName: string,
  direction: ReorderDirection,
  folderOrder?: readonly string[] | null
): ComputedFoldersReorder

export function reconcileFolderOrder(
  existingOrder: readonly string[] | null | undefined,
  requestedOrderedFolders: readonly string[],
  currentFolderNames: readonly string[]
): ReconciledFolderOrder
