/**
 * Session-log scanning for the `/th` history view.
 *
 * The stored session logs are the only accurate local record of what the
 * provider actually billed: every `assistant/message` event carries the usage
 * report DeepSeek returned for that request. This module walks them, reduces
 * each file to a small per-model/per-day record (`./history.js`), and keeps an
 * incremental cache so only changed files are ever decoded again.
 *
 * Two details of the storage format are load-bearing:
 *
 * - The logs are **multi-frame** zstd. `zlib.zstdDecompressSync` stops after
 *   the first frame, so frames are split on the zstd magic and decoded one by
 *   one; a candidate split that fails to decode is retried at the next magic
 *   (a magic byte pair can occur inside compressed data).
 * - A fork-seeded log physically carries its parent's prefix. The cut is
 *   applied in `./history.js` (`seedLength`), not here.
 *
 * Scanning never throws and never blocks the host: failures degrade to "this
 * file was skipped", and the loop yields to the event loop between files.
 *
 * @module dsh-peak-balance/history-scan
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { foldSessionEvents } from './history.js'

/** zstd frame magic (`Zstandard`, little endian). */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** On-disk cache shape version. */
export const CACHE_VERSION = 1

/** Session records kept in the cache (newest files win). */
export const MAX_CACHED_FILES = 3000

/** Path of the incremental cache. */
export function historyCachePath(env = process.env) {
  const dir = typeof env?.DSH_TUI_STATE_DIR === 'string' && env.DSH_TUI_STATE_DIR !== ''
    ? env.DSH_TUI_STATE_DIR
    : join(homedir(), '.dsh-tui')
  return join(dir, 'dsh-peak-balance-history.json')
}

/** Root directory holding every stored session log. */
export function sessionsRoot(env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** Whether a file name looks like a stored session log. */
export function isSessionLogName(name) {
  return /^session(\..+)?\.jsonl(\.zstd)?$/.test(name)
}

/**
 * Exact byte length of the zstd frame starting at `offset`, or `undefined`.
 *
 * The stored logs are a concatenation of independently compressed frames, and
 * `zlib.zstdDecompressSync` stops after the first one. Scanning for the magic
 * would be enough *almost* always — but the four magic bytes can occur inside a
 * compressed block, and a truncated decode of such a false boundary SUCCEEDS
 * with partial content (Node tolerates an unterminated block), which would
 * silently drop events. Parsing the frame header and block headers is exact, so
 * a frame is never guessed at.
 *
 * Layout (RFC 8878): magic, frame header descriptor, optional window
 * descriptor, dictionary id and frame content size, then blocks until the
 * `last_block` flag.
 *
 * @param buffer - the whole file.
 * @param offset - candidate frame start.
 * @returns The frame's total length in bytes, or `undefined` when this is not a
 *   complete frame (a foreign prefix, or a log being appended to right now).
 */
export function frameSize(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length - offset < 5) return undefined
  if (buffer.readUInt32LE(offset) !== 0xfd2fb528) return undefined
  let cursor = offset + 4
  const descriptor = buffer[cursor]
  cursor += 1
  const fcsFlag = (descriptor >> 6) & 3
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictFlag = descriptor & 3
  if (!singleSegment) {
    if (cursor >= buffer.length) return undefined
    cursor += 1 // Window_Descriptor
  }
  cursor += [0, 1, 2, 4][dictFlag]
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [2, 4, 8][fcsFlag - 1]
  cursor += fcsSize
  if (cursor > buffer.length) return undefined

  for (;;) {
    if (cursor + 3 > buffer.length) return undefined
    const blockHeader = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3
    const last = blockHeader & 1
    const type = (blockHeader >> 1) & 3
    const size = blockHeader >> 3
    if (type === 0) cursor += size
    else if (type === 1) cursor += 1
    else if (type === 2) cursor += size
    else return undefined // Reserved block type.
    if (cursor > buffer.length) return undefined
    if (last === 1) break
  }
  if (checksum) cursor += 4
  return cursor <= buffer.length ? cursor - offset : undefined
}

/**
 * Decode one stored log buffer into text.
 *
 * @param buffer - raw file bytes.
 * @returns `{ text, frames, failedFrames, truncated }`; `truncated` marks a
 *   buffer whose tail could not be decoded (a log being appended to right now).
 */
export function decodeLog(buffer) {
  if (buffer === undefined || buffer === null || buffer.length === 0) {
    return { text: '', frames: 0, failedFrames: 0, truncated: false }
  }
  const firstMagic = buffer.indexOf(ZSTD_MAGIC)
  if (firstMagic === -1) {
    // Not compressed (a plaintext `.jsonl` variant, or a foreign file).
    return { text: buffer.toString('utf8'), frames: 0, failedFrames: 0, truncated: false }
  }

  const parts = []
  let failedFrames = 0
  let offset = firstMagic
  let truncated = false
  while (offset < buffer.length) {
    const size = frameSize(buffer, offset)
    if (size === undefined) {
      failedFrames += 1
      truncated = true
      const next = buffer.indexOf(ZSTD_MAGIC, offset + 1)
      if (next === -1) break
      offset = next
      continue
    }
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset, offset + size)))
    } catch {
      failedFrames += 1
    }
    offset += size
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: parts.length, failedFrames, truncated }
}

/** Parse decoded log text into events, skipping malformed lines. */
export function parseEvents(text) {
  const events = []
  let badLines = 0
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { events, badLines }
}

/** Reduce one buffer to a session record. */
export function recordFromBuffer(buffer) {
  const decoded = decodeLog(buffer)
  const { events, badLines } = parseEvents(decoded.text)
  const record = foldSessionEvents(events)
  record.failedFrames = decoded.failedFrames
  record.badLines = badLines
  return record
}

/** Every session log under `root`, newest first (bounded). */
export function listLogFiles(root) {
  const files = []
  const walk = directory => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(path)
        } else if (entry.isFile() && isSessionLogName(entry.name)) {
          const stat = statSync(path)
          files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
        }
      } catch {
        // A file that vanished mid-walk is simply not part of this scan.
      }
    }
  }
  walk(root)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files.length > MAX_CACHED_FILES ? files.slice(0, MAX_CACHED_FILES) : files
}

/** Parse the cache document; anything unusable degrades to an empty cache. */
export function parseCache(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { version: CACHE_VERSION, builtAt: 0, files: {} }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, builtAt: 0, files: {} }
  }
  const files = parsed.files !== null && typeof parsed.files === 'object' ? parsed.files : {}
  return { version: CACHE_VERSION, builtAt: parsed.builtAt ?? 0, files }
}

/** Read the cache file; never throws. */
export function readCache(options = {}) {
  const readFile = options.readFile ?? readFileSync
  const file = options.cachePath ?? historyCachePath(options.env)
  try {
    return parseCache(readFile(file, 'utf8'))
  } catch {
    return { version: CACHE_VERSION, builtAt: 0, files: {} }
  }
}

/** Write the cache file; returns `false` when it could not be written. */
export function writeCache(cache, options = {}) {
  const writeFile = options.writeFile ?? writeFileSync
  const file = options.cachePath ?? historyCachePath(options.env)
  try {
    // The state directory may not exist yet on a fresh machine, and a failed
    // cache write must never fail the scan (it degrades to a full rescan).
    mkdirSync(dirname(file), { recursive: true })
    writeFile(file, `${JSON.stringify(cache)}\n`)
    return true
  } catch {
    return false
  }
}

/** A cache entry's key for one file path (stable across machines). */
function keyOf(root, path) {
  const rel = relative(root, path)
  return rel.split(sep).join('/')
}

/**
 * Scan the session logs.
 *
 * @param options.root - sessions root (defaults to `$DSH_HOME/sessions`).
 * @param options.cachePath - cache file (defaults to `~/.dsh-tui/...`).
 * @param options.cache - preloaded cache document (tests / callers that hold it).
 * @param options.env - environment for the default paths.
 * @param options.signal - `AbortSignal`; the scan stops between files.
 * @param options.onProgress - `({ done, total, path })` after each file.
 * @param options.readFile - `readFileSync` override (tests).
 * @param options.writeFile - `writeFileSync` override (tests).
 * @param options.now - clock injection.
 * @returns `{ records, stats, cache, aborted }`; `records` is newest-last so
 *   the caller can keep the whole history in memory.
 */
export async function scanSessions(options = {}) {
  const root = options.root ?? sessionsRoot(options.env)
  const cachePath = options.cachePath ?? historyCachePath(options.env)
  const now = options.now ?? Date.now()
  const readFile = options.readFile ?? readFileSync
  const startedAt = Date.now()
  const cache = options.cache ?? readCache({ cachePath, readFile, env: options.env })

  const files = listLogFiles(root)
  const nextFiles = {}
  const records = []
  let scanned = 0
  let reused = 0
  let failed = 0
  let failedFrames = 0
  let badLines = 0
  let aborted = false

  for (const file of files) {
    if (options.signal?.aborted === true) {
      aborted = true
      break
    }
    const key = keyOf(root, file.path)
    const cached = cache.files[key]
    if (cached !== undefined && cached.size === file.size && cached.mtimeMs === file.mtimeMs && cached.record) {
      reused += 1
      nextFiles[key] = cached
      records.push(cached.record)
    } else {
      try {
        const record = recordFromBuffer(readFile(file.path))
        scanned += 1
        failedFrames += record.failedFrames ?? 0
        badLines += record.badLines ?? 0
        const entry = { size: file.size, mtimeMs: file.mtimeMs, record }
        nextFiles[key] = entry
        records.push(record)
      } catch {
        // Unreadable file: skipped for this scan, retried next time.
        failed += 1
      }
    }
    options.onProgress?.({ done: scanned + reused + failed, total: files.length, path: file.path })
    // Yield between files: a full rebuild decodes ~80 MB, and the TUI must keep
    // painting (and the user must keep typing) while it happens.
    await new Promise(resolve => {
      setImmediate(resolve)
    })
  }

  const nextCache = { version: CACHE_VERSION, builtAt: now, files: nextFiles }
  const wrote = writeCache(nextCache, { cachePath, writeFile: options.writeFile, env: options.env })
  records.reverse()

  return {
    records,
    aborted,
    cache: nextCache,
    stats: {
      files: files.length,
      scanned,
      reused,
      failed,
      failedFrames,
      badLines,
      wrote,
      durationMs: Date.now() - startedAt,
      truncatedLogs: records.filter(record => (record.failedFrames ?? 0) > 0).length,
      seededSessions: records.filter(record => record.seeded === true).length,
      subagentSessions: records.filter(record => record.subagent === true).length,
      events: records.reduce((sum, record) => sum + (record.events ?? 0), 0),
      skippedEvents: records.reduce((sum, record) => sum + (record.skipped ?? 0), 0),
    },
  }
}
