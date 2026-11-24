// src/shared-sql-safety.js
// Pure lexer-aware Dangerous SQL Analyzer, URI secret masker, and Redis credential command detector
// Shared by Worker/Studio (.ts) and native-ESM Side Panel (.js) modules.

import {
  isIdentContChar,
  isIdentStartChar,
  isPostgresEscapeStringStart,
  matchDollarQuoteTag,
  matchMysqlExecCommentPrefix,
  scanBlockCommentEnd,
  scanLineCommentEnd,
  scanOracleQuoteEnd,
  scanQuotedSegmentEnd,
  splitMssqlBatches,
  splitOracleSlashChunks,
  splitSqlStatements,
  stripCommentsAndLiterals,
  stripLeadingSqlComments,
  supportsDollarQuoting,
  supportsNestedBlockComments,
  usesBackslashAndHash,
} from './shared-sql-core.js'

const SENSITIVE_QUERY_KEY_RE =
  /^(?:(?:.*[-_])?(?:token|pass(?:word|wd|phrase)?|pwd|secret|api[-_]?key|apikey|key|jwt|bearer|credentials?|auth[-_]?token|authtoken|authorization|sig(?:nature)?)|(?:auth|access|refresh|id|api|client|session|private|secret|signing|encryption)[_-]?(?:token|key|secret|pass(?:word|wd|phrase)?|pwd)|.*(?:pass(?:word|wd|phrase)|secret|token|apikey|privatekey))$/i

export function isSensitiveUriParamKey(rawKey) {
  if (typeof rawKey !== 'string') return false
  const trimmed = rawKey.trim()
  if (!trimmed) return false
  if (SENSITIVE_QUERY_KEY_RE.test(trimmed)) return true
  try {
    const decoded = decodeURIComponent(trimmed)
    return SENSITIVE_QUERY_KEY_RE.test(decoded.trim())
  } catch {
    return false
  }
}

const PLACEHOLDER_CREDENTIAL_RE =
  /^\[?(?:YOUR[-_]?DATABASE[-_]?PASSWORD|YOUR[-_]?PASSWORD|PASSWORD|<PASSWORD>|YOUR[-_]?TOKEN|<TOKEN>)\]?$/i

const BIND_PLACEHOLDER_RE = /^(?:\$\d+|\?|:[\w]+|@[\w]+|\{\{?[\w.-]+\}?\})$/

function isRealSecretToken(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return false
  if (PLACEHOLDER_CREDENTIAL_RE.test(trimmed)) return false
  if (BIND_PLACEHOLDER_RE.test(trimmed)) return false
  return true
}

function maskSensitiveKvSegment(segment) {
  return segment
    .split('&')
    .map((pair) => {
      const eqIdx = pair.indexOf('=')
      if (eqIdx <= 0) return pair
      const rawKey = pair.slice(0, eqIdx)
      if (isSensitiveUriParamKey(rawKey)) {
        return `${rawKey}=***`
      }
      return pair
    })
    .join('&')
}

function isSingleAuthorityHost(entry) {
  if (!entry) return false
  if (entry.startsWith('[')) {
    return /^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/.test(entry)
  }
  const colonIdx = entry.indexOf(':')
  const hostOnly = colonIdx >= 0 ? entry.slice(0, colonIdx) : entry
  if (colonIdx >= 0) {
    const portStr = entry.slice(colonIdx + 1)
    if (!/^\d{1,5}$/.test(portStr)) return false
    const port = Number(portStr)
    if (port < 1 || port > 65535) return false
  }
  if (!hostOnly || /^\d+$/.test(hostOnly)) return false
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(
    hostOnly
  )
}

function isQualifiedAuthorityHost(hostPart) {
  return hostPart.split(',').some((entry) => {
    if (entry.startsWith('[')) return true
    const colonIdx = entry.indexOf(':')
    const hostOnly = colonIdx >= 0 ? entry.slice(0, colonIdx) : entry
    if (/^localhost$/i.test(hostOnly)) return true
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostOnly)) return true
    return /\.[A-Za-z][A-Za-z0-9-]*$/.test(hostOnly)
  })
}

function scanHostEndInBody(body, startIdx) {
  let j = startIdx
  while (j < body.length) {
    const ch = body[j]
    if (
      ch === '/' ||
      ch === '\\' ||
      ch === '?' ||
      ch === '#' ||
      ch === '"' ||
      ch === "'" ||
      ch === '`' ||
      ch === '<' ||
      ch === '>' ||
      /\s/.test(ch)
    ) {
      break
    }
    j++
  }
  return j
}

/**
 * Resolves the index of the credential-terminating `@` inside `body` (everything after `schemePrefix`),
 * returning `-1` when `body` starts with an uncredentialed `host:port` origin or has no real userinfo `@`.
 */
export function findCredentialAuthorityAtIndex(schemePrefix, body, colonIdx) {
  if (typeof body !== 'string' || colonIdx < 0 || colonIdx >= body.length || body[colonIdx] !== ':') {
    return -1
  }
  const user = body.slice(0, colonIdx)
  if (/[/?#@\s[\]]/.test(user)) return -1

  const isHttp = /^https?:(?:\\*\/){2}$/i.test(String(schemePrefix || ''))
  const afterColon = body.slice(colonIdx + 1)
  let originIsHostPort = false
  const portMatch = /^(\d{1,5})(?:\\*\/|\?|#|$)/.exec(afterColon)
  if (portMatch) {
    const portNum = Number(portMatch[1])
    if (portNum >= 1 && portNum <= 65535 && isSingleAuthorityHost(`${user}:${portNum}`)) {
      originIsHostPort = true
    }
  }

  const startsWithPortQueryOrHash = /^\d{1,5}[?#]/.test(afterColon)
  const candidates = []
  for (let i = colonIdx + 1; i < body.length; i++) {
    if (body[i] !== '@') continue
    const hostEnd = scanHostEndInBody(body, i + 1)
    const hostPart = body.slice(i + 1, hostEnd)
    const seeds = hostPart.split(',')
    if (!hostPart || !seeds.every(isSingleAuthorityHost)) continue

    const hasPort = seeds.some((s) => /:\d{1,5}$/.test(s))
    const qualified = isQualifiedAuthorityHost(hostPart)
    const tail = body.slice(hostEnd)
    const hasPathAfterHost = /^\\*\//.test(tail)
    const hasQueryAfterHost = /^\?/.test(tail)
    const isPathHandle = i > 0 && body[i - 1] === '/'
    const isEqHandle = i > 0 && body[i - 1] === '='
    const prefixBefore = body.slice(colonIdx + 1, i)
    const afterQueryAssign = /[?&][^?&#=/]+=/.test(prefixBefore)
    const afterFragAssign = /#[^#]*=/.test(prefixBefore)
    const slashThenQueryOrHash = /(?:\/|\\*\/)[^?#]*(?:[?&][^?&#=/]+=|#)/.test(prefixBefore)
    const cleanBefore = !/[/?#]/.test(prefixBefore) && !/\\+\//.test(prefixBefore)

    if (isPathHandle) continue
    if (isEqHandle && (afterQueryAssign || afterFragAssign || originIsHostPort)) continue

    if (originIsHostPort) {
      if (slashThenQueryOrHash && (!hasPort || /:(?:\\*\/){2}/.test(prefixBefore))) continue
      if (isHttp && startsWithPortQueryOrHash) {
        if (!(hasPort || (hasPathAfterHost && !/:(?:\\*\/){2}/.test(prefixBefore)))) continue
      } else if (!isHttp) {
        if (
          !hasPort &&
          !hasPathAfterHost &&
          !hasQueryAfterHost &&
          (afterQueryAssign || afterFragAssign)
        ) {
          continue
        }
      }
    }

    candidates.push({
      atIdx: i,
      hostEnd,
      hasPort,
      qualified,
      hasPathAfterHost,
      cleanBefore,
      afterQueryAssign,
      afterFragAssign,
    })
  }

  if (candidates.length === 0) return -1

  const beforePriorSuffixDelim = candidates.filter(
    (c, _, arr) =>
      !arr.some(
        (earlier) =>
          earlier.hostEnd < c.atIdx && /[?#]/.test(body.slice(earlier.hostEnd, c.atIdx))
      )
  )
  const cleanPool = beforePriorSuffixDelim.filter((c) => c.cleanBefore)
  if (cleanPool.length > 0) {
    return (cleanPool.find((c) => c.qualified || c.hasPort) ?? cleanPool[0]).atIdx
  }

  const nonAssign = beforePriorSuffixDelim.filter((c) => !c.afterQueryAssign && !c.afterFragAssign)
  const noFrag = beforePriorSuffixDelim.filter((c) => !c.afterFragAssign)
  const pool =
    nonAssign.length > 0 ? nonAssign : noFrag.length > 0 ? noFrag : beforePriorSuffixDelim
  return (pool.find((c) => c.qualified || c.hasPort) ?? pool[0]).atIdx
}

function maskAuthorityUserinfo(out, schemeLen) {
  const schemePrefix = out.slice(0, schemeLen)
  const rest = out.slice(schemeLen)
  const delimIdx = rest.search(/[:/?#@[\]]/)
  if (delimIdx < 0 || rest[delimIdx] !== ':') return out

  const atIdx = findCredentialAuthorityAtIndex(schemePrefix, rest, delimIdx)
  if (atIdx <= 0) return out

  return `${schemePrefix}${rest.slice(0, delimIdx + 1)}***${rest.slice(atIdx)}`
}

/**
 * Masks embedded userinfo password (handling `/`, `#`, `?`, `@` inside passwords before `@host`)
 * and masks sensitive query & fragment parameter values (`password`, `pwd`, `pass`, `token`, `authToken`,
 * `auth_token`, `jwt`, `api_key`, `apikey`, `key`, `access_token`, `bearer`, etc.) with `***`.
 */
export function maskConnectionUriSecret(rawUri) {
  const raw = String(rawUri || '')
  if (!raw) return ''

  let out = raw
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/.exec(out)
  if (schemeMatch) {
    out = maskAuthorityUserinfo(out, schemeMatch[1].length)
  }

  const hashIdx = out.indexOf('#')
  const qIdx = out.indexOf('?')
  if (qIdx >= 0 && (hashIdx < 0 || qIdx < hashIdx)) {
    const queryEnd = hashIdx >= 0 ? hashIdx : out.length
    const queryStr = out.slice(qIdx + 1, queryEnd)
    const maskedQuery = maskSensitiveKvSegment(queryStr)
    out = `${out.slice(0, qIdx + 1)}${maskedQuery}${out.slice(queryEnd)}`
  }

  const finalHashIdx = out.indexOf('#')
  if (finalHashIdx >= 0 && finalHashIdx + 1 < out.length) {
    const fragStr = out.slice(finalHashIdx + 1)
    const fragQIdx = fragStr.indexOf('?')
    const maskedFrag =
      fragQIdx >= 0
        ? `${maskSensitiveKvSegment(fragStr.slice(0, fragQIdx))}?${maskSensitiveKvSegment(fragStr.slice(fragQIdx + 1))}`
        : fragStr.includes('=')
          ? maskSensitiveKvSegment(fragStr)
          : fragStr === '[REDACTED]'
            ? fragStr
            : '***'
    out = `${out.slice(0, finalHashIdx + 1)}${maskedFrag}`
  }

  return out
}

const URI_SCHEME_GLOBAL_RE = /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]{0,31}:(?:\\*\/){2})/g
const SENSITIVE_TEXT_KV_PARAM_PREFIX_RE = /([?&#])([^=&\s#;"'{}\\]+)=/g
const SCRUB_URI_FRAGMENT_RE =
  /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]{0,31}:(?:\\*\/){2}(?:\\+\/|[^\\\s#'"`<>}])+)#((?:\\+\/|[^\\\s'"`<>}])*)/g
const ADO_KV_SECRET_PREFIX_RE =
  /(^|[;\s,"'{(\[]|\\["'nrt])(pass(?:word|wd|phrase)?|pwd|sslpassword|tlsCertificateKeyFilePassword|auth[-_]?token|authtoken|jwt|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|private[-_]?key|api[-_]?key|apikey|token|bearer|credentials?|authorization|sig(?:nature)?)\s*=\s*/gi

function isSecretValueTerminator(ch, mode) {
  if (!ch) return true
  if (mode === 'query') return /[\s&#;"'`}\]),<>\\]/.test(ch)
  if (mode === 'ado') return /[;\r\n&\s"'`}\]),<>\\]/.test(ch)
  return /[\s'"`,;)}\]\\]/.test(ch)
}

function scanQuotedLiteralEnd(input, startIdx, quote) {
  let i = startIdx + 1
  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      i += 2
      continue
    }
    if (input[i] === quote) {
      return i + 1
    }
    i++
  }
  return -1
}

function scanEscapedDoubleQuoteEnd(input, startIdx, bsCount) {
  let i = startIdx + bsCount + 1
  while (i < input.length) {
    const ch = input[i]
    if (ch === '\r' || ch === '\n' || ch === '"') break
    if (ch === '\\') {
      let run = 0
      while (i + run < input.length && input[i + run] === '\\') run++
      if (input[i + run] === '"') {
        if (run === bsCount) {
          return i + run + 1
        }
        // Even backslashes immediately before `"` mark an unescaped JSON closing quote: stop before `"`
        if (run % 2 === 0) {
          return i + run
        }
        i += run + 1
        continue
      }
      i += run
      continue
    }
    i++
  }
  return i
}

function isRedactedSentinelBoundary(input, afterIdx, mode) {
  const ch = input[afterIdx]
  if (isSecretValueTerminator(ch, mode)) return true
  if (ch === ':') {
    const next = input[afterIdx + 1]
    return !next || /[\s&#;"'`}\]),<>\\]/.test(next)
  }
  return false
}

/**
 * Linear-time value span scanner for query, ADO.NET, and Mongo credential attributes.
 * Preserves already-redacted `[REDACTED]` (and `***` in `'mongo'` mode) sentinels idempotently,
 * handles arbitrary odd backslash-escaped quotes (`\"`, `\\\"`, `\\\\\"`, `\\\\\\\\\\\\\"`, ...)
 * in nested JSON/ClickHouse exceptions, and stops before unescaped JSON string boundaries.
 */
export function scanSecretValueSpan(input, startIdx, mode = 'ado') {
  if (typeof input !== 'string' || startIdx < 0 || startIdx > input.length) {
    return { skip: true, end: startIdx }
  }
  if (
    input.startsWith('[REDACTED]', startIdx) &&
    isRedactedSentinelBoundary(input, startIdx + 10, mode)
  ) {
    return { skip: true, end: startIdx + 10 }
  }
  if (
    mode === 'mongo' &&
    input.startsWith('***', startIdx) &&
    isRedactedSentinelBoundary(input, startIdx + 3, mode)
  ) {
    return { skip: true, end: startIdx + 3 }
  }

  const first = input[startIdx]
  if (first === '{') {
    let i = startIdx + 1
    while (i < input.length) {
      if (input[i] === '}') {
        if (input[i + 1] === '}') {
          i += 2
          continue
        }
        return { skip: false, end: i + 1 }
      }
      i++
    }
  }

  if (first === '"' || first === "'") {
    const quotedEnd = scanQuotedLiteralEnd(input, startIdx, first)
    if (quotedEnd > startIdx) {
      return { skip: false, end: quotedEnd }
    }
  }

  if (first === '\\') {
    let bsCount = 0
    while (startIdx + bsCount < input.length && input[startIdx + bsCount] === '\\') bsCount++
    if (bsCount > 0 && input[startIdx + bsCount] === '"') {
      // Even backslashes before `"` mean the `"` is an unescaped outer delimiter (e.g. `"Pwd=\\"` in JSON)
      if (bsCount % 2 === 0) {
        return { skip: false, end: startIdx + bsCount }
      }
      return { skip: false, end: scanEscapedDoubleQuoteEnd(input, startIdx, bsCount) }
    }
  }

  let i = startIdx
  if (mode === 'query') {
    const bearerMatch = /^(?:Bearer|Basic)[ \t]+/i.exec(input.slice(startIdx))
    if (bearerMatch) {
      i += bearerMatch[0].length
    }
  }

  while (i < input.length) {
    if (input.startsWith('[REDACTED]', i) && !isRedactedSentinelBoundary(input, i + 10, mode)) {
      i += 10
      continue
    }
    if (input[i] === '\\') {
      const slashMatch = /^\\+\//.exec(input.slice(i))
      if (slashMatch) {
        i += slashMatch[0].length
        continue
      }
      break
    }
    if (isSecretValueTerminator(input[i], mode)) break
    i++
  }

  if (mode !== 'query' && i === startIdx) {
    return { skip: true, end: startIdx }
  }
  return { skip: false, end: i }
}

function replaceKvSecretsWithScanner(text, prefixRe, mode, replacement, shouldHandleMatch) {
  prefixRe.lastIndex = 0
  let out = ''
  let cursor = 0
  let match
  while ((match = prefixRe.exec(text)) !== null) {
    if (shouldHandleMatch && !shouldHandleMatch(match)) continue
    const valStart = match.index + match[0].length
    const span = scanSecretValueSpan(text, valStart, mode)
    if (span.skip) {
      if (span.end > prefixRe.lastIndex) prefixRe.lastIndex = span.end
      continue
    }
    out += text.slice(cursor, valStart) + replacement
    cursor = span.end
    if (span.end > prefixRe.lastIndex) prefixRe.lastIndex = span.end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

function isUriSchemeBoundaryValid(text, matchIndex) {
  return matchIndex === 0 || !/[a-zA-Z0-9+.-]/.test(text[matchIndex - 1])
}

function scanUriBodyEnd(input, startIdx) {
  let i = startIdx
  while (i < input.length && !/[\s'"`<>]/.test(input[i])) {
    if (
      input[i] === '\\' &&
      i + 1 < input.length &&
      (input[i + 1] === '"' || input[i + 1] === "'")
    ) {
      break
    }
    i++
  }
  return i
}

function isSensitiveParamKey(rawKey) {
  return isSensitiveUriParamKey(rawKey)
}

/**
 * Strips passwords from embedded `scheme://user:pass@host` (including arbitrary backslash-escaped
 * slashes like `:\\/\\/` and `:\\\\/\\\\/`) without touching path `/@handle` or query `@`.
 */
function redactUriCredentials(input) {
  URI_SCHEME_GLOBAL_RE.lastIndex = 0
  let out = ''
  let cursor = 0
  let match
  while ((match = URI_SCHEME_GLOBAL_RE.exec(input)) !== null) {
    const matchStart = match.index
    if (!isUriSchemeBoundaryValid(input, matchStart)) continue

    const bodyStart = matchStart + match[0].length

    const restEnd = scanUriBodyEnd(input, bodyStart)
    const body = input.slice(bodyStart, restEnd)
    const colonIdx = body.search(/[:/?#@[\]\\]/)
    if (colonIdx < 0 || body[colonIdx] !== ':') continue

    const atIdx = findCredentialAuthorityAtIndex(match[1], body, colonIdx)
    if (atIdx <= colonIdx) continue

    out += input.slice(cursor, bodyStart) + body.slice(0, colonIdx) + '@'
    cursor = bodyStart + atIdx + 1
    URI_SCHEME_GLOBAL_RE.lastIndex = cursor
  }
  return out + input.slice(cursor)
}

/**
 * Unified credential/secret text scrubber shared across Worker, Drivers, Panel, and Editor storage.
 * Strips URI passwords (`user@host`), redacts sensitive query/fragment parameters (`[REDACTED]`),
 * optionally strips/redacts URL fragments, and redacts Bearer/Basic headers and ADO.NET/KV secrets.
 */
export function scrubSensitiveText(input, options = {}) {
  if (typeof input !== 'string' || !input) return ''

  let out = redactUriCredentials(input)

  out = replaceKvSecretsWithScanner(
    out,
    SENSITIVE_TEXT_KV_PARAM_PREFIX_RE,
    'query',
    '[REDACTED]',
    (match) => isSensitiveParamKey(match[2])
  )

  if (options && options.stripAllFragments) {
    out = out.replace(SCRUB_URI_FRAGMENT_RE, (full, prefix, _frag, offset, source) =>
      isUriSchemeBoundaryValid(source, offset) ? prefix : full
    )
  } else if (options && options.stripOpaqueFragment) {
    out = out.replace(SCRUB_URI_FRAGMENT_RE, (full, prefix, frag, offset, source) => {
      if (!isUriSchemeBoundaryValid(source, offset)) return full
      if (/^\[REDACTED\][)\],;]*$/.test(frag)) return full
      const trailMatch = /([)\],;]+)$/.exec(frag)
      const trailing = trailMatch ? trailMatch[1] : ''
      const coreFrag = trailing ? frag.slice(0, frag.length - trailing.length) : frag
      if (!coreFrag || coreFrag.includes('=')) return full
      return `${prefix}#[REDACTED]${trailing}`
    })
  }

  out = out
    .replace(
      /\b(Authorization\s*[:=]\s*(?:Bearer|Basic))[ \t]+(?!\[REDACTED\](?:$|[\s,;'"`}\])<>\\]))(?:\\+\/|[^\s,;'"`}\])<>\\])+/gi,
      '$1 [REDACTED]'
    )
    .replace(
      /\b(Bearer)[ \t]+(?!(?:token|auth|header|scheme|flow|missing|required|invalid|expired|type|based|only|mode)\b)((?:\\*\/|[A-Za-z0-9\-._~+]){4,}=*)(?=$|[\s,;'"`}\])<>]|\\["'nrt])/gi,
      '$1 [REDACTED]'
    )
    .replace(
      /\b(Basic)[ \t]+((?:(?:\\*\/|[A-Za-z0-9+]){4,}={1,2}|(?=(?:\\*\/|[A-Za-z0-9+])*[0-9+/A-Z])(?:\\*\/|[A-Za-z0-9+]){4,}))(?=$|[\s,;'"`}\])<>]|\\["'nrt])/g,
      '$1 [REDACTED]'
    )

  out = replaceKvSecretsWithScanner(out, ADO_KV_SECRET_PREFIX_RE, 'ado', '[REDACTED]')

  return out
}

/**
 * Quote- and escape-aware tokenizer for a single Redis CLI command line.
 * Supports single/double quotes, `\n`, `\r`, `\t`, `\xHH`, `\"`, `\'`, `\\`,
 * and leading comment lines (`#`, `--`, `//`).
 */
export function tokenizeRedisCommandLine(line, options = {}) {
  const strict = Boolean(options && options.strict)
  const str = String(line || '')
  const args = []
  let token = ''
  let inToken = false
  let quoteChar = null
  const len = str.length
  let i = 0

  while (i < len) {
    const ch = str[i]
    if (quoteChar !== null) {
      if (ch === '\\' && i + 1 < len) {
        const next = str[i + 1]
        if (next === 'n') token += '\n'
        else if (next === 'r') token += '\r'
        else if (next === 't') token += '\t'
        else if (next === 'x' && i + 3 < len && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 2, i + 4))) {
          token += String.fromCharCode(parseInt(str.slice(i + 2, i + 4), 16))
          i += 2
        } else {
          token += next
        }
        i += 2
        continue
      }
      if (ch === quoteChar) {
        quoteChar = null
        i++
        continue
      }
      token += ch
      i++
      continue
    }

    if (!inToken && args.length === 0) {
      if (
        ch === '#' ||
        (ch === '-' && str[i + 1] === '-') ||
        (ch === '/' && str[i + 1] === '/')
      ) {
        break
      }
    }

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (inToken) {
        args.push(token)
        token = ''
        inToken = false
      }
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quoteChar = ch
      inToken = true
      i++
      continue
    }

    token += ch
    inToken = true
    i++
  }

  if (strict && quoteChar !== null) {
    throw new Error(`Unterminated ${quoteChar} quote in Redis command`)
  }
  if (inToken) {
    args.push(token)
  }
  return args
}

/**
 * Line-by-line, case-insensitive detector for Redis commands carrying credentials:
 * - `AUTH <password>` / `AUTH <username> <password>`
 * - `HELLO ... AUTH <username> <password>`
 * - `ACL SETUSER <username> ... ><password>` / `<<password>` / `#<hash>` / `!<hash>`
 * - `CONFIG SET requirepass <password>` / `CONFIG SET masterauth <password>`
 * - `MIGRATE ... AUTH <password>` / `MIGRATE ... AUTH2 <username> <password>`
 */
export function detectRedisCredentialCommand(script) {
  if (typeof script !== 'string' || !script.trim()) return false
  for (const rawLine of script.split(/\r?\n/)) {
    const args = tokenizeRedisCommandLine(rawLine)
    if (args.length < 2) continue
    const cmd = args[0].toUpperCase()

    if (cmd === 'AUTH') {
      if (args.slice(1).some((arg) => isRealSecretToken(arg))) return true
      continue
    }

    if (cmd === 'HELLO') {
      for (let i = 1; i < args.length; i++) {
        if (args[i].toUpperCase() === 'AUTH') {
          const slot1 = args[i + 1]
          const slot2 = args[i + 2]
          if (
            (slot2 !== undefined && isRealSecretToken(slot2)) ||
            (slot1 !== undefined &&
              slot1.toLowerCase() !== 'default' &&
              (slot2 === undefined || !isRealSecretToken(slot2)) &&
              isRealSecretToken(slot1))
          ) {
            return true
          }
        }
      }
      continue
    }

    if (cmd === 'ACL' && args[1].toUpperCase() === 'SETUSER') {
      for (let i = 3; i < args.length; i++) {
        const rule = args[i]
        if (
          (rule.startsWith('>') ||
            rule.startsWith('#') ||
            rule.startsWith('<') ||
            rule.startsWith('!')) &&
          isRealSecretToken(rule.slice(1))
        ) {
          return true
        }
      }
      continue
    }

    if (cmd === 'CONFIG' && args[1].toUpperCase() === 'SET') {
      for (let i = 2; i + 1 < args.length; i += 2) {
        const param = args[i].toLowerCase()
        if ((param === 'requirepass' || param === 'masterauth') && isRealSecretToken(args[i + 1])) {
          return true
        }
      }
      continue
    }

    if (cmd === 'MIGRATE') {
      for (let i = 1; i < args.length; i++) {
        const opt = args[i].toUpperCase()
        if (opt === 'KEYS') break
        if (opt === 'AUTH' && i + 1 < args.length) {
          if (isRealSecretToken(args[i + 1])) return true
          i += 1
        } else if (opt === 'AUTH2' && i + 2 < args.length) {
          if (isRealSecretToken(args[i + 2])) return true
          i += 2
        }
      }
    }
  }
  return false
}

const SQL_ACCOUNT_AUTH_LITERAL_RE =
  /\b(?:identified\s+by\s+(?:['"][^'"]+['"]|[^\s;,()]+)|set\s+password(?:\s+for\s+[^\s=]+)?\s*=\s*(?:['"][^'"]+['"]|password\s*\()|alter\s+(?:user|role|login)\b[^;]*\b(?:password|identified\s+by)\b|create\s+(?:user|role|login)\b[^;]*\b(?:password|identified\s+by)\b|(?:password|passwd|pwd|secret|client_?secret|access_?token|refresh_?token|auth_?token|api_?key|token)\s*=\s*['"][^'"]+['"]|auth\s+['"][^'"]+['"])/i

export function containsSensitiveSqlText(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false
  if (detectRedisCredentialCommand(raw)) return true
  if (SQL_ACCOUNT_AUTH_LITERAL_RE.test(raw)) return true
  return scrubSensitiveText(raw, { stripOpaqueFragment: true }) !== raw
}

export function scrubSqlPreviewForStorage(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  if (detectRedisCredentialCommand(raw) || SQL_ACCOUNT_AUTH_LITERAL_RE.test(raw)) {
    return '[REDACTED]'
  }
  return scrubSensitiveText(raw, { stripOpaqueFragment: true })
}

function sanitizeSqlResultNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const copy = { ...node }
  if (typeof copy.sqlPreview === 'string') {
    copy.sqlPreview = scrubSqlPreviewForStorage(copy.sqlPreview)
  }
  if (typeof copy.sql === 'string') {
    copy.sql = containsSensitiveSqlText(copy.sql)
      ? ''
      : scrubSensitiveText(copy.sql, { stripOpaqueFragment: true })
  }
  if (typeof copy.error === 'string') {
    copy.error = scrubSensitiveText(copy.error, { stripOpaqueFragment: true })
  }
  if (typeof copy.errorMessage === 'string') {
    copy.errorMessage = scrubSensitiveText(copy.errorMessage, { stripOpaqueFragment: true })
  }
  return copy
}

export function sanitizeSqlResultForStorage(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const copy = sanitizeSqlResultNode(result)
  if (Array.isArray(copy.resultSets)) {
    copy.resultSets = copy.resultSets.map((rs) => sanitizeSqlResultNode(rs))
  }
  return copy
}

export function scrubConnectionNameForStorage(raw) {
  if (typeof raw !== 'string') return ''
  let out = scrubSensitiveText(raw, { stripOpaqueFragment: true })
  out = out.replace(
    /(^|[\s(\["'`])([^\s:/?#@"'`]*):([^\s/?#@"'`]+)@([A-Za-z0-9_.-]+|\[[0-9a-fA-F:]+\])/g,
    (full, lead, user, _pass, host) => {
      if (user.toLowerCase() === 'mailto') return full
      return user ? `${lead}${user}@${host}` : `${lead}@${host}`
    }
  )
  return out
}

function parseExplainAnalyzeAndMutating(rawText, dialect) {
  const clean = stripCommentsAndLiterals(rawText, dialect, true).replace(/^[\s(]+/, '').trim()
  let rest = clean.replace(/^EXPLAIN\b/i, '').trimStart()
  let hasAnalyze = false
  let hasWriteOption = false

  while (rest.length > 0) {
    if (rest.startsWith('(')) {
      let depth = 0
      let closeIdx = -1
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '(') depth++
        else if (rest[i] === ')') {
          depth--
          if (depth === 0) {
            closeIdx = i
            break
          }
        }
      }
      if (closeIdx < 0) {
        hasWriteOption = true
        break
      }
      const groupContent = rest.slice(1, closeIdx)
      const analyzeMatch = /\bANALY[ZS]E\b(?:\s+(FALSE|OFF|0)\b)?/i.exec(groupContent)
      if (analyzeMatch && !analyzeMatch[1]) {
        hasAnalyze = true
      }
      if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(groupContent)) {
        hasWriteOption = true
      }
      rest = rest.slice(closeIdx + 1).trimStart()
      continue
    }

    const analyzeOpt = /^ANALY[ZS]E\b/i.exec(rest)
    if (analyzeOpt) {
      hasAnalyze = true
      rest = rest.slice(analyzeOpt[0].length).trimStart()
      continue
    }

    const stdOpt =
      /^(?:VERBOSE|QUERY\s+PLAN|EXTENDED|PARTITIONS|DISTSQL|OPT|TYPES|VEC|AST|SYNTAX|PLAN|PIPELINE|ESTIMATE|TABLE\s+OVERRIDE|CURRENT\s+TRANSACTION|FOR\s+CONNECTION\s+\d+|FORMAT\s*=\s*[A-Za-z0-9_]+|FORMAT\s+[A-Za-z0-9_]+)\b/i.exec(
        rest
      )
    if (stdOpt) {
      rest = rest.slice(stdOpt[0].length).trimStart()
      continue
    }

    const chSettingOpt = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*[A-Za-z0-9_]+\s*,?/i.exec(rest)
    if (chSettingOpt) {
      rest = rest.slice(chSettingOpt[0].length).trimStart()
      continue
    }
    break
  }

  const targetClean = rest.replace(/^[\s(]+/, '').trim()
  const verbMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(targetClean)
  const verb = verbMatch ? verbMatch[1].toUpperCase() : ''
  const isMutating =
    hasWriteOption ||
    verb === 'DELETE' ||
    verb === 'UPDATE' ||
    verb === 'DROP' ||
    verb === 'TRUNCATE' ||
    verb === 'INSERT' ||
    verb === 'REPLACE' ||
    verb === 'MERGE' ||
    verb === 'ALTER' ||
    verb === 'CREATE' ||
    verb === 'WITH'

  return { hasAnalyze, isMutating }
}

function tokenizeStatementForSafety(sql, dialect) {
  const tokens = []
  const len = sql.length
  const backslashAndHash = usesBackslashAndHash(dialect)
  const nestedComments = supportsNestedBlockComments(dialect)
  const dollarQuotes = supportsDollarQuoting(dialect)
  const bracketIdents =
    dialect === 'sqlite' || dialect === 'libsql' || dialect === 'd1' || dialect === 'mssql'
  let depth = 0
  let execCommentDepth = 0
  let i = 0

  while (i < len) {
    const ch = sql[i]

    if (ch === '-' && i + 1 < len && sql[i + 1] === '-') {
      i = scanLineCommentEnd(sql, i)
      continue
    }

    if (ch === '#' && backslashAndHash) {
      i = scanLineCommentEnd(sql, i - 1)
      continue
    }

    if (execCommentDepth > 0 && ch === '*' && i + 1 < len && sql[i + 1] === '/') {
      execCommentDepth--
      i += 2
      continue
    }

    if (ch === '/' && i + 1 < len && sql[i + 1] === '*') {
      const execLen = matchMysqlExecCommentPrefix(sql, i, dialect)
      if (execLen > 0) {
        execCommentDepth++
        i += execLen
        continue
      }
      i = scanBlockCommentEnd(sql, i, nestedComments)
      continue
    }

    if (isPostgresEscapeStringStart(sql, i, dialect)) {
      i = scanQuotedSegmentEnd(sql, i + 1, "'", true).end
      continue
    }

    const oracleQuote = scanOracleQuoteEnd(sql, i, dialect)
    if (oracleQuote) {
      i = oracleQuote.end
      continue
    }

    if (ch === "'") {
      i = scanQuotedSegmentEnd(sql, i, "'", backslashAndHash).end
      continue
    }

    if (dollarQuotes && ch === '$') {
      const tag = matchDollarQuoteTag(sql, i)
      if (tag !== null) {
        const closeIdx = sql.indexOf(tag, i + tag.length)
        i = closeIdx >= 0 ? closeIdx + tag.length : len
        continue
      }
    }

    if (ch === '"' || ch === '`') {
      const seg = scanQuotedSegmentEnd(sql, i, ch, false)
      const raw = sql.slice(i + 1, seg.closed ? seg.end - 1 : seg.end)
      const unescaped = ch === '`' ? raw.replace(/``/g, '`') : raw.replace(/""/g, '"')
      tokens.push({ text: unescaped, depth, kind: 'quoted' })
      i = seg.end
      continue
    }
    if (bracketIdents && ch === '[') {
      let j = i + 1
      while (j < len) {
        if (sql[j] === ']') {
          if (j + 1 < len && sql[j + 1] === ']') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      const raw = sql.slice(i + 1, j)
      const unescaped = raw.replace(/]]/g, ']')
      tokens.push({ text: unescaped, depth, kind: 'quoted' })
      i = j < len ? j + 1 : len
      continue
    }

    if (ch === '(') {
      tokens.push({ text: ch, depth, kind: 'punct' })
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      tokens.push({ text: ch, depth, kind: 'punct' })
      i++
      continue
    }

    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '.' && i + 1 < len && sql[i + 1] >= '0' && sql[i + 1] <= '9')
    ) {
      let j = i
      if (ch === '.') {
        j++
        while (j < len && sql[j] >= '0' && sql[j] <= '9') j++
      } else {
        while (j < len && sql[j] >= '0' && sql[j] <= '9') j++
        if (j < len && sql[j] === '.') {
          j++
          while (j < len && sql[j] >= '0' && sql[j] <= '9') j++
        }
      }
      tokens.push({ text: sql.slice(i, j), depth, kind: 'number' })
      i = j
      continue
    }

    if (ch === '.') {
      tokens.push({ text: '.', depth, kind: 'punct' })
      i++
      continue
    }

    if (isIdentStartChar(sql.charCodeAt(i))) {
      let j = i + 1
      while (j < len && isIdentContChar(sql.charCodeAt(j))) {
        j++
      }
      tokens.push({ text: sql.slice(i, j), depth, kind: 'word' })
      i = j
      continue
    }

    i++
  }

  return tokens
}

const DROP_TARGET_MODIFIERS = new Set([
  'TEMPORARY',
  'IF',
  'EXISTS',
  'TABLE',
  'VIEW',
  'MATERIALIZED',
  'DATABASE',
  'SCHEMA',
  'FUNCTION',
  'PROCEDURE',
  'PROC',
  'TRIGGER',
  'SEQUENCE',
  'TYPE',
  'INDEX',
])

const CTE_MAIN_DML_KEYWORDS = new Set(['DELETE', 'UPDATE', 'DROP', 'TRUNCATE'])
const NO_MODIFIERS = new Set()
const TRUNCATE_TARGET_MODIFIERS = new Set(['TABLE'])

function findTargetAtDepth(tokens, startIdx, targetDepth, modifiers) {
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.depth < targetDepth) break
    if (token.depth !== targetDepth || token.kind === 'punct') continue
    const upper = token.text.toUpperCase()
    if (token.kind === 'word' && modifiers.has(upper)) continue
    return token.text
  }
  return undefined
}

function unwrapExplainAnalyzeOffset(tokens, rawText, dialect) {
  const firstWord = tokens[0]?.kind === 'word' ? tokens[0].text.toUpperCase() : ''
  if (firstWord === 'ANALYZE' && dialect === 'mariadb' && tokens.length > 1) {
    const nextUpper = tokens[1].kind === 'word' ? tokens[1].text.toUpperCase() : ''
    if (
      nextUpper === 'DELETE' ||
      nextUpper === 'UPDATE' ||
      nextUpper === 'DROP' ||
      nextUpper === 'TRUNCATE' ||
      nextUpper === 'WITH'
    ) {
      return 1
    }
  }
  if (firstWord === 'EXPLAIN') {
    const { hasAnalyze, isMutating } = parseExplainAnalyzeAndMutating(rawText, dialect)
    if (hasAnalyze && isMutating) {
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i].depth !== 0 || tokens[i].kind !== 'word') continue
        const u = tokens[i].text.toUpperCase()
        if (u === 'WITH' || CTE_MAIN_DML_KEYWORDS.has(u)) {
          return i
        }
      }
    }
  }
  return 0
}

const SCOPE_WHERE_STOP_KEYWORDS = new Set([
  'SELECT',
  'DELETE',
  'UPDATE',
  'DROP',
  'TRUNCATE',
  'INSERT',
  'MERGE',
  'CREATE',
  'ALTER',
  'EXEC',
  'EXECUTE',
  'IF',
  'WHILE',
  'DECLARE',
])

const MSSQL_DML_EVENT_PREDECESSORS = new Set(['ON', 'AFTER', 'FOR', 'OF'])
const MSSQL_STANDALONE_DROP_OBJECTS = new Set([
  'TABLE',
  'DATABASE',
  'SCHEMA',
  'VIEW',
  'PROCEDURE',
  'PROC',
  'FUNCTION',
  'TRIGGER',
  'INDEX',
])

function isMssqlStandaloneDropIndex(tokens, dropIdx) {
  let j = dropIdx + 2
  if (
    tokens[j]?.depth === 0 &&
    tokens[j].kind === 'word' &&
    tokens[j].text.toUpperCase() === 'IF' &&
    tokens[j + 1]?.depth === 0 &&
    tokens[j + 1].kind === 'word' &&
    tokens[j + 1].text.toUpperCase() === 'EXISTS'
  ) {
    j += 2
  }
  if (!tokens[j] || tokens[j].depth !== 0 || tokens[j].kind === 'punct') {
    return false
  }
  let hasDotQualifier = false
  j++
  while (
    tokens[j]?.depth === 0 &&
    tokens[j].kind === 'punct' &&
    tokens[j].text === '.' &&
    tokens[j + 1]?.depth === 0 &&
    tokens[j + 1].kind !== 'punct'
  ) {
    hasDotQualifier = true
    j += 2
  }
  if (hasDotQualifier) {
    return true
  }
  return (
    tokens[j]?.depth === 0 &&
    tokens[j].kind === 'word' &&
    tokens[j].text.toUpperCase() === 'ON'
  )
}

const ORACLE_PLSQL_CHUNK_RE =
  /^(?:DECLARE\b|BEGIN\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE(?:\s+BODY)?|TYPE(?:\s+BODY)?)\b)/i

function isPrecededByDot(tokens, idx) {
  return idx > 0 && tokens[idx - 1].kind === 'punct' && tokens[idx - 1].text === '.'
}

function inspectScopeForDangerousDml(tokens, startIdx, scopeDepth, stmtIdx, preview, findings) {
  const mainToken = tokens[startIdx]
  if (!mainToken || mainToken.kind !== 'word') return
  const mainWord = mainToken.text.toUpperCase()

  let hasWhereAtScope = false
  let caseDepth = 0
  for (let i = startIdx + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.depth < scopeDepth) break
    if (t.depth !== scopeDepth || t.kind !== 'word') continue
    if (isPrecededByDot(tokens, i)) continue
    const u = t.text.toUpperCase()
    if (u === 'CASE') {
      caseDepth++
      continue
    }
    if (u === 'END') {
      if (caseDepth > 0) {
        caseDepth--
        continue
      }
      break
    }
    if (u === 'ELSE') {
      if (caseDepth === 0) break
      continue
    }
    if (u === 'WHERE' && caseDepth === 0) {
      hasWhereAtScope = true
      break
    }
    if (caseDepth === 0 && SCOPE_WHERE_STOP_KEYWORDS.has(u)) {
      break
    }
  }

  if (mainWord === 'DELETE') {
    if (!hasWhereAtScope) {
      let target
      for (let i = startIdx + 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (t.depth < scopeDepth) break
        if (t.depth !== scopeDepth || t.kind !== 'word') continue
        if (isPrecededByDot(tokens, i)) continue
        const u = t.text.toUpperCase()
        if (SCOPE_WHERE_STOP_KEYWORDS.has(u) || u === 'END' || u === 'ELSE') break
        if (u === 'FROM') {
          if (
            i + 1 < tokens.length &&
            tokens[i + 1].depth === scopeDepth &&
            tokens[i + 1].kind !== 'punct'
          ) {
            target = tokens[i + 1].text
          }
          break
        }
      }
      if (!target) {
        target = findTargetAtDepth(tokens, startIdx, scopeDepth, NO_MODIFIERS)
      }
      findings.push({
        kind: 'delete_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target,
        message: `DELETE statement ${target ? `on "${target}" ` : ''}has no WHERE clause and will delete all rows`,
      })
    }
    return
  }

  if (mainWord === 'UPDATE') {
    if (!hasWhereAtScope) {
      const target = findTargetAtDepth(tokens, startIdx, scopeDepth, NO_MODIFIERS)
      findings.push({
        kind: 'update_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target,
        message: `UPDATE statement ${target ? `on "${target}" ` : ''}has no WHERE clause and will update all rows`,
      })
    }
    return
  }

  if (mainWord === 'DROP') {
    const target = findTargetAtDepth(tokens, startIdx, scopeDepth, DROP_TARGET_MODIFIERS)
    findings.push({
      kind: 'drop',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target,
      message: `DROP statement will permanently remove "${target || 'object'}"`,
    })
    return
  }

  if (mainWord === 'TRUNCATE') {
    const target = findTargetAtDepth(tokens, startIdx, scopeDepth, TRUNCATE_TARGET_MODIFIERS)
    findings.push({
      kind: 'truncate',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target,
      message: `TRUNCATE statement will remove all rows from "${target || 'table'}"`,
    })
  }
}

function isRedisDangerousCommand(sql) {
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue
    const match = /^["']?([A-Za-z_][A-Za-z0-9_-]*)["']?/.exec(trimmed)
    if (!match) continue
    const cmd = match[1].toUpperCase()
    if (cmd === 'FLUSHALL' || cmd === 'FLUSHDB') {
      return true
    }
  }
  return false
}

function scanJsStringTokenEnd(src, start, quoteChar) {
  let i = start + 1
  const len = src.length
  while (i < len) {
    const ch = src[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quoteChar) {
      return i + 1
    }
    i++
  }
  return len
}

function tokenizeMongoScript(script) {
  const tokens = []
  let i = 0
  const len = script.length
  while (i < len) {
    const ch = script[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && script[i + 1] === '/') {
      const nl = script.indexOf('\n', i + 2)
      i = nl < 0 ? len : nl + 1
      continue
    }
    if (ch === '-' && script[i + 1] === '-') {
      const nl = script.indexOf('\n', i + 2)
      i = nl < 0 ? len : nl + 1
      continue
    }
    if (ch === '/' && script[i + 1] === '*') {
      const close = script.indexOf('*/', i + 2)
      i = close < 0 ? len : close + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = scanJsStringTokenEnd(script, i, ch)
      const inner = end > i + 1 && script[end - 1] === ch ? script.slice(i + 1, end - 1) : script.slice(i + 1, end)
      tokens.push({ kind: 'string', text: script.slice(i, end), value: inner, start: i, end })
      i = end
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1
      while (j < len && /[A-Za-z0-9_$]/.test(script[j])) j++
      tokens.push({ kind: 'ident', text: script.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < len && /[0-9.]/.test(script[j])) j++
      tokens.push({ kind: 'number', text: script.slice(i, j), start: i, end: j })
      i = j
      continue
    }
    tokens.push({ kind: 'punct', text: ch, start: i, end: i + 1 })
    i++
  }
  return tokens
}

function splitMongoTokensIntoStatements(tokens, source) {
  const groups = []
  let cur = []
  let brace = 0
  let paren = 0
  let bracket = 0
  for (const tok of tokens) {
    if (tok.kind === 'punct') {
      if (tok.text === '{') brace++
      else if (tok.text === '}') brace = Math.max(0, brace - 1)
      else if (tok.text === '(') paren++
      else if (tok.text === ')') paren = Math.max(0, paren - 1)
      else if (tok.text === '[') bracket++
      else if (tok.text === ']') bracket = Math.max(0, bracket - 1)
      else if (tok.text === ';' && brace === 0 && paren === 0 && bracket === 0) {
        if (cur.length > 0) {
          groups.push({
            tokens: cur,
            raw: source.slice(cur[0].start, cur[cur.length - 1].end),
          })
          cur = []
        }
        continue
      }
    }
    cur.push(tok)
  }
  if (cur.length > 0) {
    groups.push({
      tokens: cur,
      raw: source.slice(cur[0].start, cur[cur.length - 1].end),
    })
  }
  return groups
}

function isEmptyJsonObject(val) {
  return (
    val !== null &&
    typeof val === 'object' &&
    !Array.isArray(val) &&
    Object.keys(val).length === 0
  )
}

function inspectMongoJsonCommand(raw, stmtIdx, preview, findings) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  const obj = parsed
  if (typeof obj.drop === 'string' && obj.drop.trim()) {
    findings.push({
      kind: 'drop',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target: obj.drop.trim(),
      message: `DROP collection "${obj.drop.trim()}" will permanently delete all its documents and indexes`,
    })
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'dropDatabase')) {
    findings.push({
      kind: 'drop',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target: 'database',
      message: 'dropDatabase command will permanently delete the entire database',
    })
  }
  if (typeof obj.delete === 'string' && Array.isArray(obj.deletes)) {
    const hasEmptyFilter = obj.deletes.some((entry) => entry && isEmptyJsonObject(entry.q))
    if (hasEmptyFilter) {
      findings.push({
        kind: 'delete_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target: obj.delete,
        message: `delete on "${obj.delete}" with empty filter {} will delete all matching documents`,
      })
    }
  }
  if (typeof obj.update === 'string' && Array.isArray(obj.updates)) {
    const hasEmptyFilter = obj.updates.some((entry) => entry && isEmptyJsonObject(entry.q))
    if (hasEmptyFilter) {
      findings.push({
        kind: 'update_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target: obj.update,
        message: `update on "${obj.update}" with empty filter {} will modify all documents`,
      })
    }
  }
  return true
}

function isEmptyFilterArgTokens(argTokens) {
  if (argTokens.length === 0) return true
  return (
    argTokens.length === 2 &&
    argTokens[0].kind === 'punct' &&
    argTokens[0].text === '{' &&
    argTokens[1].kind === 'punct' &&
    argTokens[1].text === '}'
  )
}

function resolveShellTargetName(tokens, dotIdx) {
  if (dotIdx <= 0) return undefined
  const prev = tokens[dotIdx - 1]
  if (prev.kind === 'ident') {
    const parts = [prev.text]
    let cursor = dotIdx - 1
    while (
      cursor >= 2 &&
      tokens[cursor - 1].kind === 'punct' &&
      tokens[cursor - 1].text === '.' &&
      tokens[cursor - 2].kind === 'ident'
    ) {
      const ident = tokens[cursor - 2].text
      if (ident === 'db') break
      parts.unshift(ident)
      cursor -= 2
    }
    return parts.join('.')
  }
  // Handle db.getCollection("orders").drop() or db.getCollection('orders')
  if (
    prev.kind === 'punct' &&
    prev.text === ')' &&
    dotIdx >= 4 &&
    tokens[dotIdx - 2].kind === 'string' &&
    tokens[dotIdx - 3].kind === 'punct' &&
    tokens[dotIdx - 3].text === '(' &&
    tokens[dotIdx - 4].kind === 'ident' &&
    tokens[dotIdx - 4].text === 'getCollection'
  ) {
    return tokens[dotIdx - 2].value
  }
  return undefined
}

function parseMongoObjectTopLevelProps(objTokens) {
  if (
    !Array.isArray(objTokens) ||
    objTokens.length < 2 ||
    objTokens[0].kind !== 'punct' ||
    objTokens[0].text !== '{' ||
    objTokens[objTokens.length - 1].kind !== 'punct' ||
    objTokens[objTokens.length - 1].text !== '}'
  ) {
    return null
  }
  const props = new Map()
  let i = 1
  const end = objTokens.length - 1
  while (i < end) {
    const keyTok = objTokens[i]
    if (keyTok.kind === 'punct' && keyTok.text === ',') {
      i++
      continue
    }
    if (keyTok.kind !== 'ident' && keyTok.kind !== 'string') break
    const keyName = keyTok.kind === 'string' ? keyTok.value : keyTok.text
    if (i + 1 >= end || objTokens[i + 1].kind !== 'punct' || objTokens[i + 1].text !== ':') {
      break
    }
    const valStart = i + 2
    let j = valStart
    let brace = 0
    let bracket = 0
    let paren = 0
    while (j < end) {
      const t = objTokens[j]
      if (t.kind === 'punct') {
        if (t.text === '{') brace++
        else if (t.text === '}') brace = Math.max(0, brace - 1)
        else if (t.text === '[') bracket++
        else if (t.text === ']') bracket = Math.max(0, bracket - 1)
        else if (t.text === '(') paren++
        else if (t.text === ')') paren = Math.max(0, paren - 1)
        else if (t.text === ',' && brace === 0 && bracket === 0 && paren === 0) {
          break
        }
      }
      j++
    }
    props.set(keyName, objTokens.slice(valStart, j))
    i = j < end && objTokens[j].kind === 'punct' && objTokens[j].text === ',' ? j + 1 : j
  }
  return props
}

function splitMongoArrayTopLevelElements(arrTokens) {
  if (
    !Array.isArray(arrTokens) ||
    arrTokens.length < 2 ||
    arrTokens[0].kind !== 'punct' ||
    arrTokens[0].text !== '[' ||
    arrTokens[arrTokens.length - 1].kind !== 'punct' ||
    arrTokens[arrTokens.length - 1].text !== ']'
  ) {
    return []
  }
  const elements = []
  let cur = []
  let brace = 0
  let bracket = 0
  let paren = 0
  for (let i = 1; i < arrTokens.length - 1; i++) {
    const t = arrTokens[i]
    if (t.kind === 'punct') {
      if (t.text === '{') brace++
      else if (t.text === '}') brace = Math.max(0, brace - 1)
      else if (t.text === '[') bracket++
      else if (t.text === ']') bracket = Math.max(0, bracket - 1)
      else if (t.text === '(') paren++
      else if (t.text === ')') paren = Math.max(0, paren - 1)
      else if (t.text === ',' && brace === 0 && bracket === 0 && paren === 0) {
        if (cur.length > 0) {
          elements.push(cur)
          cur = []
        }
        continue
      }
    }
    cur.push(t)
  }
  if (cur.length > 0) elements.push(cur)
  return elements
}

function readSingleMongoStringValue(valTokens) {
  if (
    Array.isArray(valTokens) &&
    valTokens.length === 1 &&
    valTokens[0].kind === 'string' &&
    typeof valTokens[0].value === 'string'
  ) {
    return valTokens[0].value.trim()
  }
  return ''
}

function inspectMongoCommandObjectTokens(argTokens, stmtIdx, preview, findings) {
  const props = parseMongoObjectTopLevelProps(argTokens)
  if (!props) return false
  const dropTarget = readSingleMongoStringValue(props.get('drop'))
  if (dropTarget) {
    findings.push({
      kind: 'drop',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target: dropTarget,
      message: `DROP collection "${dropTarget}" will permanently delete all its documents and indexes`,
    })
  }
  if (props.has('dropDatabase')) {
    findings.push({
      kind: 'drop',
      statementIndex: stmtIdx,
      statementPreview: preview,
      target: 'database',
      message: 'dropDatabase command will permanently delete the entire database',
    })
  }
  const deleteTarget = readSingleMongoStringValue(props.get('delete'))
  const deletesArr = props.get('deletes')
  if (deleteTarget && deletesArr) {
    const hasEmptyFilter = splitMongoArrayTopLevelElements(deletesArr).some((elTokens) => {
      const entryProps = parseMongoObjectTopLevelProps(elTokens)
      if (!entryProps || !entryProps.has('q')) return false
      return isEmptyFilterArgTokens(entryProps.get('q'))
    })
    if (hasEmptyFilter) {
      findings.push({
        kind: 'delete_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target: deleteTarget,
        message: `delete on "${deleteTarget}" with empty filter {} will delete all matching documents`,
      })
    }
  }
  const updateTarget = readSingleMongoStringValue(props.get('update'))
  const updatesArr = props.get('updates')
  if (updateTarget && updatesArr) {
    const hasEmptyFilter = splitMongoArrayTopLevelElements(updatesArr).some((elTokens) => {
      const entryProps = parseMongoObjectTopLevelProps(elTokens)
      if (!entryProps || !entryProps.has('q')) return false
      return isEmptyFilterArgTokens(entryProps.get('q'))
    })
    if (hasEmptyFilter) {
      findings.push({
        kind: 'update_without_where',
        statementIndex: stmtIdx,
        statementPreview: preview,
        target: updateTarget,
        message: `update on "${updateTarget}" with empty filter {} will modify all documents`,
      })
    }
  }
  return true
}

function readFirstCallArgTokens(tokens, openParenIdx) {
  const firstArg = []
  let parenDepth = 1
  let braceDepth = 0
  let bracketDepth = 0
  for (let i = openParenIdx + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'punct') {
      if (t.text === '(') parenDepth++
      else if (t.text === ')') {
        parenDepth--
        if (parenDepth === 0) break
      } else if (t.text === '{') braceDepth++
      else if (t.text === '}') braceDepth = Math.max(0, braceDepth - 1)
      else if (t.text === '[') bracketDepth++
      else if (t.text === ']') bracketDepth = Math.max(0, bracketDepth - 1)
      else if (t.text === ',' && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
        break
      }
    }
    firstArg.push(t)
  }
  return firstArg
}

function analyzeDangerousMongo(sql) {
  const tokens = tokenizeMongoScript(sql)
  const stmts = splitMongoTokensIntoStatements(tokens, sql)
  const findings = []

  for (let stmtIdx = 0; stmtIdx < stmts.length; stmtIdx++) {
    const stmt = stmts[stmtIdx]
    const preview = stmt.raw.replace(/\s+/g, ' ').slice(0, 80)
    const stmtTokens = stmt.tokens

    if (
      stmtTokens.length >= 2 &&
      stmtTokens[0].kind === 'punct' &&
      stmtTokens[0].text === '{' &&
      stmtTokens[stmtTokens.length - 1].kind === 'punct' &&
      stmtTokens[stmtTokens.length - 1].text === '}'
    ) {
      if (inspectMongoJsonCommand(stmt.raw, stmtIdx, preview, findings)) {
        continue
      }
      inspectMongoCommandObjectTokens(stmtTokens, stmtIdx, preview, findings)
      continue
    }

    for (let i = 0; i + 2 < stmtTokens.length; i++) {
      if (
        stmtTokens[i].kind !== 'punct' ||
        stmtTokens[i].text !== '.' ||
        stmtTokens[i + 1].kind !== 'ident' ||
        stmtTokens[i + 2].kind !== 'punct' ||
        stmtTokens[i + 2].text !== '('
      ) {
        continue
      }

      const method = stmtTokens[i + 1].text
      const target = resolveShellTargetName(stmtTokens, i)

      if (method === 'drop') {
        findings.push({
          kind: 'drop',
          statementIndex: stmtIdx,
          statementPreview: preview,
          target,
          message: `DROP collection ${target ? `"${target}" ` : ''}will permanently delete all data and indexes`,
        })
      } else if (method === 'dropDatabase') {
        findings.push({
          kind: 'drop',
          statementIndex: stmtIdx,
          statementPreview: preview,
          target: 'database',
          message: 'dropDatabase() will permanently delete the entire database',
        })
      } else if (method === 'deleteMany' || method === 'remove') {
        const firstArg = readFirstCallArgTokens(stmtTokens, i + 2)
        if (isEmptyFilterArgTokens(firstArg)) {
          findings.push({
            kind: 'delete_without_where',
            statementIndex: stmtIdx,
            statementPreview: preview,
            target,
            message: `${method}({}) on ${target ? `"${target}" ` : 'collection '}has an empty filter and will delete all documents`,
          })
        }
      } else if (method === 'updateMany') {
        const firstArg = readFirstCallArgTokens(stmtTokens, i + 2)
        if (isEmptyFilterArgTokens(firstArg)) {
          findings.push({
            kind: 'update_without_where',
            statementIndex: stmtIdx,
            statementPreview: preview,
            target,
            message: `updateMany({}) on ${target ? `"${target}" ` : 'collection '}has an empty filter and will modify all documents`,
          })
        }
      } else if (method === 'runCommand' || method === 'adminCommand') {
        const firstArg = readFirstCallArgTokens(stmtTokens, i + 2)
        inspectMongoCommandObjectTokens(firstArg, stmtIdx, preview, findings)
      }
    }
  }

  return findings
}

function splitOraclePlSqlInternalStatements(chunk) {
  const parts = []
  const len = chunk.length
  let segStart = 0
  let parenDepth = 0
  let i = 0
  while (i < len) {
    const ch = chunk[i]
    if (ch === '-' && i + 1 < len && chunk[i + 1] === '-') {
      i = scanLineCommentEnd(chunk, i)
      continue
    }
    if (ch === '/' && i + 1 < len && chunk[i + 1] === '*') {
      i = scanBlockCommentEnd(chunk, i, false)
      continue
    }
    const oracleQuote = scanOracleQuoteEnd(chunk, i, 'oracle')
    if (oracleQuote) {
      i = oracleQuote.end
      continue
    }
    if (ch === "'" || ch === '"') {
      i = scanQuotedSegmentEnd(chunk, i, ch, false).end
      continue
    }
    if (ch === '(') {
      parenDepth++
      i++
      continue
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      i++
      continue
    }
    if (ch === ';' && parenDepth === 0) {
      const piece = chunk.slice(segStart, i).trim()
      if (piece) parts.push(piece)
      i++
      segStart = i
      continue
    }
    i++
  }
  const tail = chunk.slice(segStart).trim()
  if (tail) parts.push(tail)
  return parts
}

function stripOraclePlSqlStatementPrefix(tokens, startIdx) {
  let idx = startIdx
  while (idx < tokens.length) {
    const tok = tokens[idx]
    if (!tok || tok.depth !== 0 || tok.kind !== 'word') break
    const u = tok.text.toUpperCase()
    if (u === 'BEGIN' || u === 'ELSE' || u === 'LOOP') {
      idx++
      continue
    }
    if (u === 'DECLARE' || u === 'CREATE') {
      let beginIdx = -1
      for (let j = idx + 1; j < tokens.length; j++) {
        if (
          tokens[j].depth === 0 &&
          tokens[j].kind === 'word' &&
          tokens[j].text.toUpperCase() === 'BEGIN'
        ) {
          beginIdx = j
          break
        }
      }
      if (beginIdx >= 0) {
        idx = beginIdx + 1
        continue
      }
      break
    }
    if (u === 'IF' || u === 'ELSIF' || u === 'EXCEPTION' || u === 'WHEN') {
      let thenIdx = -1
      for (let j = idx + 1; j < tokens.length; j++) {
        if (
          tokens[j].depth === 0 &&
          tokens[j].kind === 'word' &&
          tokens[j].text.toUpperCase() === 'THEN'
        ) {
          thenIdx = j
          break
        }
      }
      if (thenIdx >= 0) {
        idx = thenIdx + 1
        continue
      }
      break
    }
    if (u === 'FOR' || u === 'WHILE') {
      let loopIdx = -1
      for (let j = idx + 1; j < tokens.length; j++) {
        if (
          tokens[j].depth === 0 &&
          tokens[j].kind === 'word' &&
          tokens[j].text.toUpperCase() === 'LOOP'
        ) {
          loopIdx = j
          break
        }
      }
      if (loopIdx >= 0) {
        idx = loopIdx + 1
        continue
      }
      break
    }
    break
  }
  return idx
}

function findMssqlTriggerHeaderEnd(tokens, baseOffset, firstWord) {
  if (firstWord !== 'CREATE' && firstWord !== 'ALTER') return -1
  let isTrigger = false
  for (let i = baseOffset + 1; i < Math.min(tokens.length, baseOffset + 5); i++) {
    if (tokens[i].depth === 0 && tokens[i].kind === 'word') {
      const u = tokens[i].text.toUpperCase()
      if (u === 'TRIGGER') {
        isTrigger = true
        break
      }
      if (u !== 'OR' && u !== 'ALTER') break
    }
  }
  if (!isTrigger) return -1
  for (let i = baseOffset + 2; i < tokens.length; i++) {
    if (tokens[i].depth === 0 && tokens[i].kind === 'word' && tokens[i].text.toUpperCase() === 'AS') {
      return i
    }
  }
  return tokens.length
}

/**
 * Analyzes a SQL or NoSQL script for dangerous and destructive operations.
 * Detects DELETE without WHERE, UPDATE without WHERE, DROP, and TRUNCATE,
 * including inside data-modifying CTEs, EXPLAIN ANALYZE DML, MSSQL GO/semicolon-less batches,
 * Oracle `/` / PL/SQL blocks, and MongoDB MQL.
 * Completely immune to false positives inside comments and string literals.
 */
export function analyzeDangerousSql(sql, dialect) {
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    return []
  }

  if (dialect === 'redis') {
    if (isRedisDangerousCommand(sql)) {
      return [
        {
          kind: 'truncate',
          statementIndex: 0,
          statementPreview: sql.trim().slice(0, 80),
          target: 'redis_database',
          message: 'FLUSHDB / FLUSHALL will permanently delete all keys in the database',
        },
      ]
    }
    return []
  }

  if (dialect === 'mongodb') {
    return analyzeDangerousMongo(sql)
  }

  const stmtEntries = []
  if (dialect === 'mssql') {
    for (const batch of splitMssqlBatches(sql)) {
      for (const s of splitSqlStatements(batch, 'mssql')) {
        stmtEntries.push({ text: s.text, isOraclePlSql: false })
      }
    }
  } else if (dialect === 'oracle') {
    for (const chunk of splitOracleSlashChunks(sql)) {
      const stripped = stripLeadingSqlComments(chunk, 'oracle').trim()
      if (ORACLE_PLSQL_CHUNK_RE.test(stripped)) {
        for (const inner of splitOraclePlSqlInternalStatements(chunk)) {
          stmtEntries.push({ text: inner, isOraclePlSql: true })
        }
      } else {
        for (const s of splitSqlStatements(chunk, 'oracle')) {
          stmtEntries.push({ text: s.text, isOraclePlSql: false })
        }
      }
    }
  } else {
    for (const s of splitSqlStatements(sql, dialect)) {
      stmtEntries.push({ text: s.text, isOraclePlSql: false })
    }
  }

  const findings = []

  for (let stmtIdx = 0; stmtIdx < stmtEntries.length; stmtIdx++) {
    const { text: rawText, isOraclePlSql } = stmtEntries[stmtIdx]
    const preview = rawText.trim().replace(/\s+/g, ' ').slice(0, 80)
    const tokens = tokenizeStatementForSafety(rawText, dialect)

    if (tokens.length === 0) {
      continue
    }

    let baseOffset = unwrapExplainAnalyzeOffset(tokens, rawText, dialect)
    if (isOraclePlSql) {
      baseOffset = stripOraclePlSqlStatementPrefix(tokens, baseOffset)
      if (baseOffset >= tokens.length) continue
    }

    const firstToken = tokens[baseOffset]
    const firstWord = firstToken?.kind === 'word' ? firstToken.text.toUpperCase() : ''
    const inspectedIndices = new Set()

    if (firstWord === 'WITH') {
      let mainIdx = -1
      for (let i = baseOffset + 1; i < tokens.length; i++) {
        const t = tokens[i]
        if (
          t.depth === 0 &&
          t.kind === 'word' &&
          !isPrecededByDot(tokens, i) &&
          CTE_MAIN_DML_KEYWORDS.has(t.text.toUpperCase())
        ) {
          mainIdx = i
          break
        }
        if (
          t.depth === 1 &&
          t.kind === 'word' &&
          (t.text.toUpperCase() === 'DELETE' || t.text.toUpperCase() === 'UPDATE') &&
          tokens[i - 1]?.kind === 'punct' &&
          tokens[i - 1].text === '('
        ) {
          inspectScopeForDangerousDml(tokens, i, 1, stmtIdx, preview, findings)
        }
      }
      if (mainIdx !== -1) {
        inspectedIndices.add(mainIdx)
        inspectScopeForDangerousDml(tokens, mainIdx, 0, stmtIdx, preview, findings)
      }
      if (dialect !== 'mssql') {
        continue
      }
    } else {
      inspectedIndices.add(baseOffset)
      inspectScopeForDangerousDml(tokens, baseOffset, 0, stmtIdx, preview, findings)
    }

    if (dialect === 'mssql') {
      const triggerHeaderEnd = findMssqlTriggerHeaderEnd(tokens, baseOffset, firstWord)
      for (let i = baseOffset + 1; i < tokens.length; i++) {
        if (inspectedIndices.has(i)) continue
        const t = tokens[i]
        if (t.depth !== 0 || t.kind !== 'word') continue
        if (isPrecededByDot(tokens, i)) continue
        const u = t.text.toUpperCase()
        if (!CTE_MAIN_DML_KEYWORDS.has(u)) continue
        if (u === 'DELETE' || u === 'UPDATE') {
          if (triggerHeaderEnd >= 0 && i < triggerHeaderEnd) continue
          const prev = tokens[i - 1]
          if (prev && prev.kind === 'word' && MSSQL_DML_EVENT_PREDECESSORS.has(prev.text.toUpperCase())) {
            continue
          }
        }
        if (u === 'DROP' && firstWord === 'ALTER') {
          const nextTok = tokens[i + 1]
          const nextUpper = nextTok && nextTok.kind === 'word' ? nextTok.text.toUpperCase() : ''
          if (!MSSQL_STANDALONE_DROP_OBJECTS.has(nextUpper)) {
            continue
          }
          if (nextUpper === 'INDEX' && !isMssqlStandaloneDropIndex(tokens, i)) {
            continue
          }
        }
        inspectedIndices.add(i)
        inspectScopeForDangerousDml(tokens, i, 0, stmtIdx, preview, findings)
      }
    }
  }

  return findings
}

export const CLOUD_DB_HOST_SUFFIXES = [
  '.supabase.co',
  '.supabase.com',
  '.neon.tech',
  '.cockroachlabs.cloud',
  '.rds.amazonaws.com',
  '.aivencloud.com',
  '.render.com',
  '.railway.app',
  '.rlwy.net',
  '.database.azure.com',
  '.ondigitalocean.com',
  '.tidbcloud.com',
  '.psdb.cloud',
  '.planetscale.com',
  '.upstash.io',
  '.turso.io',
  '.clickhouse.cloud',
  '.clever-cloud.com',
  '.elephantsql.com',
  '.timescale.com',
  '.xata.sh',
  '.tembo.io',
]

export function isCloudDatabaseHost(hostname) {
  const lower = String(hostname || '').trim().toLowerCase()
  if (
    !lower ||
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '[::1]'
  ) {
    return false
  }
  return CLOUD_DB_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}
