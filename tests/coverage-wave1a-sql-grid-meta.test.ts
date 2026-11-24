import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  parseDelimitedClipboard,
  parseJsonPreservingBigInts,
  planGridPaste,
  sanitizeDiagnosticErrorText,
} from '../src/shared-grid-paste.js'
import {
  bindSqlParameters,
  coerceBindParamValue,
  extractSqlParameters,
  type BindParamInput,
} from '../src/editor/sql-params.js'
import {
  buildColumnHeaderPredicate,
  injectSqlColumnFilter,
  type ColumnHeaderFilterOp,
} from '../src/editor/sql-column-filter.js'
import {
  composeDatanoaDocument,
  parseDatanoaDocument,
  readLocalStudioViewState,
  readLocalStudioWarmCache,
  scrubSensitiveStringForLocalStorage,
  syncInitialThemeFromHost,
  upsertDatanoaMetadataHeader,
  writeLocalStudioWarmCache,
  writeStudioViewStateSnapshot,
} from '../src/editor/document-meta.js'
import {
  calculateVisibleWindow,
  checkCellEditGate,
  cloneRowData,
  coerceCellInputValue,
  copyTextToClipboard,
  formatCellValue,
  formatGridModel,
  getCellValue,
  isNativeDomElement,
  parseOptionalInt,
  previewMenuValue,
  rowToPlainRecord,
  setCellValue,
  stringifyFilterValue,
} from '../src/editor/grid-formatters.js'
import {
  buildGridChangesPayload,
  buildGridSelectionSnapshot,
  compareGridCellValues,
  computeFilteredRowIndices,
  computeGridFindMatches,
  computeInitialColumnWidthsForGrid,
  countGridStagedChanges,
  createClonedRowRecord,
  exportGridSelectionMatrix,
  matchesClientColumnFilters,
  type InternalRowState,
} from '../src/editor/grid-data-ops.js'
import { GridSelectionModel } from '../src/editor/grid-selection.js'
import { formatCellMatrixExport } from '../src/drivers/common/sql-formatter.js'
import type { DatabaseDriverType, QueryResult, TableBrowseResult } from '../src/protocol.js'

const SQL_DIALECTS: readonly DatabaseDriverType[] = [
  'sqlite',
  'postgres',
  'mysql',
  'mariadb',
  'cockroachdb',
  'clickhouse',
  'libsql',
  'd1',
  'mssql',
  'oracle',
]

describe('Wave 1A Group 2: shared-grid-paste.js (JSON BigInt, RFC4180, planGridPaste, diagnostic redaction)', () => {
  it('handles BigInt/float/escaped JSON strings and BOM stripping', () => {
    const raw =
      '\uFEFF{"big":9223372036854775807,"neg":-9007199254740993,"safe":42,"lz":0,"dec":12.5e-2,"exp":1e+3,"txt":"a\\"b\\\\c"}'
    expect(parseJsonPreservingBigInts('42')).toBe(42)
    expect(parseJsonPreservingBigInts(raw)).toEqual({
      big: '9223372036854775807',
      neg: '-9007199254740993',
      safe: 42,
      lz: 0,
      dec: 0.125,
      exp: 1000,
      txt: 'a"b\\c',
    })
    // Leading-zero non-standard number passes through to JSON.parse (throws)
    expect(() => parseJsonPreservingBigInts('[001234567890123456]')).toThrow()
    // Non-string input triggers JSON.parse failure cleanly
    expect(() => parseJsonPreservingBigInts('   ')).toThrow()

    fc.assert(
      fc.property(
        fc.bigInt({ min: 9_007_199_254_740_992n, max: 99_999_999_999_999_999_999n }),
        fc.integer({ min: -100000, max: 100000 }),
        fc.string({ maxLength: 20 }),
        fc.boolean(),
        (big, safeInt, text, withBom) => {
          const json = `${withBom ? '\uFEFF' : ''}{"id":${big.toString()},"n":${safeInt},"s":${JSON.stringify(text)}}`
          const res = parseJsonPreservingBigInts(json)
          expect(res.id).toBe(big.toString())
          expect(res.n).toBe(safeInt)
          expect(res.s).toBe(text)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('auto-detects TSV vs CSV, JSON literals, quoted boundaries, and CRLF edge cases', () => {
    expect(parseDelimitedClipboard(null as unknown as string)).toEqual([])
    expect(parseDelimitedClipboard('')).toEqual([])
    expect(parseDelimitedClipboard('\r\n')).toEqual([])
    expect(parseDelimitedClipboard('\r\n\n')).toEqual([[''], ['']])
    expect(parseDelimitedClipboard(' {"a": 1} ')).toEqual([['{"a": 1}']])
    expect(parseDelimitedClipboard('[1, 2]')).toEqual([['[1, 2]']])
    expect(parseDelimitedClipboard('{broken json}')).toEqual([['{broken json}']])
    expect(parseDelimitedClipboard('[{"a":1}]', { delimiter: ',' })).toEqual([['[{"a":1}]']])
    expect(parseDelimitedClipboard('{broken json}\n[also broken]')).toEqual([
      ['{broken json}'],
      ['[also broken]'],
    ])
    // Multi-line equal comma counts -> CSV; unequal -> TSV; single-line with quoted comma boundary -> CSV
    expect(parseDelimitedClipboard('"a""b",c\r\nd,"e,f"\r')).toEqual([
      ['a"b', 'c'],
      ['d', 'e,f'],
    ])
    expect(parseDelimitedClipboard('a,b\nc,d,e')).toEqual([['a,b'], ['c,d,e']])
    expect(parseDelimitedClipboard('"a,b",c')).toEqual([['a,b', 'c']])
    expect(parseDelimitedClipboard('hello, world')).toEqual([['hello, world']])
    expect(parseDelimitedClipboard('a\tb,c\nd\te')).toEqual([
      ['a', 'b,c'],
      ['d', 'e'],
    ])
    // Empty line inside multi-line input and unterminated quote edge
    expect(parseDelimitedClipboard('a,b\n\nc,d', { delimiter: ',' })).toEqual([
      ['a', 'b'],
      [''],
      ['c', 'd'],
    ])
    expect(parseDelimitedClipboard('"unterminated')).toEqual([['unterminated']])

    // Property: roundtrip with formatCellMatrixExport on safe multi-row non-empty matrices
    fc.assert(
      fc.property(
        fc.constantFrom('csv' as const, 'tsv' as const),
        fc.array(
          fc.array(
            fc.stringMatching(/^[A-Za-z0-9 ,."'\t-]{1,12}$/),
            { minLength: 2, maxLength: 4 }
          ),
          { minLength: 2, maxLength: 5 }
        ),
        (fmt, rawRows) => {
          const width = rawRows[0].length
          const rect = rawRows.map((r) =>
            Array.from({ length: width }, (_, i) => r[i % r.length])
          )
          const exported = formatCellMatrixExport([], rect, fmt)
          const delimiter = fmt === 'csv' ? ',' : '\t'
          const parsed = parseDelimitedClipboard(exported, { delimiter })
          expect(parsed).toEqual(rect)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('plans all 5 paste modes cleanly across headers, sourceHeaders, auto columns, fill, overwrite, and insert', () => {
    const cols = [
      { name: 'id', isAutoIncrement: true },
      { name: 'name' },
      { name: 'age' },
    ]
    const emptyRes = planGridPaste({
      matrix: [],
      hasSelection: false,
      selectionBBox: null,
      selectedCellCount: 0,
      existingRowCount: 0,
      visibleColIndices: [0, 1, 2],
      allColumns: cols,
      forceNewRows: false,
    })
    expect(emptyRes.mode).toBe('empty')

    // Single-row matrix matching header names is treated as data (rowCount < 2 guard)
    expect(
      planGridPaste({
        matrix: [['name', 'age']],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: false,
        explicitHasHeaders: true,
      })
    ).toMatchObject({ mode: 'insert', hadHeaders: false })

    // Non-matching or single-col without explicitHasHeaders does not treat first row as header
    const noHeaderSingle = planGridPaste({
      matrix: [['name'], ['Bob']],
      hasSelection: false,
      selectionBBox: null,
      selectedCellCount: 0,
      existingRowCount: 0,
      visibleColIndices: [0, 1, 2],
      allColumns: cols,
      forceNewRows: false,
    })
    expect(noHeaderSingle.hadHeaders).toBe(false)

    // Non-string cell & empty header cell branches in detectHeaderColumnMapping
    expect(
      planGridPaste({
        matrix: [[123 as unknown as string, 'name'], ['a', 'b']],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: false,
      }).hadHeaders
    ).toBe(false)
    expect(
      planGridPaste({
        matrix: [['', 'name'], ['a', 'b']],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: false,
      }).hadHeaders
    ).toBe(false)
    expect(
      planGridPaste({
        matrix: [['unknown_col', 'name'], ['a', 'b']],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: false,
      }).hadHeaders
    ).toBe(false)

    // Fill mode: single scalar onto >1 selected cells
    const fillPlan = planGridPaste({
      matrix: [['ACTIVE']],
      hasSelection: true,
      selectionBBox: { startRow: 1, startCol: 1 },
      selectedCellCount: 4,
      existingRowCount: 5,
      visibleColIndices: [0, 1, 2],
      allColumns: cols,
      forceNewRows: false,
    })
    expect(fillPlan).toMatchObject({
      mode: 'fill',
      fillValue: 'ACTIVE',
      startVisRow: 1,
      startVisCol: 1,
    })

    // Insert mode via header mapping + skipping auto-increment column
    const insertWithHeaders = planGridPaste({
      matrix: [
        ['id', 'name', 'age'],
        ['99', 'Alice', '30'],
      ],
      hasSelection: true,
      selectionBBox: { startRow: 0, startCol: 1 },
      selectedCellCount: 1,
      existingRowCount: 3,
      visibleColIndices: [0, 1, 2],
      allColumns: cols,
      forceNewRows: true,
    })
    expect(insertWithHeaders.mode).toBe('insert')
    expect(insertWithHeaders.inserts[0].cells).toEqual([
      { modelColIdx: 1, visColIdx: 1, rawValue: 'Alice' },
      { modelColIdx: 2, visColIdx: 2, rawValue: '30' },
    ])

    // Insert mode via sourceHeaders mapping (and rejection of invalid/all-auto sourceHeaders)
    const insertViaSourceHeaders = planGridPaste({
      matrix: [['Alice', '30']],
      hasSelection: false,
      selectionBBox: null,
      selectedCellCount: 0,
      existingRowCount: 2,
      visibleColIndices: [1, 2],
      allColumns: cols,
      forceNewRows: true,
      sourceHeaders: ['name', 'age'],
    })
    expect(insertViaSourceHeaders.inserts[0].cells).toEqual([
      { modelColIdx: 1, visColIdx: 0, rawValue: 'Alice' },
      { modelColIdx: 2, visColIdx: 1, rawValue: '30' },
    ])
    expect(
      planGridPaste({
        matrix: [['10']],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [0, 1, 2],
        allColumns: [{ name: 'id', isGenerated: true }, { name: 'name' }],
        forceNewRows: true,
        sourceHeaders: ['id'],
      }).inserts[0].cells
    ).toEqual([{ modelColIdx: 1, visColIdx: 1, rawValue: '10' }])
    expect(
      planGridPaste({
        matrix: [['Alice']],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: true,
        sourceHeaders: ['missing_header'],
      }).inserts[0].cells
    ).toEqual([{ modelColIdx: 1, visColIdx: 1, rawValue: 'Alice' }])

    // Insert anchored at column > 0 and trailing extra clipboard columns ignored cleanly
    const anchoredInsert = planGridPaste({
      matrix: [['30', 'ignored']],
      hasSelection: true,
      selectionBBox: { startRow: 0, startCol: 2 },
      selectedCellCount: 1,
      existingRowCount: 2,
      visibleColIndices: [0, 1, 2],
      allColumns: cols,
      forceNewRows: true,
    })
    expect(anchoredInsert.inserts[0].cells).toEqual([
      { modelColIdx: 2, visColIdx: 2, rawValue: '30' },
    ])

    // Overwrite + insert mixed mode + headerLookup in overwrite mode
    const mixedPlan = planGridPaste({
      matrix: [
        ['Alice', '28', 'extra'],
        ['Bob', '31', 'extra'],
      ],
      hasSelection: true,
      selectionBBox: { startRow: 1, startCol: 1 },
      selectedCellCount: 1,
      existingRowCount: 2,
      visibleColIndices: [0, 1, 2],
      allColumns: cols,
      forceNewRows: false,
    })
    expect(mixedPlan.mode).toBe('overwrite-and-insert')
    expect(mixedPlan.overwrites).toHaveLength(1)
    expect(mixedPlan.inserts).toHaveLength(1)

    // Full-width overwrite resets startCol to 0; header-mapped overwrite resolves column by header
    const overwriteWithHeaders = planGridPaste({
      matrix: [
        ['age', 'name'],
        ['44', 'Zoe'],
      ],
      hasSelection: true,
      selectionBBox: { startRow: 0, startCol: 2 },
      selectedCellCount: 1,
      existingRowCount: 5,
      visibleColIndices: [0, 1, 2],
      allColumns: cols,
      forceNewRows: false,
    })
    expect(overwriteWithHeaders.mode).toBe('overwrite')
    expect(overwriteWithHeaders.startVisCol).toBe(0)
    expect(overwriteWithHeaders.overwrites[0].cells).toEqual([
      { modelColIdx: 2, visColIdx: 2, rawValue: '44' },
      { modelColIdx: 1, visColIdx: 1, rawValue: 'Zoe' },
    ])

    // Additional branch cases: fill with null selectionBBox, hidden header col (-1 visColIdx), extra cells beyond mapping/visibleCols, startRow >= existingRowCount
    expect(
      planGridPaste({
        matrix: [['FILL']],
        hasSelection: true,
        selectionBBox: null,
        selectedCellCount: 2,
        existingRowCount: 3,
        visibleColIndices: [0, 1],
        allColumns: cols,
        forceNewRows: false,
      })
    ).toMatchObject({ mode: 'fill', startVisRow: 0, startVisCol: 0 })

    expect(
      planGridPaste({
        matrix: [
          ['name', 'age'],
          ['Alice', '30', 'overflow'],
        ],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [1],
        allColumns: [{ name: '' }, { name: 'name' }, { name: 'age' }],
        forceNewRows: true,
        sourceHeaders: [''],
      }).inserts[0].cells
    ).toEqual([
      { modelColIdx: 1, visColIdx: 0, rawValue: 'Alice' },
      { modelColIdx: 2, visColIdx: -1, rawValue: '30' },
    ])

    expect(
      planGridPaste({
        matrix: [
          ['Alice', '30'],
        ],
        hasSelection: true,
        selectionBBox: { startRow: 0, startCol: 0 },
        selectedCellCount: 1,
        existingRowCount: 2,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: true,
        sourceHeaders: ['', 'age'],
      }).inserts[0].cells
    ).toHaveLength(2)

    expect(
      planGridPaste({
        matrix: [['single-overwrite']],
        hasSelection: true,
        selectionBBox: { startRow: 0, startCol: 1 },
        selectedCellCount: 1,
        existingRowCount: 2,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: false,
      })
    ).toMatchObject({ mode: 'overwrite', startVisRow: 0, startVisCol: 1 })

    expect(
      planGridPaste({
        matrix: [['Alice', '30', 'extra']],
        hasSelection: true,
        selectionBBox: { startRow: 0, startCol: 0 },
        selectedCellCount: 1,
        existingRowCount: 2,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: true,
        sourceHeaders: ['name', ''],
      }).inserts[0].cells
    ).toHaveLength(2)

    expect(
      planGridPaste({
        matrix: [['v1', 'v2']],
        hasSelection: false,
        selectionBBox: null,
        selectedCellCount: 0,
        existingRowCount: 0,
        visibleColIndices: [0, 1, 2],
        allColumns: [
          { name: 'id', isAutoIncrement: true },
          { name: 'gen', isGenerated: true },
          { name: 'name' },
        ],
        forceNewRows: true,
      }).inserts[0].cells
    ).toEqual([{ modelColIdx: 2, visColIdx: 2, rawValue: 'v1' }])

    expect(
      planGridPaste({
        matrix: [['a', 'b', 'c', 'overflow']],
        hasSelection: true,
        selectionBBox: { startRow: 5, startCol: 0 },
        selectedCellCount: 1,
        existingRowCount: 2,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: false,
      })
    ).toMatchObject({ mode: 'insert', startVisRow: 5, startVisCol: 0 })

    expect(
      planGridPaste({
        matrix: [['a', 'b', 'c', 'overflow']],
        hasSelection: true,
        selectionBBox: { startRow: 0, startCol: 1 },
        selectedCellCount: 1,
        existingRowCount: 2,
        visibleColIndices: [0, 1, 2],
        allColumns: cols,
        forceNewRows: false,
      }).overwrites[0].cells
    ).toHaveLength(3)
  })

  it('sanitizes diagnostic error text with control-char stripping and ellipsis truncation', () => {
    expect(sanitizeDiagnosticErrorText('')).toBe('')
    expect(sanitizeDiagnosticErrorText('\x00  \x07  ', { stripControlChars: true })).toBe('')
    const cleaned = sanitizeDiagnosticErrorText(
      '\x01Failed postgres://u:p@db.example.com/app at C:\\secret\\file.ts and /Users/me/key for 10.0.0.5:5432 user@corp.io token=abc123 Authorization: Bearer tok1234',
      { stripControlChars: true }
    )
    expect(cleaned).not.toContain('C:\\secret')
    expect(cleaned).not.toContain('10.0.0.5')
    expect(cleaned).not.toContain('abc123')
    expect(cleaned).toContain('<redacted-uri>')
    expect(cleaned).toContain('<redacted-path>')
    expect(cleaned).toContain('<redacted-ip>')

    const longMsg = 'E'.repeat(320)
    expect(sanitizeDiagnosticErrorText(longMsg, { ellipsis: true })).toHaveLength(280)
    expect(sanitizeDiagnosticErrorText(longMsg, { ellipsis: true }).endsWith('...')).toBe(true)
    expect(sanitizeDiagnosticErrorText(longMsg, { ellipsis: false })).toHaveLength(280)
    expect(sanitizeDiagnosticErrorText(longMsg, { ellipsis: false }).endsWith('...')).toBe(false)
  })
})

describe('Wave 1A Group 2: sql-params.ts & sql-column-filter.ts', () => {
  it('extracts and binds parameters accurately across comments, quotes, casts, and MySQL user vars', () => {
    expect(extractSqlParameters('', 'postgres')).toEqual([])
    expect(extractSqlParameters('SET :x', 'redis')).toEqual([])
    expect(extractSqlParameters('db.users.find({ a: :x })', 'mongodb')).toEqual([])
    expect(extractSqlParameters('SELECT 1 # eof without newline', 'mysql')).toEqual([])
    expect(extractSqlParameters('SELECT $tag$unclosed dollar block', 'postgres')).toEqual([])
    expect(bindSqlParameters(null as unknown as string, {}, 'postgres')).toBe('')
    expect(bindSqlParameters('', {}, 'postgres')).toBe('')
    expect(bindSqlParameters('db.users.find({})', {}, 'mongodb')).toBe('db.users.find({})')
    expect(bindSqlParameters('SELECT 1', {}, 'postgres')).toBe('SELECT 1')

    // Comments, strings, brackets, dollar-quotes, casts, system vars, and MySQL @var := assignment
    const pgSql = `
      -- :ignored_line
      /* outer /* :nested */ :ignored_block */
      SELECT E'it\\'s :escaped_str', 'str :in_str', $tag$ :in_dollar $1 $tag$,
             col::text, :named_a, :named_a, $1, $2, $1a, $0, $1000
      FROM items WHERE id = :id AND tag = @tag
    `
    const extractedPg = extractSqlParameters(pgSql, 'postgres')
    expect(extractedPg.map((p) => `${p.key}:${p.occurrences}`)).toEqual([
      ':named_a:2',
      '$1:1',
      '$2:1',
      ':id:1',
      '@tag:1',
    ])

    const sqliteBracket = `SELECT [col:not_param], [col]]more @x] FROM [t] WHERE a = :val`
    expect(extractSqlParameters(sqliteBracket, 'sqlite').map((p) => p.key)).toEqual([':val'])

    const mysqlSql = `
      # :mysql_hash_comment
      SET @row_num := 0;
      SELECT @@version, @row_num + 1, @external_param, :named_p FROM t;
    `
    expect(extractSqlParameters(mysqlSql, 'mysql').map((p) => p.key)).toEqual([
      '@external_param',
      ':named_p',
    ])

    // bindSqlParameters with prefixed & bare keys + unmatched param preserved + NUL byte guard
    const bound = bindSqlParameters(
      'SELECT :a, @b, $1, :missing FROM t',
      {
        ':a': { value: 'hello', type: 'text' },
        b: { value: '42', type: 'number' },
        $1: { value: 'true', type: 'boolean' },
      },
      'postgres'
    )
    expect(bound).toBe("SELECT 'hello', 42, TRUE, :missing FROM t")
    expect(() =>
      bindSqlParameters('SELECT :a', { ':a': { value: 'bad\0byte', type: 'text' } }, 'postgres')
    ).toThrow('NUL')

    // coerceBindParamValue branches
    expect(coerceBindParamValue({ value: 'anything', type: 'null' })).toBeNull()
    expect(coerceBindParamValue({ value: ' 42 ', type: 'text' })).toBe(' 42 ')
    expect(coerceBindParamValue({ value: '9007199254740993', type: 'number' })).toBe(
      9007199254740993n
    )
    expect(coerceBindParamValue({ value: '3.14', type: 'number' })).toBe(3.14)
    expect(() => coerceBindParamValue({ value: '   ', type: 'number' })).toThrow()
    expect(() => coerceBindParamValue({ value: 'abc', type: 'number' })).toThrow()
    for (const t of ['true', 'T', '1', 'yes', 'y']) {
      expect(coerceBindParamValue({ value: t, type: 'boolean' })).toBe(true)
    }
    for (const f of ['false', 'F', '0', 'no', 'n']) {
      expect(coerceBindParamValue({ value: f, type: 'boolean' })).toBe(false)
    }
    expect(() => coerceBindParamValue({ value: 'maybe', type: 'boolean' })).toThrow()
    expect(coerceBindParamValue({ value: '', type: 'auto' })).toBe('')
    expect(coerceBindParamValue({ value: 'NULL', type: 'auto' })).toBeNull()
    expect(coerceBindParamValue({ value: 'true', type: 'auto' })).toBe(true)
    expect(coerceBindParamValue({ value: 'false', type: 'auto' })).toBe(false)
    expect(coerceBindParamValue({ value: '00123', type: 'auto' })).toBe('00123')
    expect(coerceBindParamValue({ value: '42', type: 'auto' })).toBe(42)
    expect(coerceBindParamValue({ value: '+9007199254740993', type: 'auto' })).toBe(
      9007199254740993n
    )
    expect(coerceBindParamValue({ value: '1234567890123456.78', type: 'auto' })).toBe(
      '1234567890123456.78'
    )
    expect(coerceBindParamValue({ value: '12.5', type: 'auto' })).toBe(12.5)
    expect(coerceBindParamValue({ value: '1e999', type: 'auto' })).toBe('1e999')
    expect(coerceBindParamValue({ value: 'plain', type: 'auto' })).toBe('plain')

    // Property: comments & literals never introduce parameters, and binding all extracted params clears all placeholders
    fc.assert(
      fc.property(
        fc.constantFrom(...SQL_DIALECTS),
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/), { minLength: 1, maxLength: 4 }),
        fc.string({ maxLength: 15 }).filter((s) => !s.includes('\0') && !s.includes("'")),
        (dialect, names, commentText) => {
          const safeComment = commentText.replace(/[\r\n/*]/g, ' ')
          const sql = `-- :fake_in_comment ${safeComment}\nSELECT '::ignored' FROM t WHERE ${names
            .map((n) => `${n} = :${n}`)
            .join(' AND ')}`
          const params = extractSqlParameters(sql, dialect)
          expect(params.map((p) => p.key)).toEqual(names.map((n) => `:${n}`))

          const values: Record<string, BindParamInput> = {}
          for (const p of params) values[p.key] = { value: 'v', type: 'text' }
          const boundSql = bindSqlParameters(sql, values, dialect)
          expect(extractSqlParameters(boundSql, dialect)).toEqual([])
        }
      ),
      { numRuns: 100 }
    )
  })

  it('builds dialect predicates and injects SQL column filters safely across all query shapes', () => {
    const ops: ColumnHeaderFilterOp[] = ['contains', 'eq', 'neq', 'is-null', 'is-not-null']
    for (const op of ops) {
      for (const dialect of SQL_DIALECTS) {
        const pred = buildColumnHeaderPredicate('col_a', '100%_\\x', op, dialect)
        expect(pred.length).toBeGreaterThan(0)
      }
    }
    expect(buildColumnHeaderPredicate('name', 'x', 'contains', 'clickhouse')).toContain(
      'positionCaseInsensitive'
    )
    expect(buildColumnHeaderPredicate('name', 'x', 'contains', 'mysql')).toContain('LIKE')
    expect(buildColumnHeaderPredicate('name', 'x', 'contains', 'mssql')).toContain('NVARCHAR(MAX)')
    expect(buildColumnHeaderPredicate('name', 'x', 'contains', 'oracle')).toContain('TO_CHAR')

    // Rejection reasons
    expect(injectSqlColumnFilter('   ', 'a', '1', 'eq', 'postgres')).toEqual({
      ok: false,
      reason: 'empty_sql',
    })
    expect(injectSqlColumnFilter('SELECT * FROM t', 'a', '1', 'eq', 'redis')).toEqual({
      ok: false,
      reason: 'non_sql_dialect',
    })
    expect(injectSqlColumnFilter('SELECT 1; SELECT 2', 'a', '1', 'eq', 'postgres')).toEqual({
      ok: false,
      reason: 'multi_statement',
    })
    expect(injectSqlColumnFilter('-- comment only', 'a', '1', 'eq', 'postgres')).toEqual({
      ok: false,
      reason: 'multi_statement',
    })
    expect(injectSqlColumnFilter('(SELECT 1)', 'a', '1', 'eq', 'postgres')).toEqual({
      ok: false,
      reason: 'no_tokens',
    })
    expect(injectSqlColumnFilter('DELETE FROM t', 'a', '1', 'eq', 'postgres')).toEqual({
      ok: false,
      reason: 'not_select',
    })
    expect(injectSqlColumnFilter('SELECT * FROM a UNION SELECT * FROM b', 'a', '1', 'eq', 'postgres')).toEqual({
      ok: false,
      reason: 'set_operation',
    })
    expect(injectSqlColumnFilter('SELECT 1 + 1', 'a', '1', 'eq', 'postgres')).toEqual({
      ok: false,
      reason: 'missing_from',
    })

    // Quotes/comments/brackets/dollar-quotes inside SELECT + WHERE / ORDER BY / GROUP BY / FOR UPDATE / LOCK IN SHARE MODE / trailing comment
    const complexPg = injectSqlColumnFilter(
      `WITH c AS (SELECT 1)
       /* outer /* inner */ */
       SELECT E'x\\'y', "col", $tag$ WHERE $tag$ FROM items
       WHERE active = true -- trailing line comment
       ORDER BY id DESC;`,
      'name',
      'bob',
      'eq',
      'postgres'
    )
    expect(complexPg.ok).toBe(true)
    if (complexPg.ok) {
      expect(complexPg.sql).toContain("\n) AND \"name\" = 'bob'")
      expect(complexPg.sql).toContain('ORDER BY id DESC;')
    }

    // Empty WHERE clause branch (when WHERE has nothing before boundary) and trailing newline comment before insertion
    const mysqlNoWhere = injectSqlColumnFilter(
      "SELECT [col]]x], `id` FROM items # hash comment",
      'id',
      '5',
      'neq',
      'mysql'
    )
    expect(mysqlNoWhere.ok).toBe(true)
    if (mysqlNoWhere.ok) {
      expect(mysqlNoWhere.sql).toContain("\nWHERE `id` <> '5'")
    }

    const sqliteBracketLock = injectSqlColumnFilter(
      'SELECT [a]]b] FROM [items] GROUP BY [a]]b]',
      'a',
      '',
      'is-null',
      'sqlite'
    )
    expect(sqliteBracketLock.ok).toBe(true)

    const forUpdateRes = injectSqlColumnFilter(
      'SELECT * FROM items WHERE  ORDER BY id',
      'id',
      '1',
      'eq',
      'postgres'
    )
    expect(forUpdateRes.ok).toBe(true)
    if (forUpdateRes.ok) {
      expect(forUpdateRes.sql).toContain('WHERE "id" = \'1\' ORDER BY id')
    }

    const lockShareRes = injectSqlColumnFilter(
      'SELECT * FROM items LOCK IN SHARE MODE',
      'id',
      '1',
      'eq',
      'mysql'
    )
    expect(lockShareRes.ok).toBe(true)

    const forKeyRes = injectSqlColumnFilter(
      'SELECT * FROM items FOR UPDATE',
      'id',
      '1',
      'eq',
      'postgres'
    )
    expect(forKeyRes.ok).toBe(true)

    expect(
      injectSqlColumnFilter("SELECT 'lit' FROM items WHERE a = '1';", 'id', '2', 'eq', 'postgres')
    ).toMatchObject({ ok: true })
    expect(
      injectSqlColumnFilter('SELECT $tag$unclosed FROM items', 'id', '2', 'eq', 'postgres')
    ).toEqual({ ok: false, reason: 'missing_from' })
    expect(
      injectSqlColumnFilter('SELECT * FROM items', 'id', '2', 'eq', 'postgres')
    ).toMatchObject({ ok: true })
    expect(
      injectSqlColumnFilter('SELECT * FROM items FOR SHARE', 'id', '2', 'eq', 'postgres')
    ).toMatchObject({ ok: true })
    expect(
      injectSqlColumnFilter('SELECT * FROM items FOR NO KEY UPDATE', 'id', '2', 'eq', 'postgres')
    ).toMatchObject({ ok: true })
    expect(
      injectSqlColumnFilter('SELECT * FROM items FOR KEY SHARE', 'id', '2', 'eq', 'postgres')
    ).toMatchObject({ ok: true })

    // Unbalanced parens resilience & no semicolon tail
    const parenRes = injectSqlColumnFilter('SELECT (1)) FROM items', 'x', '', 'is-not-null', 'postgres')
    expect(parenRes.ok).toBe(true)
  })
})

describe('Wave 1A Group 2: document-meta.ts, grid-formatters.ts, and grid-data-ops.ts', () => {
  const origWindow = globalThis.window
  const origDocument = globalThis.document
  const origNavigator = globalThis.navigator
  const origGetComputedStyle = globalThis.getComputedStyle
  const origHTMLElement = globalThis.HTMLElement
  const origTextEncoder = globalThis.TextEncoder

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = origWindow
    ;(globalThis as Record<string, unknown>).document = origDocument
    if (origNavigator === undefined) {
      delete (globalThis as Record<string, unknown>).navigator
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        value: origNavigator,
        configurable: true,
        writable: true,
      })
    }
    ;(globalThis as Record<string, unknown>).getComputedStyle = origGetComputedStyle
    ;(globalThis as Record<string, unknown>).HTMLElement = origHTMLElement
    ;(globalThis as Record<string, unknown>).TextEncoder = origTextEncoder
  })

  it('roundtrips datanoa documents, sanitizes storage snapshots, and syncs host theme across DOM states', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9_]{1,10}$/),
        fc.stringMatching(/^[a-z0-9_]{1,10}$/),
        fc.stringMatching(/^[a-z0-9_]{1,10}$/),
        fc.string({ maxLength: 40 }).filter((s) => !s.startsWith('-- datanoa:') && !s.startsWith('--datanoa:')),
        (connId, schema, table, sql) => {
          const headers: string[] = []
          upsertDatanoaMetadataHeader(headers, 'connectionId', connId)
          upsertDatanoaMetadataHeader(headers, 'schema', schema)
          upsertDatanoaMetadataHeader(headers, 'table', table)
          // Idempotent update
          upsertDatanoaMetadataHeader(headers, 'table', table)
          const doc = composeDatanoaDocument(headers, sql)
          const parsed = parseDatanoaDocument(doc)
          expect(parsed.connectionId).toBe(connId)
          expect(parsed.schema).toBe(schema)
          expect(parsed.table).toBe(table)
          expect(parsed.cleanSql).toBe(sql)
        }
      ),
      { numRuns: 100 }
    )

    expect(composeDatanoaDocument([], 'SELECT 1;')).toBe('SELECT 1;')
    expect(parseDatanoaDocument('-- datanoa: invalid_without_equals\nSELECT 1;').cleanSql).toBe(
      'SELECT 1;'
    )
    expect(scrubSensitiveStringForLocalStorage(123)).toBeUndefined()
    expect(scrubSensitiveStringForLocalStorage('   ')).toBeUndefined()

    // Non-browser environment (window/document undefined)
    delete (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).document
    expect(readLocalStudioViewState()).toBeNull()
    expect(() => writeStudioViewStateSnapshot({ sqlDraft: 'SELECT 1' })).not.toThrow()
    expect(readLocalStudioWarmCache()).toBeNull()
    expect(() => writeLocalStudioWarmCache({ updatedAt: 1 })).not.toThrow()
    expect(syncInitialThemeFromHost()).toBeNull()

    // Mock browser storage + DOM
    const store = new Map<string, string>()
    const localStorageMock = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    }
    ;(globalThis as Record<string, unknown>).window = { localStorage: localStorageMock }

    // Bad JSON & primitive JSON in storage
    store.set('datanoa.studioViewState', '{bad')
    expect(readLocalStudioViewState()).toBeNull()
    store.set('datanoa.studioViewState', '"str"')
    expect(readLocalStudioViewState()).toBeNull()
    store.set('datanoa.studioWarmCache', '{bad')
    expect(readLocalStudioWarmCache()).toBeNull()
    store.set('datanoa.studioWarmCache', '123')
    expect(readLocalStudioWarmCache()).toBeNull()

    // Sensitive SQL draft, console tab, whereClause, connection password stripping
    writeStudioViewStateSnapshot({
      sqlDraft: "ALTER USER bob WITH PASSWORD 'secret'",
      consoleTabs: {
        activeTabId: 't1',
        tabs: [
          { id: 't1', title: '1', sql: 'AUTH supersecret123' },
          { id: 't2', title: '2', sql: 'SELECT 1' },
        ],
      },
    })
    const loadedState = readLocalStudioViewState()!
    expect(loadedState.sqlDraft).toBeUndefined()
    expect(loadedState.consoleTabs?.tabs[0].sql).toBe('')
    expect(loadedState.consoleTabs?.tabs[1].sql).toBe('SELECT 1')

    // Storage throw catch branch
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError')
        },
      },
    }
    expect(() => writeStudioViewStateSnapshot({ sqlDraft: 'SELECT 1' })).not.toThrow()
    expect(() => writeLocalStudioWarmCache({ updatedAt: Number.NaN })).not.toThrow()

    // Warm cache progressive size pruning (pageData/lastSqlResult -> schemaObjects -> skip if still oversized)
    ;(globalThis as Record<string, unknown>).window = { localStorage: localStorageMock }
    writeLocalStudioWarmCache({
      updatedAt: Number.NaN,
      connections: [
        {
          id: 'c1',
          name: 'pg',
          driver: 'postgres',
          password: 'p',
          url: 'postgres://u:secret@db/app',
          options: 'password=secret',
        },
      ],
      whereClause: 'token=my_secret_123',
      pageData: {
        columns: ['a'],
        rows: [{ a: 'x'.repeat(360_000) }],
        totalRows: 1,
        page: 1,
        pageSize: 10,
        canEdit: false,
      },
      schemaObjects: [{ name: 't', kind: 'table' }],
    })
    const cached1 = readLocalStudioWarmCache()!
    expect(cached1.pageData).toBeNull()
    expect(cached1.schemaObjects).toHaveLength(1)
    expect(cached1.whereClause).toBe('')
    expect((cached1.connections![0] as unknown as Record<string, unknown>).password).toBeUndefined()

    // Step 2 pruning: drops schemaObjects too when still > 350KB (without TextEncoder fallback, plus throwing TextEncoder catch)
    ;(globalThis as Record<string, unknown>).TextEncoder = class {
      encode(): Uint8Array {
        throw new Error('encoder failed')
      }
    }
    writeLocalStudioWarmCache({
      updatedAt: 100,
      schemaObjects: [{ name: 'o'.repeat(200_000), kind: 'table' }],
      schemaMap: { public: ['t1'] },
    })
    expect(readLocalStudioWarmCache()?.schemaObjects).toBeNull()

    ;(globalThis as Record<string, unknown>).TextEncoder = undefined
    writeLocalStudioWarmCache({
      updatedAt: 100,
      schemaObjects: [{ name: 'o'.repeat(200_000), kind: 'table' }],
      schemaMap: { public: ['t1'] },
    })
    const cached2 = readLocalStudioWarmCache()!
    expect(cached2.schemaObjects).toBeNull()

    // Step 3: oversized schemaMap skips writing
    store.delete('datanoa.studioWarmCache')
    writeLocalStudioWarmCache({
      updatedAt: 100,
      schemaMap: { public: ['z'.repeat(250_000)] },
    })
    expect(readLocalStudioWarmCache()).toBeNull()

    // syncInitialThemeFromHost across pre-set class, transparent/missing color, dark/light rgb
    const makeClassList = (initial: string[] = []) => {
      const s = new Set(initial)
      return {
        contains: (c: string) => s.has(c),
        toggle: (c: string, force?: boolean) => {
          if (force === true) s.add(c)
          else if (force === false) s.delete(c)
          else if (s.has(c)) s.delete(c)
          else s.add(c)
          return s.has(c)
        },
      }
    }
    const htmlClasses = makeClassList(['light'])
    const bodyClasses = makeClassList()
    ;(globalThis as Record<string, unknown>).document = {
      documentElement: { classList: htmlClasses },
      body: {
        classList: bodyClasses,
        appendChild: () => {},
      },
      createElement: () => ({ style: {}, remove: () => {} }),
    }
    expect(syncInitialThemeFromHost()).toBe(true)
    expect(bodyClasses.contains('light')).toBe(true)

    // Probe transparent -> null
    ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({
      backgroundColor: 'rgba(0, 0, 0, 0)',
    })
    expect(syncInitialThemeFromHost({ forceTokenProbe: true })).toBeNull()

    // Probe bright light color & dark color (both s <= 0.03928 and s > 0.03928 paths)
    ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({
      backgroundColor: 'rgb(245, 245, 245)',
    })
    expect(syncInitialThemeFromHost({ forceTokenProbe: true })).toBe(true)
    ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({
      backgroundColor: 'rgb(5, 5, 5)',
    })
    expect(syncInitialThemeFromHost({ forceTokenProbe: true })).toBe(false)

    // Exception inside probe -> catch returns null
    ;(globalThis as Record<string, unknown>).document = {
      documentElement: { classList: makeClassList() },
      body: { classList: makeClassList() },
      createElement: () => {
        throw new Error('no dom')
      },
    }
    expect(syncInitialThemeFromHost({ forceTokenProbe: true })).toBeNull()
  })

  it('covers all grid-formatters helpers including DOM/clipboard/BigInt coercion edges', () => {
    expect(isNativeDomElement(null)).toBe(false)
    expect(isNativeDomElement({})).toBe(false)
    expect(isNativeDomElement({ [Symbol.toStringTag]: 'HTMLDivElement' })).toBe(true)

    expect(coerceCellInputValue('', 1, 'INT')).toBeNull()
    expect(coerceCellInputValue('', null, 'BOOLEAN')).toBeNull()
    expect(coerceCellInputValue('', null, 'DATE')).toBeNull()
    expect(coerceCellInputValue('', null, 'TEXT')).toBe('')
    expect(coerceCellInputValue('NULL', 'x', 'DATE', true)).toBeNull()
    expect(coerceCellInputValue('NULL', 'x', 'DATE', false)).toBe('NULL')
    expect(coerceCellInputValue('TRUE', null, 'BOOLEAN')).toBe(true)
    expect(coerceCellInputValue('false', true, 'BOOL')).toBe(false)
    expect(coerceCellInputValue('maybe', true, 'BOOL')).toBe('maybe')
    expect(coerceCellInputValue('42', null, 'INTEGER')).toBe(42)
    expect(coerceCellInputValue('9007199254740993', null, 'BIGINT')).toBe('9007199254740993')
    expect(coerceCellInputValue('1234567890123456.78', null, 'DECIMAL')).toBe(
      '1234567890123456.78'
    )
    expect(coerceCellInputValue('12.5', null, 'FLOAT')).toBe(12.5)
    expect(coerceCellInputValue('Infinity', null, 'FLOAT')).toBe('Infinity')

    const browseWithStrCols: TableBrowseResult = {
      columns: ['id', 'n'] as unknown as TableBrowseResult['columns'],
      rows: [{ id: 1, n: 2 }],
      totalRows: 1,
      page: 1,
      pageSize: 10,
      canEdit: true,
    }
    expect(formatGridModel(browseWithStrCols).primaryKey).toEqual([])
    const queryModel: QueryResult = {
      columns: [{ name: 'id', type: 'INT' }],
      rows: [{ id: 1 }],
      rowCount: 1,
      durationMs: 1,
      truncated: false,
    }
    expect(formatGridModel(queryModel).canEdit).toBe(false)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(formatCellValue(null)).toEqual({ text: 'NULL', className: 'datanoa-cell-null' })
    expect(formatCellValue(10, 'INT')).toEqual({ text: '10', className: 'datanoa-cell-numeric' })
    expect(formatCellValue({ ok: true })).toEqual({
      text: '{"ok":true}',
      className: 'datanoa-cell-json',
    })
    expect(formatCellValue(circular).className).toBe('datanoa-cell-text')
    expect(formatCellValue('abc')).toEqual({ text: 'abc', className: 'datanoa-cell-text' })

    expect(calculateVisibleWindow(44, 440)).toEqual({
      startIndex: 2,
      endIndex: 22,
      visibleCount: 20,
    })
    expect(checkCellEditGate(false, ['id'])).toEqual({ allowed: false, reason: 'read_only_table' })
    expect(checkCellEditGate(true, [])).toEqual({ allowed: false, reason: 'missing_primary_key' })
    expect(checkCellEditGate(true, ['id'])).toEqual({ allowed: true })

    const arrRow = [1, 2]
    setCellValue(arrRow, 1, 'b', 9)
    expect(arrRow).toEqual([1, 9])
    const objRow = { a: 1 }
    setCellValue(objRow, 0, 'a', 8)
    expect(objRow).toEqual({ a: 8 })
    expect(cloneRowData([1, 2])).toEqual([1, 2])
    expect(cloneRowData({ a: 1 })).toEqual({ a: 1 })
    expect(rowToPlainRecord(['a', 'b'], { a: 1 }, true)).toEqual({ a: 1 })
    expect(rowToPlainRecord(['a', 'b'], { a: 1 }, false)).toEqual({ a: 1, b: null })

    expect(stringifyFilterValue(null)).toBe('')
    expect(stringifyFilterValue({ x: 1 })).toBe('{"x":1}')
    expect(stringifyFilterValue(circular)).toBe('[object Object]')
    expect(stringifyFilterValue(5)).toBe('5')

    expect(previewMenuValue(undefined)).toBe('NULL')
    expect(previewMenuValue('short')).toBe('short')
    expect(previewMenuValue('x'.repeat(30))).toBe(`${'x'.repeat(22)}...`)
    expect(parseOptionalInt(undefined)).toBeNull()
    expect(parseOptionalInt('abc')).toBeNull()
    expect(parseOptionalInt('42')).toBe(42)

    // copyTextToClipboard without DOM or clipboard
    delete (globalThis as Record<string, unknown>).document
    delete (globalThis as Record<string, unknown>).navigator
    expect(copyTextToClipboard('abc')).toBe(false)

    // copyTextToClipboard with DOM + focus/selection/execCommand branches + navigator.clipboard.writeText
    class FakeEl {
      value = ''
      style: Record<string, string> = {}
      setAttribute() {}
      focus(opts?: { preventScroll?: boolean }) {
        if (opts?.preventScroll) throw new Error('no preventScroll')
      }
      select() {}
      setSelectionRange() {
        throw new Error('no selection')
      }
      remove() {}
    }
    ;(globalThis as Record<string, unknown>).HTMLElement = FakeEl
    const prevEl = new FakeEl()
    ;(globalThis as Record<string, unknown>).document = {
      body: { appendChild: () => {} },
      activeElement: prevEl,
      createElement: () => new FakeEl(),
      execCommand: () => {
        throw new Error('execCommand blocked')
      },
    }
    expect(copyTextToClipboard('hello')).toBe(false)

    ;(globalThis as Record<string, unknown>).document = {
      body: { appendChild: () => {} },
      activeElement: null,
      createElement: () => {
        const el = new FakeEl()
        el.focus = () => {}
        el.setSelectionRange = () => {}
        return el
      },
      execCommand: () => true,
    }
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
      configurable: true,
      writable: true,
    })
    expect(copyTextToClipboard('hello')).toBe(true)
  })

  it('covers all grid-data-ops calculations and sorting/filter/selection invariants', () => {
    const emptyModel = formatGridModel({
      columns: [{ name: 'a', type: 'TEXT' }],
      rows: [],
      totalRows: 0,
      page: 1,
      pageSize: 10,
      canEdit: true,
      primaryKey: ['a'],
    })
    const emptyWidths = computeInitialColumnWidthsForGrid(emptyModel, 40)
    expect(emptyWidths[0]).toBeGreaterThan(112)
    expect(
      computeInitialColumnWidthsForGrid(
        formatGridModel({
          columns: ['a'] as unknown as TableBrowseResult['columns'],
          rows: [],
          totalRows: 0,
          page: 1,
          pageSize: 10,
          canEdit: false,
        }),
        40
      )[0]
    ).toBeGreaterThan(112)

    const denseModel = formatGridModel({
      columns: [
        { name: 'id', type: 'INT', isAutoIncrement: true } as never,
        { name: 'note', type: 'TEXT' },
        { name: 'gen', type: 'TEXT', isGenerated: true } as never,
      ],
      rows: [
        { id: 1, note: 'short', gen: 'g1' },
        { id: 2, note: 'a'.repeat(100), gen: 'g2' },
        { id: 3, note: null, gen: 'g3' },
      ],
      totalRows: 3,
      page: 1,
      pageSize: 10,
      canEdit: true,
      primaryKey: ['id'],
    })
    const widths = computeInitialColumnWidthsForGrid(denseModel, 40)
    expect(widths[1]).toBe(300)

    // matchesClientColumnFilters across all operators & unknown column
    expect(matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [])).toBe(true)
    expect(
      matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [
        { column: 'nonexistent', value: '1', op: 'eq' },
      ])
    ).toBe(true)
    expect(
      matchesClientColumnFilters(denseModel.rows[2], denseModel.headers, [
        { column: 'note', value: '', op: 'is-null' },
      ])
    ).toBe(true)
    expect(
      matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [
        { column: 'note', value: '', op: 'is-null' },
      ])
    ).toBe(false)
    expect(
      matchesClientColumnFilters(denseModel.rows[2], denseModel.headers, [
        { column: 'note', value: '', op: 'is-not-null' },
      ])
    ).toBe(false)
    expect(
      matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [
        { column: 'note', value: 'HOR', op: 'contains' },
      ])
    ).toBe(true)
    expect(
      matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [
        { column: 'note', value: 'zzz', op: 'contains' },
      ])
    ).toBe(false)
    expect(
      matchesClientColumnFilters(denseModel.rows[2], denseModel.headers, [
        { column: 'note', value: null, op: 'eq' },
      ])
    ).toBe(true)
    expect(
      matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [
        { column: 'note', value: null, op: 'eq' },
      ])
    ).toBe(false)
    expect(
      matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [
        { column: 'note', value: 'wrong', op: 'eq' },
      ])
    ).toBe(false)
    expect(
      matchesClientColumnFilters(denseModel.rows[2], denseModel.headers, [
        { column: 'note', value: null, op: 'neq' },
      ])
    ).toBe(false)
    expect(
      matchesClientColumnFilters(denseModel.rows[0], denseModel.headers, [
        { column: 'note', value: 'short', op: 'neq' },
      ])
    ).toBe(false)

    // computeFilteredRowIndices with inserted row, array row, circular object, primitives
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const searchModel = formatGridModel({
      columns: ['a', 'b'] as unknown as TableBrowseResult['columns'],
      rows: [
        ['hello', { k: 'world' }],
        [null, circular],
        [42, true],
      ],
      totalRows: 3,
      page: 1,
      pageSize: 10,
      canEdit: false,
    })
    const rowStates: InternalRowState[] = [
      { kind: 'existing', deleted: false, original: searchModel.rows[0], dirtyCols: new Map() },
      { kind: 'inserted', deleted: false, original: searchModel.rows[1], dirtyCols: new Map() },
      { kind: 'existing', deleted: false, original: searchModel.rows[2], dirtyCols: new Map() },
    ]
    expect(computeFilteredRowIndices(searchModel, rowStates, '', [])).toEqual([0, 1, 2])
    expect(computeFilteredRowIndices(searchModel, rowStates, 'world', [])).toEqual([0, 1])
    expect(computeFilteredRowIndices(searchModel, rowStates, '42', [])).toEqual([1, 2])
    expect(
      computeFilteredRowIndices(
        formatGridModel({ columns: ['a'], rows: [[null], [circular]], totalRows: 2, page: 1, pageSize: 10, canEdit: false }),
        [],
        'null',
        [{ column: 'a', value: '', op: 'is-null' }]
      )
    ).toEqual([0])
    expect(
      computeFilteredRowIndices(
        formatGridModel({ columns: ['a'], rows: [[circular]], totalRows: 1, page: 1, pageSize: 10, canEdit: false }),
        [],
        'object',
        []
      )
    ).toEqual([0])

    // Object rows search + null non-match + non-matching string cell
    const objSearchModel = formatGridModel({
      columns: ['a', 'b'],
      rows: [
        { a: null, b: 'alpha' },
        { a: 'hit', b: 'beta' },
      ],
      totalRows: 2,
      page: 1,
      pageSize: 10,
      canEdit: false,
    })
    expect(computeFilteredRowIndices(objSearchModel, [], 'hit', [])).toEqual([1])

    // computeGridFindMatches
    expect(computeGridFindMatches(searchModel, [0, 1, 2], [0, 1], '')).toEqual({
      matches: [],
      matchKeys: new Set(),
    })
    const findRes = computeGridFindMatches(searchModel, [0, 99, 1], [0, 1], 'null', 10)
    expect(findRes.matches).toEqual([{ row: 2, col: 0 }])
    const findCapped = computeGridFindMatches(searchModel, [0, 1, 2], [0, 1], 'o', 1)
    expect(findCapped.matches).toHaveLength(1)
    const findObj = computeGridFindMatches(searchModel, [0, 1, 2], [0, 1], 'object')
    expect(findObj.matches.some((m) => m.row === 1 && m.col === 1)).toBe(true)
    expect(computeGridFindMatches(searchModel, [2], [0, 1], 'true').matches).toEqual([
      { row: 0, col: 1 },
    ])
    const objAndBigIntModel = formatGridModel({
      columns: ['a', 'b'],
      rows: [{ a: 999n, b: 'nope' }],
      totalRows: 1,
      page: 1,
      pageSize: 10,
      canEdit: false,
    })
    expect(computeGridFindMatches(objAndBigIntModel, [0], [0, 1], '999').matches).toEqual([
      { row: 0, col: 0 },
    ])

    // compareGridCellValues properties
    expect(compareGridCellValues(null, 'a', 1)).toBe(1)
    expect(compareGridCellValues('a', null, 1)).toBe(-1)
    expect(compareGridCellValues(5, 10, 1)).toBeLessThan(0)
    expect(compareGridCellValues('10', '2', 1)).toBeGreaterThan(0)
    expect(compareGridCellValues('alpha', 'beta', -1)).toBeGreaterThan(0)
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.integer({ min: -100, max: 100 }), fc.string({ maxLength: 8 })),
        fc.oneof(fc.constant(null), fc.integer({ min: -100, max: 100 }), fc.string({ maxLength: 8 })),
        (a, b) => {
          expect(compareGridCellValues(a, a, 1)).toBe(0)
          const ab = compareGridCellValues(a, b, 1)
          const ba = compareGridCellValues(b, a, 1)
          expect(Math.sign(ab) || 0).toBe(-(Math.sign(ba) || 0) || 0)
        }
      ),
      { numRuns: 100 }
    )

    // Selection snapshot & export across all SelectionExportFormat variants
    const sel = new GridSelectionModel()
    expect(
      buildGridSelectionSnapshot({
        model: denseModel,
        selection: sel,
        visibleRows: [0, 1, 2],
        visibleCols: [0, 1],
        format: 'tsv',
        tableName: 'items',
        dialect: 'postgres',
      })
    ).toBeNull()
    expect(
      exportGridSelectionMatrix({
        model: denseModel,
        selection: sel,
        visibleRows: [0, 1],
        visibleCols: [0, 1],
        format: 'tsv',
        tableName: 'items',
        dialect: 'postgres',
      })
    ).toBe('')

    sel.selectCell(0, 0)
    sel.toggleCell(1, 1) // Sparse multi-cell selection with unselected gaps
    for (const fmt of ['tsv', 'tsv-headers', 'csv', 'json', 'sql-in', 'sql-insert'] as const) {
      const snap = buildGridSelectionSnapshot({
        model: denseModel,
        selection: sel,
        visibleRows: [0, 1, 2],
        visibleCols: [0, 1],
        format: fmt,
        tableName: 'items',
        dialect: 'postgres',
      })
      expect(snap).not.toBeNull()
      expect(exportGridSelectionMatrix({
        model: denseModel,
        selection: sel,
        visibleRows: [0, 1, 2],
        visibleCols: [0, 1],
        format: fmt,
        tableName: 'items',
        dialect: 'postgres',
      })).toBe(snap!.text)
    }

    // Single column selection sql-in includes column name
    sel.selectCell(0, 0)
    const singleColSqlIn = exportGridSelectionMatrix({
      model: denseModel,
      selection: sel,
      visibleRows: [0, 1],
      visibleCols: [0],
      format: 'sql-in',
      tableName: 'items',
      dialect: 'postgres',
    })
    expect(singleColSqlIn).toBe('"id" IN (1)')

    // Undefined cell values map to null in sql-insert and tsv snapshots
    const undefModel = formatGridModel({
      columns: ['id', 'opt'],
      rows: [{ id: 1 }],
      totalRows: 1,
      page: 1,
      pageSize: 10,
      canEdit: false,
    })
    sel.selectCell(0, 1)
    expect(
      exportGridSelectionMatrix({
        model: undefModel,
        selection: sel,
        visibleRows: [0],
        visibleCols: [0, 1],
        format: 'sql-insert',
        tableName: 'items',
        dialect: 'postgres',
      })
    ).toContain('NULL')
    expect(
      exportGridSelectionMatrix({
        model: undefModel,
        selection: sel,
        visibleRows: [0],
        visibleCols: [0, 1],
        format: 'tsv',
        tableName: 'items',
        dialect: 'postgres',
      })
    ).toBe('')

    // createClonedRowRecord omits autoIncrement and generated columns
    expect(createClonedRowRecord(denseModel, 0)).toEqual({ note: 'short' })

    // buildGridChangesPayload & countGridStagedChanges (including sparse undefined slot)
    expect(buildGridChangesPayload(null, [])).toEqual({
      inserts: [],
      updates: [],
      deletes: [],
      deleteRows: [],
    })
    const dirtyMap = new Map<string, unknown>([['note', 'updated']])
    const changeRows = formatGridModel({
      columns: ['id', 'note'],
      rows: [
        { id: 1, note: 'a' },
        { id: 2, note: 'b' },
        { id: 3, note: 'c' },
        { id: 99, note: 'inserted-row' },
        { id: 100, note: 'inserted-deleted' },
      ],
      totalRows: 5,
      page: 1,
      pageSize: 10,
      canEdit: true,
      primaryKey: ['id'],
    })
    const states: (InternalRowState | undefined)[] = [
      undefined,
      { kind: 'existing', deleted: false, original: changeRows.rows[0], dirtyCols: new Map() },
      { kind: 'existing', deleted: false, original: changeRows.rows[1], dirtyCols: dirtyMap },
      { kind: 'existing', deleted: true, original: changeRows.rows[2], dirtyCols: new Map() },
      { kind: 'inserted', deleted: false, original: changeRows.rows[3], dirtyCols: new Map() },
      { kind: 'inserted', deleted: true, original: changeRows.rows[4], dirtyCols: new Map() },
    ]
    const payload = buildGridChangesPayload(changeRows, states.filter(Boolean) as InternalRowState[])
    expect(payload.inserts).toEqual([{ id: 99, note: 'inserted-row' }])
    expect(payload.updates).toHaveLength(1)
    expect(payload.updates[0].changes).toEqual({ note: 'updated' })
    expect(payload.deletes).toEqual([{ id: 3 }])
    expect(countGridStagedChanges(states as InternalRowState[])).toBe(3)
  })
})
