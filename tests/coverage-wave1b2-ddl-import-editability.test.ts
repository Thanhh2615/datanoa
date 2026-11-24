import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import type { ColumnInfo, TableDetails } from '../src/protocol'
import {
  COMMON_COLUMN_TYPES,
  DDL_KEYWORDS,
  DDL_TOKEN_REGEX,
  DDL_TYPES,
  REFERENTIAL_ACTIONS,
  appendFormattedDdl,
  escapeHtml,
  formatDdlForDisplay,
  normalizeTableDetailsForDraft,
} from '../src/editor/schema-ddl'
import {
  autoMapImportColumns,
  buildImportPreviewSql,
  buildMappedImportRecords,
  coerceImportCellValue,
  decodeImportBytes,
  detectImportDelimiter,
  detectImportFormat,
  parseDelimitedImportText,
  parseImportBytes,
  parseImportText,
  parseJsonPreservingBigInts,
  validateImportMapping,
} from '../src/editor/data-import'
import { analyzeEditableSelectQuery } from '../src/editor/select-editability'

const origDocument = (globalThis as { document?: unknown }).document

afterEach(() => {
  if (origDocument === undefined) {
    delete (globalThis as { document?: unknown }).document
  } else {
    ;(globalThis as { document?: unknown }).document = origDocument
  }
})

describe('Wave 1B-2a: src/editor/schema-ddl.ts', () => {
  it('escapes HTML special characters and preserves safe values', () => {
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(42)).toBe('42')
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    )
    expect(DDL_KEYWORDS.has('CREATE')).toBe(true)
    expect(DDL_TYPES.has('TIMESTAMPTZ')).toBe(true)
    expect(DDL_TOKEN_REGEX.global).toBe(true)
    expect(COMMON_COLUMN_TYPES).toContain('JSONB')
    expect(REFERENTIAL_ACTIONS).toContain('CASCADE')

    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const escaped = escapeHtml(s)
        expect(escaped).not.toMatch(/[<>"']/)
      }),
      { numRuns: 100 }
    )
  })

  it('tokenizes DDL comments, strings, numbers, keywords, types, and trailing punctuation', () => {
    const children: Array<{ textContent: string; className: string }> = []
    ;(globalThis as { document?: unknown }).document = {
      createElement: () => ({ textContent: '', className: '' }),
    }
    const codeEl = {
      appendChild: (node: { textContent: string; className: string }) => {
        children.push(node)
        return node
      },
    } as unknown as HTMLElement

    appendFormattedDdl(
      codeEl,
      "  -- header\nCREATE TABLE users (\n  id INTEGER DEFAULT 0, -- id\n  tag TEXT DEFAULT 'a''b\\n',\n  ratio NUMERIC DEFAULT 1.5\n);"
    )

    expect(children.some((n) => n.className === 'datanoa-ddl-cmt' && n.textContent.startsWith('--'))).toBe(true)
    expect(children.some((n) => n.className === 'datanoa-ddl-kw' && n.textContent === 'CREATE')).toBe(true)
    expect(children.some((n) => n.className === 'datanoa-ddl-type' && n.textContent === 'INTEGER')).toBe(true)
    expect(children.some((n) => n.className === 'datanoa-ddl-str' && n.textContent.startsWith("'a''b"))).toBe(true)
    expect(children.some((n) => n.className === 'datanoa-ddl-num' && n.textContent === '1.5')).toBe(true)
    expect(children.some((n) => n.className === '' && n.textContent === 'users')).toBe(true)
    expect(children[children.length - 1]?.textContent).toBe('\n);')

    const noTail: Array<{ textContent: string; className: string }> = []
    appendFormattedDdl(
      { appendChild: (n: { textContent: string; className: string }) => { noTail.push(n); return n } } as unknown as HTMLElement,
      'CREATE TABLE x'
    )
    expect(noTail[noTail.length - 1]?.textContent).toBe('x')
  })

  it('formats CREATE TABLE DDL cleanly across comments, quotes, brackets, nesting, and edge inputs', () => {
    expect(formatDdlForDisplay('')).toBe('')
    expect(formatDdlForDisplay(undefined as unknown as string)).toBe('')
    expect(formatDdlForDisplay('   \n  ')).toBe('')
    expect(formatDdlForDisplay('CREATE VIEW v AS SELECT 1')).toBe('CREATE VIEW v AS SELECT 1')
    expect(formatDdlForDisplay('CREATE TABLE no_parens')).toBe('CREATE TABLE no_parens')
    expect(formatDdlForDisplay('CREATE TABLE unclosed (id INT')).toBe('CREATE TABLE unclosed (id INT')
    expect(formatDdlForDisplay('CREATE TABLE empty_cols ()')).toBe('CREATE TABLE empty_cols ()')
    expect(formatDdlForDisplay('CREATE TABLE short_one (id INTEGER PRIMARY KEY)')).toBe(
      'CREATE TABLE short_one (id INTEGER PRIMARY KEY)'
    )

    const denseLongSingleCol = `CREATE TABLE long_single (very_long_column_identifier_with_constraint_and_default_value VARCHAR(255) NOT NULL DEFAULT '${'x'.repeat(80)}')`
    expect(formatDdlForDisplay(denseLongSingleCol)).toContain('\n  very_long_column_identifier')

    const alreadyShortMultiline = 'CREATE TABLE ml (\n  id INT,\n  name TEXT\n)'
    expect(formatDdlForDisplay(alreadyShortMultiline)).toBe(alreadyShortMultiline)

    const longMultiline2Lines = `CREATE TABLE ml2 (\n  id INT DEFAULT 1, title VARCHAR(255) NOT NULL DEFAULT '${'a'.repeat(100)}'\n)`
    expect(formatDdlForDisplay(longMultiline2Lines)).toContain('\n  title VARCHAR(255)')

    const fourShortLines = 'CREATE TABLE ml4 (\n  id INT,\n  a INT,\n  b INT,\n  c INT\n)'
    expect(formatDdlForDisplay(fourShortLines)).toBe(fourShortLines)

    const complexSingle =
      "CREATE TEMPORARY TABLE ) skip -- hdr(\n" +
      '/* block ( */\n' +
      "[my [table] ([id] INT DEFAULT 'a''b\\'(c)', \"nm\"\"(x)\" VARCHAR(20), `bk``(y)` DECIMAL(10, 2) CHECK (bk > 0)) -- trailing"
    const complexFormatted = formatDdlForDisplay(complexSingle)
    expect(complexFormatted).toContain('my [table]')

    // Inner splitTopLevelCommas edge cases (comments with EOF, unclosed quotes/blocks, escaped backslashes, empty commas)
    const innerEdge =
      "CREATE TABLE edge_tbl (a TEXT DEFAULT 'it\\'s,ok', /* c */ b TEXT DEFAULT \"x\"\"y,z\", c DECIMAL(5,2),, -- eof"
    expect(formatDdlForDisplay(innerEdge)).toBe(innerEdge)

    const validInnerWithCommentsAndEscapes =
      "CREATE TABLE inner_ok (a TEXT DEFAULT 'it\\'s''ok,1', /* inner */ b INT, /* c2 */ c TEXT DEFAULT `a``b,c`)"
    const formattedInnerOk = formatDdlForDisplay(validInnerWithCommentsAndEscapes)
    expect(formattedInnerOk).toContain('\n  /* inner */ b INT,')
    expect(formattedInnerOk).toContain('c TEXT')

    const innerCommentEof = 'CREATE TABLE eof_cmt (a INT, /* unclosed'
    expect(formatDdlForDisplay(innerCommentEof)).toBe(innerCommentEof)

    // Trigger splitTopLevelCommas unclosed bracket / comment EOF directly with balanced outer parens
    const parenWithInnerComments =
      "CREATE TABLE t (a INT CHECK (1=1) -- c\n, /* c */ b INT DEFAULT 'x', d TEXT CHECK (d IN ('a') /* c2 */), /* unclosed"
    expect(formatDdlForDisplay(parenWithInnerComments)).toBe(parenWithInnerComments)

    const parenWithBalancedOuterAndInnerEof =
      "CREATE TABLE t (/* a */ a INT, b INT -- line\n) ; CREATE TABLE u (c INT, d INT CHECK (d = ')') )"
    const multiOut = formatDdlForDisplay(parenWithBalancedOuterAndInnerEof, 'sqlite')
    expect(multiOut).toContain('CREATE TABLE u (\n  c INT,')

    // Unclosed inner block comment / quote inside outer matched parens (escaped EOF)
    expect(formatDdlForDisplay("CREATE TABLE [unclosed_bkt (a INT)")).toBe(
      'CREATE TABLE [unclosed_bkt (a INT)'
    )
    expect(formatDdlForDisplay('CREATE TABLE "unclosed_dq')).toBe('CREATE TABLE "unclosed_dq')
    expect(formatDdlForDisplay('CREATE TABLE t (a INT, b INT)')).toContain('\n  a INT,\n  b INT\n)')
    expect(formatDdlForDisplay("CREATE TEMP TABLE t (a INT CHECK (a > 0) /* cmt */, b TEXT DEFAULT 'x\\'\\'' , /* blk */ c INT) -- eof")).toContain('\n  a INT CHECK')

    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 1, maxLength: 5 }), (cols) => {
        const sql = `CREATE TABLE tbl (${cols.map((c) => `${c} INT`).join(', ')})`
        const out = formatDdlForDisplay(sql)
        for (const c of cols) expect(out).toContain(c)
      }),
      { numRuns: 50 }
    )
  })

  it('covers splitTopLevelCommas unclosed quotes/comments inside balanced parens via inner syntax', () => {
    // Force findOuterCreateTableParens to match while inner contains trailing ')' after extra '(' or '--' without nl in inner slice
    const s1 = 'CREATE TABLE t (a INT, b INT) -- )'
    expect(formatDdlForDisplay(s1)).toContain('\n  a INT,')
    // Inner slice ends with ')' unmatched inside balanced outer parens via extra '('? Wait: ) depth guard in splitTopLevelCommas
    const s2 = "CREATE TABLE t (a TEXT CHECK (a = '('), b INT)"
    expect(formatDdlForDisplay(s2)).toContain('b INT')
    // Extra ')' in findOuterCreateTableParens & splitTopLevelCommas (handled cleanly without throwing)
    expect(() =>
      formatDdlForDisplay("CREATE TABLE t (a INT DEFAULT -- eof\n /* x */ , b TEXT DEFAULT 'ab''\\c', )")
    ).not.toThrow()
  })

  it('normalizes partial and rich TableDetails objects into editable drafts', () => {
    const emptyDraft = normalizeTableDetailsForDraft({
      name: 'minimal',
      schema: 'public',
      columns: [],
      indexes: [],
      foreignKeys: [],
      primaryKey: [],
    })
    expect(emptyDraft).toEqual({
      name: 'minimal',
      schema: 'public',
      columns: [],
      indexes: [],
      foreignKeys: [],
      primaryKey: [],
    })

    const partial = normalizeTableDetailsForDraft({
      name: 'orders',
      schema: 'public',
    } as unknown as TableDetails)
    expect(partial.columns).toEqual([])
    expect(partial.indexes).toEqual([])
    expect(partial.foreignKeys).toEqual([])

    const rich = normalizeTableDetailsForDraft({
      name: 'orders',
      schema: 'public',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: '', nativeType: '', nullable: false, defaultValue: 0, isAutoIncrement: true } as unknown as ColumnInfo,
        { name: 'note', type: 'TEXT', nativeType: '', nullable: true, defaultValue: null } as unknown as ColumnInfo,
        { name: 'code', type: '', nativeType: 'VARCHAR(16)', nullable: true, defaultValue: undefined } as unknown as ColumnInfo,
      ],
      indexes: [
        { name: 'idx_1', columns: ['code'], isUnique: true, isPrimary: false },
        { name: 'idx_2', columns: undefined as unknown as string[], isUnique: false, isPrimary: true },
      ],
      foreignKeys: [
        { constraintName: '', column: 'id', referencedTable: '', referencedColumn: '' },
        {
          constraintName: 'fk_u',
          column: 'code',
          referencedTable: 'users',
          referencedColumn: 'code',
          referencedSchema: 'auth',
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
        },
      ],
    })
    expect(rich.columns[0]).toMatchObject({
      type: 'TEXT',
      nativeType: 'TEXT',
      nullable: false,
      defaultValue: '0',
      isPrimaryKey: true,
      isAutoIncrement: true,
    })
    expect(rich.columns[1].defaultValue).toBeNull()
    expect(rich.columns[2].type).toBe('VARCHAR(16)')
    expect(rich.indexes[1].columns).toEqual([])
    expect(rich.foreignKeys[0]).toEqual({
      constraintName: '',
      column: 'id',
      referencedTable: '',
      referencedColumn: 'id',
    })
    expect(rich.foreignKeys[1]).toMatchObject({
      referencedSchema: 'auth',
      onDelete: 'CASCADE',
      onUpdate: 'RESTRICT',
    })
  })
})

describe('Wave 1B-2a: src/editor/data-import.ts', () => {
  it('decodes bytes across BOMs, explicit encodings, fallback encodings, and invalid UTF-8', () => {
    expect(parseJsonPreservingBigInts('{"id":9007199254740993}')).toEqual({
      id: '9007199254740993',
    })

    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62])
    expect(decodeImportBytes(utf8Bom)).toEqual({ text: 'a,b', resolvedEncoding: 'utf-8' })

    const utf16Le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])
    expect(decodeImportBytes(utf16Le)).toEqual({ text: 'hi', resolvedEncoding: 'utf-16le' })

    const utf16Be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])
    expect(decodeImportBytes(utf16Be)).toEqual({ text: 'hi', resolvedEncoding: 'utf-16be' })

    const badUtf8 = new Uint8Array([0xff, 0x80, 0x41])
    expect(() => decodeImportBytes(badUtf8, 'utf-8')).toThrow(/not valid UTF-8/)
    expect(decodeImportBytes(badUtf8, 'auto').resolvedEncoding).toBe('windows-1252')
    expect(decodeImportBytes(badUtf8, 'bogus-encoding' as unknown as 'auto')).toMatchObject({
      resolvedEncoding: 'utf-8',
    })

    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const res = decodeImportBytes(bytes, 'auto')
        expect(typeof res.text).toBe('string')
        expect(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252']).toContain(res.resolvedEncoding)
      }),
      { numRuns: 100 }
    )
  })

  it('detects formats and delimiters accurately across extensions, NDJSON, JSON, quotes, and CSV', () => {
    expect(detectImportFormat('anything', 'data.NDJSON')).toBe('ndjson')
    expect(detectImportFormat('anything', 'data.jsonl')).toBe('ndjson')
    expect(detectImportFormat('anything', 'data.json')).toBe('json')
    expect(detectImportFormat('anything', 'data.tsv')).toBe('tsv')
    expect(detectImportFormat('anything', 'data.tab')).toBe('tsv')
    expect(detectImportFormat('anything', 'data.csv')).toBe('csv')
    expect(detectImportFormat('a,b\n1,2', 'trailingdot.')).toBe('csv')

    expect(detectImportFormat('[1,2]\n[3,4]')).toBe('ndjson')
    expect(detectImportFormat('[{"a":1}]')).toBe('json')
    expect(detectImportFormat('{"a":1}\n{"a":2}')).toBe('ndjson')
    expect(detectImportFormat('{"a":1}\nnot-json')).toBe('ndjson')
    expect(detectImportFormat('{"a":\n1}')).toBe('json')
    expect(detectImportFormat('{invalid\n{still-bad')).toBe('ndjson')
    expect(detectImportFormat('{\n"a": 1\n}')).toBe('json')
    expect(detectImportFormat('x\ty\n1\t2')).toBe('tsv')
    expect(detectImportFormat('x;y\n1;2')).toBe('csv')

    expect(detectImportDelimiter('')).toBe(',')
    expect(detectImportDelimiter('   \n  ')).toBe(',')
    expect(detectImportDelimiter('"a;b",c\r\n"d""e",f\r1,2')).toBe(',')
    expect(detectImportDelimiter('a|b|c\n1|2|3')).toBe('|')
    const manyLines = Array.from({ length: 16 }, (_, idx) => `c1;c2;c${idx}`).join('\n')
    expect(detectImportDelimiter(manyLines)).toBe(';')
    expect(detectImportDelimiter('"unclosed')).toBe(',')
  })

  it('parses CSV/TSV/JSON/NDJSON text and bytes cleanly including malformed, mixed, and jagged inputs', () => {
    expect(parseDelimitedImportText('', ',')).toEqual([])
    expect(
      parseDelimitedImportText('  "a""b", "c\nd"\r\n1,2\r\n\r\n', ',')
    ).toEqual([
      ['a"b', 'c\nd'],
      ['1', '2'],
    ])
    expect(parseDelimitedImportText('a,b\n1,""', ',')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ])
    expect(parseDelimitedImportText('a\rb', ',')).toEqual([['a'], ['b']])

    expect(parseImportText('  ', { format: 'auto', delimiter: 'auto', hasHeaderRow: true, trimValues: true })).toMatchObject({
      resolvedFormat: 'csv',
      totalRows: 0,
    })
    expect(parseImportText('  ', { format: 'json', delimiter: 'auto', hasHeaderRow: false, trimValues: false })).toMatchObject({
      resolvedFormat: 'json',
      resolvedDelimiter: null,
      totalRows: 0,
    })

    expect(() =>
      parseImportText('{bad', { format: 'json', delimiter: 'auto', hasHeaderRow: true, trimValues: true })
    ).toThrow(/Invalid JSON syntax/)
    expect(() =>
      parseImportText('123', { format: 'json', delimiter: 'auto', hasHeaderRow: true, trimValues: true })
    ).toThrow(/expects an array/)
    expect(
      parseImportText('[]', { format: 'json', delimiter: 'auto', hasHeaderRow: true, trimValues: true }).totalRows
    ).toBe(0)
    expect(
      parseImportText('{"id":1,"name":"A"}', { format: 'json', delimiter: 'auto', hasHeaderRow: true, trimValues: true })
    ).toMatchObject({ headers: ['id', 'name'], rows: [[1, 'A']] })

    const arrWithHeaders = parseImportText(
      '[[null,"name","name"],["1","alice"],["2"]]',
      { format: 'json', delimiter: 'auto', hasHeaderRow: true, trimValues: true }
    )
    expect(arrWithHeaders.headers).toEqual(['col_1', 'name', 'name_2'])
    expect(arrWithHeaders.rows).toEqual([
      ['1', 'alice', undefined],
      ['2', undefined, undefined],
    ])

    const arrNoHeaders = parseImportText('[[1,2],[3]]', {
      format: 'json',
      delimiter: 'auto',
      hasHeaderRow: false,
      trimValues: true,
    })
    expect(arrNoHeaders.headers).toEqual(['col_1', 'col_2'])
    expect(arrNoHeaders.hasNamedHeaders).toBe(false)

    const mixedArr = parseImportText('[{"a":1,"b":2}, 42, {"b":3}]', {
      format: 'json',
      delimiter: 'auto',
      hasHeaderRow: true,
      trimValues: true,
    })
    expect(mixedArr.warnings[0]).toContain('Skipped 1 non-object')
    expect(mixedArr.rows[1][0]).toBeUndefined()

    expect(() =>
      parseImportText('[1,2]', { format: 'json', delimiter: 'auto', hasHeaderRow: true, trimValues: true })
    ).toThrow(/does not contain object/)

    expect(
      parseImportText('{"a":1}\n\n{"b":2}\n', {
        format: 'ndjson',
        delimiter: 'auto',
        hasHeaderRow: true,
        trimValues: true,
      })
    ).toMatchObject({ totalRows: 2, headers: ['a', 'b'] })
    expect(() =>
      parseImportText('{"a":1}\n{bad}', {
        format: 'ndjson',
        delimiter: 'auto',
        hasHeaderRow: true,
        trimValues: true,
      })
    ).toThrow(/Invalid NDJSON at line 2/)

    expect(
      parseImportText('\n\n', { format: 'csv', delimiter: ',', hasHeaderRow: true, trimValues: true })
    ).toMatchObject({ totalRows: 0 })
    const blankHeaderMatrix = parseImportText('\n1,2', {
      format: 'csv',
      delimiter: ',',
      hasHeaderRow: true,
      trimValues: true,
    })
    expect(blankHeaderMatrix.headers).toEqual(['col_1', 'col_2'])

    const tsvAuto = parseImportBytes(new TextEncoder().encode('id\tname\n1\t" alice "\n2'), {
      format: 'tsv',
      delimiter: 'auto',
      encoding: 'auto',
      hasHeaderRow: true,
      trimValues: true,
    })
    expect(tsvAuto.resolvedDelimiter).toBe('\t')
    expect(tsvAuto.warnings[0]).toContain('padded')
    expect(tsvAuto.rows[0][1]).toBe('alice')
    expect(tsvAuto.rows[1][1]).toBe('')

    const noTrimNoHeader = parseImportText(' , \n a ', {
      format: 'csv',
      delimiter: ',',
      hasHeaderRow: false,
      trimValues: false,
    })
    expect(noTrimNoHeader.headers).toEqual(['col_1', 'col_2'])
    expect(noTrimNoHeader.rows[1]).toEqual([' a ', ''])

    // parseDelimitedImportText property test: CSV roundtrip
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.stringMatching(/^[A-Za-z0-9 ,"]{0,8}$/), { minLength: 2, maxLength: 4 }),
          { minLength: 1, maxLength: 5 }
        ),
        (matrix) => {
          // Prefix space only isn't stripped by RFC parser unless unquoted space before quote
          const sanitized = matrix.map((r) => r.map((c) => (c.startsWith(' ') ? `x${c}` : c)))
          const csv = sanitized
            .map((r) => r.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
            .join('\r\n')
          expect(parseDelimitedImportText(csv, ',')).toEqual(sanitized)
        }
      ),
      { numRuns: 50 }
    )
  })

  it('auto-maps, validates, coerces cells, builds records, and generates SQL preview', () => {
    const schema: ColumnInfo[] = [
      { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true, isGenerated: false },
      { name: 'first_name', type: 'TEXT', nativeType: 'TEXT', nullable: false, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isGenerated: false },
      { name: 'is_active', type: 'BOOLEAN', nativeType: 'BOOLEAN', nullable: false, defaultValue: 'TRUE', isPrimaryKey: false, isAutoIncrement: false, isGenerated: false },
      { name: 'score', type: 'INTEGER', nativeType: 'INTEGER', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isGenerated: false },
      { name: 'computed', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isGenerated: true },
    ]

    const positional = autoMapImportColumns(['alice', 'true', '10', '99', 'extra'], schema, false)
    expect(positional.map((m) => m.targetColumn)).toEqual([
      'first_name',
      'is_active',
      'score',
      'id',
      null,
    ])

    const byName = autoMapImportColumns(
      ['score', 'SCORE', 'First Name', 'first_name', '---', 'computed'],
      schema,
      true
    )
    expect(byName.map((m) => m.targetColumn)).toEqual([
      'score',
      null,
      null,
      'first_name',
      null,
      null,
    ])
    expect(
      autoMapImportColumns(['First Name', 'FIRST_NAME'], schema, true).map((m) => m.targetColumn)
    ).toEqual([null, 'first_name'])
    expect(
      autoMapImportColumns(['First Name'], schema, true).map((m) => m.targetColumn)
    ).toEqual(['first_name'])

    // Duplicate case-insensitive and normalized collisions without exact hits
    const schemaDup: ColumnInfo[] = [
      { name: 'User_Id', type: 'INT', nativeType: 'INT', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: false, isGenerated: false },
    ]
    const dupMatches = autoMapImportColumns(['user_id', 'USER_ID', 'user id', 'other'], schemaDup, true)
    expect(dupMatches.map((m) => m.targetColumn)).toEqual(['User_Id', null, null, null])

    expect(
      validateImportMapping(
        [
          { sourceIndex: 0, sourceName: 'a', targetColumn: null },
          { sourceIndex: 1, sourceName: 'b', targetColumn: 'missing' },
          { sourceIndex: 2, sourceName: 'c', targetColumn: 'computed' },
          { sourceIndex: 3, sourceName: 'd', targetColumn: 'id' },
          { sourceIndex: 4, sourceName: 'e', targetColumn: 'id' },
        ],
        schema
      )
    ).toMatchObject({
      valid: false,
      mappedCount: 1,
    })
    expect(validateImportMapping([], schema).valid).toBe(false)

    // Object coercion including circular stringify fallback
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(coerceImportCellValue(circular, schema[1], { nullHandling: 'none', trimValues: true })).toContain('[object Object]')
    expect(coerceImportCellValue({ x: 1 }, schema[1], { nullHandling: 'none', trimValues: true })).toBe('{"x":1}')
    expect(coerceImportCellValue(undefined, schema[1], { nullHandling: 'none', trimValues: true })).toBeNull()
    expect(coerceImportCellValue(true, schema[2], { nullHandling: 'none', trimValues: true })).toBe(true)
    expect(coerceImportCellValue(NaN, schema[3], { nullHandling: 'none', trimValues: true })).toBeNull()
    expect(coerceImportCellValue(1, schema[2], { nullHandling: 'none', trimValues: true })).toBe(true)
    expect(coerceImportCellValue(5, schema[3], { nullHandling: 'none', trimValues: true })).toBe(5)
    expect(coerceImportCellValue('  ', schema[1], { nullHandling: 'empty-only', trimValues: true })).toBeNull()
    expect(coerceImportCellValue(' NULL ', schema[1], { nullHandling: 'null-literal-only', trimValues: false })).toBeNull()
    expect(coerceImportCellValue('\\N', schema[1], { nullHandling: 'empty-and-null', trimValues: true })).toBeNull()
    expect(coerceImportCellValue('yes', schema[2], { nullHandling: 'none', trimValues: true })).toBe(true)
    expect(coerceImportCellValue('0', schema[2], { nullHandling: 'none', trimValues: true })).toBe(false)
    expect(coerceImportCellValue('maybe', { name: 'flag', nativeType: 'TINYINT(1)' } as ColumnInfo, { nullHandling: 'none', trimValues: true })).toBe('maybe')
    expect(coerceImportCellValue('hi', undefined, { nullHandling: 'none', trimValues: true })).toBe('hi')

    const built = buildMappedImportRecords(
      { rows: [[null, '   '], [42, 'Bob'], ['only1']] },
      [
        { sourceIndex: 0, sourceName: 'c1', targetColumn: 'score' },
        { sourceIndex: 1, sourceName: 'c2', targetColumn: 'first_name' },
      ],
      schema,
      { nullHandling: 'empty-and-null', trimValues: true, skipEmptyRows: true }
    )
    expect(built.skippedEmptyRows).toBe(1)
    expect(built.rows).toEqual([
      { score: 42, first_name: 'Bob' },
      { score: 'only1', first_name: null },
    ])

    expect(buildImportPreviewSql([], { driver: 'postgres', table: 'users' })).toContain('No rows')
    const preview = buildImportPreviewSql(
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      { driver: 'postgres', table: 'users', schema: 'public', maxStatements: 2 }
    )
    expect(preview).toContain('and 2 more row(s)')

    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z_ ]{1,12}$/), { maxLength: 6 }),
        fc.boolean(),
        (headers, hasHeaderRow) => {
          const mapping = autoMapImportColumns(headers, schema, hasHeaderRow)
          const nonNull = mapping.map((m) => m.targetColumn).filter((t): t is string => t !== null)
          expect(new Set(nonNull).size).toBe(nonNull.length)
          expect(nonNull).not.toContain('computed')
        }
      ),
      { numRuns: 50 }
    )
  })
})

describe('Wave 1B-2a: src/editor/select-editability.ts', () => {
  const usersDetails: TableDetails = {
    name: 'users',
    schema: 'public',
    kind: 'table',
    primaryKey: ['id'],
    columns: [
      { name: 'id', type: 'INTEGER', nativeType: 'INTEGER', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true, isGenerated: false },
      { name: 'name', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isGenerated: false },
      { name: 'email', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isGenerated: false },
    ],
    indexes: [],
    foreignKeys: [],
  }

  const baseParams = {
    sql: 'SELECT id, name FROM public.users',
    dialect: 'postgres' as const,
    isReadOnly: false,
    resultColumns: [{ name: 'id', type: 'INTEGER' }, { name: 'name' }],
    schemaObjects: [{ name: 'users', schema: 'public', kind: 'table' as const }],
    resolveTableDetails: (table: string, schema?: string) =>
      table.toLowerCase() === 'users' && (!schema || schema === 'public') ? usersDetails : undefined,
  }

  it('covers early rejections, dialect comments/quotes, forbidden clauses, FROM validation, and PG schema guards', () => {
    expect(analyzeEditableSelectQuery({ ...baseParams, isReadOnly: true })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, dialect: 'redis' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, dialect: 'mongodb' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: '   ' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: '-- only comment' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT 1; SELECT 2' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: '@' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'WITH c AS (SELECT 1) SELECT * FROM c' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'DELETE FROM public.users' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT DISTINCT id FROM public.users' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT id FROM public.users GROUP BY id' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT ROW_NUMBER() OVER () FROM public.users' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT 1' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT COUNT(*) FROM public.users' })).toMatchObject({ editable: false, reason: 'aggregate_query' })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT id FROM' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT id FROM (SELECT id FROM public.users) s' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT id FROM public.' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT id FROM public.users AS' })).toMatchObject({ editable: true })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT id FROM public.users u, public.other o' })).toMatchObject({ editable: false })
    expect(analyzeEditableSelectQuery({ ...baseParams, sql: 'SELECT id FROM public.users JOIN other ON 1=1' })).toMatchObject({ editable: false })
    expect(
      analyzeEditableSelectQuery({ ...baseParams, resolvedSourceTable: { table: 'other', schema: 'public' } })
    ).toMatchObject({ editable: false, reason: 'source_table_mismatch' })
    expect(
      analyzeEditableSelectQuery({ ...baseParams, resolvedSourceTable: { table: 'users', schema: 'private' } })
    ).toMatchObject({ editable: false, reason: 'source_table_mismatch' })
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        sql: 'SELECT id FROM users',
        schemaObjects: [
          { name: 'users', schema: 'public', kind: 'table' },
          { name: 'users', schema: 'audit', kind: 'table' },
        ],
      })
    ).toMatchObject({ editable: false, reason: 'ambiguous_schema' })
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        sql: 'SELECT id FROM users_view',
        schemaObjects: [{ name: 'users_view', schema: 'public', kind: 'view' }],
      })
    ).toMatchObject({ editable: false })
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        sql: 'SELECT id FROM public.missing_tbl',
        schemaObjects: [],
        resolveTableDetails: () => undefined,
      })
    ).toMatchObject({ editable: false, reason: 'missing_table_details' })
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        resolveTableDetails: () => ({ ...usersDetails, kind: 'view' }),
      })
    ).toMatchObject({ editable: false })
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        resolveTableDetails: () => ({ ...usersDetails, primaryKey: [] }),
      })
    ).toMatchObject({ editable: false })
    expect(
      analyzeEditableSelectQuery({ ...baseParams, resultColumns: [] })
    ).toMatchObject({ editable: false })
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        resultColumns: [{ name: 'id' }, { name: 'ID' }],
      })
    ).toMatchObject({ editable: false })
  })

  it('covers projections, aliases, dialect syntax (#, E-strings, $$dollar$$, [brackets], `ticks`, MSSQL TOP), and PK guards', () => {
    // PG E-strings, dollar quotes, nested block comments, line comments, schema inference, resolvedSourceTable fill
    const pgComplex = analyzeEditableSelectQuery({
      ...baseParams,
      sql: `-- lead\nSELECT ALL "id" AS "ID", u.name, 'x' AS literal_col, E'esc\\'str', $$dollar$$, /* /* nested */ */ 1 + 1 AS extra FROM users AS u WHERE "name" = 'a'`,
      resultColumns: [{ name: 'id' }, { name: 'name' }, { name: 'literal_col', type: 'TEXT' }, { name: 'extra' }],
      resolvedSourceTable: { table: 'users', schema: 'public' },
    })
    expect(pgComplex.editable).toBe(true)
    expect(pgComplex.columns?.find((c) => c.name === 'literal_col')?.isGenerated).toBe(true)
    expect(pgComplex.columns?.find((c) => c.name === 'extra')?.isGenerated).toBe(true)

    // MySQL # comment + backtick escaping
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'mysql',
        schemaObjects: [],
        sql: "SELECT `id`, `name` 'lbl' # cmt\nFROM `users` WHERE name = 'it\\'s'",
      })
    ).toMatchObject({ editable: true })

    // MSSQL TOP (5) PERCENT WITH TIES + [bracket]]ident] + u.* star projection
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'mssql',
        schemaObjects: [],
        sql: 'SELECT TOP (5) PERCENT WITH TIES u.*, id FROM [dbo].[users] u',
        resolveTableDetails: () => usersDetails,
        resultColumns: [{ name: 'id' }, { name: 'name' }, { name: 'email' }],
      })
    ).toMatchObject({ editable: true })

    // Bare aliases & PK guards
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [{ name: 'users', schema: '', kind: 'table' }],
        sql: 'SELECT u.id uid FROM users',
        resultColumns: [{ name: 'uid' }, { name: 'id' }],
      })
    ).toMatchObject({ editable: false, reason: 'aliased_or_computed_pk' })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT id AS pk_alias, name my_name FROM users',
        resultColumns: [{ name: 'pk_alias' }, { name: 'my_name' }],
      })
    ).toMatchObject({ editable: false, reason: 'aliased_or_computed_pk' })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT id + 1 AS id FROM users',
        resultColumns: [{ name: 'id' }],
      })
    ).toMatchObject({ editable: false, reason: 'aliased_or_computed_pk' })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT id AS FROM users',
        resultColumns: [{ name: 'id' }, { name: 'name' }],
      })
    ).toMatchObject({ editable: false, reason: 'aliased_or_computed_pk' })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT name FROM users',
        resultColumns: [{ name: 'name' }],
      })
    ).toMatchObject({ editable: false })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT * FROM users',
        resultColumns: [{ name: 'name' }],
      })
    ).toMatchObject({ editable: true })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT 1 + id FROM users',
        resultColumns: [{ name: 'id' }],
      })
    ).toMatchObject({ editable: false, reason: 'aliased_or_computed_pk' })

    // Match matchedCol inside resultColumns when computed (COALESCE(name, '') AS name)
    const computedMatched = analyzeEditableSelectQuery({
      ...baseParams,
      dialect: 'sqlite',
      schemaObjects: [],
      sql: 'SELECT id, COALESCE(name, \'x\') AS name FROM users',
      resultColumns: [{ name: 'id' }, { name: 'name' }],
    })
    expect(computedMatched.editable).toBe(true)
    expect(computedMatched.columns?.find((c) => c.name === 'name')?.isGenerated).toBe(true)

    fc.assert(
      fc.property(
        fc.constantFrom('DISTINCT', 'JOIN other ON 1=1', 'GROUP BY id', 'UNION SELECT id, name FROM users'),
        (forbiddenClause) => {
          const sql = forbiddenClause === 'DISTINCT'
            ? 'SELECT DISTINCT id, name FROM public.users'
            : `SELECT id, name FROM public.users ${forbiddenClause}`
          expect(analyzeEditableSelectQuery({ ...baseParams, sql }).editable).toBe(false)
        }
      ),
      { numRuns: 20 }
    )

    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (randomSql) => {
        const res = analyzeEditableSelectQuery({ ...baseParams, sql: randomSql })
        expect(typeof res.editable).toBe('boolean')
      }),
      { numRuns: 100 }
    )
  })

  it('closes remaining reachable branches across schema-ddl, data-import, and select-editability', () => {
    // schema-ddl.ts: splitTopLevelCommas `-- comment\n` with inner > 120 chars & <= 3 lines
    const ddlWithLineComment = `CREATE TABLE t_line_cmt (${'col_pad_'.repeat(16)}name VARCHAR(120), -- trailing\n  b INT, c INT)`
    expect(formatDdlForDisplay(ddlWithLineComment)).toContain('\n  b INT,')

    // data-import.ts: stripLeadingBom on raw string, empty-only non-null token, omitted maxStatements
    expect(detectImportFormat('\uFEFFcol1,col2\n1,2')).toBe('csv')
    expect(
      coerceImportCellValue('abc', { name: 'note', type: 'TEXT', nativeType: 'TEXT', nullable: true, defaultValue: null, isPrimaryKey: false, isAutoIncrement: false, isGenerated: false }, { nullHandling: 'empty-only', trimValues: true })
    ).toBe('abc')
    expect(buildImportPreviewSql([{ id: 1 }], { driver: 'postgres', table: 'users' })).toContain('INSERT INTO')

    // select-editability.ts: unclosed $tag$, [bracket]] escaped & unclosed [, MSSQL TOP (unclosed), quoted "JOIN", schema: ''
    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        sql: 'SELECT id, $tag$unclosed FROM public.users',
      })
    ).toMatchObject({ editable: false })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT [id]], name FROM [unclosed',
        resultColumns: [{ name: 'id' }],
      })
    ).toMatchObject({ editable: false })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'mssql',
        schemaObjects: [],
        sql: 'SELECT TOP (5 FROM users',
      })
    ).toMatchObject({ editable: false })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'mssql',
        schemaObjects: [],
        sql: 'SELECT TOP (1 + 2 FROM users',
      })
    ).toMatchObject({ editable: false })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'mssql',
        schemaObjects: [],
        sql: 'SELECT TOP (1 + 2) id FROM users',
        resolveTableDetails: () => ({ ...usersDetails, schema: '' }),
        resultColumns: [{ name: 'id' }],
      })
    ).toMatchObject({ editable: true })

    // Cover data-import.ts non-Error catch branches cleanly with scoped spy cleanup
    const spyJson = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'raw-json-err'
    })
    try {
      expect(() =>
        parseImportText('{"a":1}', { format: 'json', delimiter: 'auto', hasHeaderRow: true, trimValues: true })
      ).toThrow(/raw-json-err/)
    } finally {
      spyJson.mockRestore()
    }
    const spyNdjson = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'raw-ndjson-err'
    })
    try {
      expect(() =>
        parseImportText('{"a":1}', { format: 'ndjson', delimiter: 'auto', hasHeaderRow: true, trimValues: true })
      ).toThrow(/raw-ndjson-err/)
    } finally {
      spyNdjson.mockRestore()
    }

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        sql: 'SELECT id, name FROM public.users AS u "JOIN"',
      })
    ).toMatchObject({ editable: false, reason: 'JOIN queries cannot be edited inline' })

    expect(
      analyzeEditableSelectQuery({
        ...baseParams,
        dialect: 'sqlite',
        schemaObjects: [],
        sql: 'SELECT id, name FROM users',
        resolveTableDetails: () => ({ ...usersDetails, schema: '' }),
      })
    ).toMatchObject({ editable: true, schema: undefined })
  })
})
