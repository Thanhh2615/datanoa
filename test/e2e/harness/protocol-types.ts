/**
 * test/e2e/harness/protocol-types.ts
 *
 * Authoritative IPC type re-exports for Datanoa DB Studio E2E harness,
 * sourced directly from src/protocol.ts so module augmentation on 'orca'
 * remains single-sourced with zero TS2717 conflicts.
 */

import type { PluginRequests } from '../../../src/protocol.js'

export type {
  ConnectionProfile,
  ConnectionColorTag,
  DatabaseDriverType,
  SchemaObject,
  ColumnInfo as TableColumn,
  IndexInfo as TableIndex,
  ForeignKeyInfo as TableForeignKey,
  TableDetails,
  TableBrowseResult,
  QueryResult,
  QueryHistoryEntry,
  DataChangesInput,
  PluginRequests,
  PluginPanelEvents,
} from '../../../src/protocol.js'

// Request Helper Type Extractors (Matching Orca's orca-services.d.ts)
export type PluginRequestInput<K extends keyof PluginRequests> =
  PluginRequests[K] extends { input?: infer I }
    ? I
    : PluginRequests[K] extends { input: infer I }
      ? I
      : undefined

export type PluginRequestOutput<K extends keyof PluginRequests> =
  PluginRequests[K] extends { output: infer O } ? O : null
