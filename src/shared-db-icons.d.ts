import type { DatabaseDriverType } from './protocol.js'

export declare const DB_LOGO_COLORS: Readonly<Record<DatabaseDriverType, string>>
export declare const DB_LOGO_PATHS: Readonly<Record<Exclude<DatabaseDriverType, 'clickhouse'>, string>>
export declare const CLICKHOUSE_LOGO_RECTS: ReadonlyArray<Readonly<Record<string, string>>>
export declare const BYOD_LOGO_PATHS: Readonly<Record<string, { color: string; d: string }>>
export declare const FOLDER_OPEN_PATH: string
export declare const FOLDER_CLOSED_PATH: string
export declare const WORKSPACE_ICON_SHAPES: ReadonlyArray<{
  tag: 'polygon' | 'polyline'
  attrs: Readonly<Record<string, string>>
}>

export declare function buildPanelDbSvgMarkupMap(): Record<string, string>
export declare function buildWorkspaceSvgMarkup(className: string, size?: number): string
