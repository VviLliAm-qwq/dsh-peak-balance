/**
 * Session-log scanning for the `/th` history view.
 *
 * The stored session logs are the only accurate local record of what the
 * provider actually billed: every `assistant/message` event carries the usage
 * report DeepSeek returned for that request. This module walks them, reduces
 * each file to a small per-model/per-day record (`./history.js`), and keeps an
 * incremental cache so only changed files are ever decoded again.
 *
 * Three details of the storage format are load-bearing:
 *
 * - The logs are **multi-frame** zstd. `zlib.zstdDecompressSync` stops after
 *   the first frame, so frames are split on the zstd magic and decoded one by
 *   one; a candidate split that fails to decode is retried at the next magic
 *   (a magic byte pair can occur inside compressed data).
 * - A fork-seeded log physically carries its parent's prefix. The cut is
 *   applied in `./history.js` (`seedLength`), not here.
 * - Only four event types can change a record (`assistant/message`,
 *   `request/header`, `session`, `session/end-seed`). A *line* whose type is
 *   none of them is never parsed, and a *frame* that cannot carry one is never
 *   even turned into text. That is ~95% of the lines in the corpus this was
 *   written against — but the ones kept are the bulky assistant messages, so the
 *   parse cost falls by rather less than the line count suggests.
 *
 * A rebuild is therefore three costs smaller than it looks: frames only, and
 * only the ones a *changed* file gained. The cache remembers, per file, how far
 * into the file its record has been folded (`done`), a signature of the bytes
 * just before that point, and the fold state to continue with — so a log that
 * was only appended to is finished by decoding its new frames
 * (`readSessionLog`). An interrupted run keeps every entry it never reached,
 * and a document written by an older version is *migrated* rather than dropped
 * (see {@link CACHE_MIGRATIONS}), because discarding a corpus-wide cache over a
 * record-shape change is what made a plugin update cost a full rescan.
 *
 * Measured on the machine this was written on (437 logs, 112 MB compressed,
 * 190k frames): a rebuild of every log went from ~6.2 s to ~5.5 s — the
 * frame-by-frame zstd decode is ~4.3 s of that and is the floor — a refresh that
 * only had to read one grown log went from 314 ms to 17 ms, and a plugin update
 * stopped costing a rebuild at all.
 *
 * Scanning never throws and never blocks the host: failures degrade to "this
 * file was skipped", and the loop yields to the event loop after each file it
 * actually *decodes* — a cached corpus is a map lookup, so it finishes in one
 * turn instead of paying a round trip per file.
 *
 * @module dsh-peak-balance/history-scan
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createSessionFold, foldSessionEvents } from './history.js'

/** zstd frame magic (`Zstandard`, little endian). */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Substrings that make a frame, or a line, worth decoding and parsing.
 *
 * Every event type a record can be built from names one of these; a line that
 * mentions none of them cannot change a record, whatever it says. `session`
 * covers the header and every `session/...` marker alike, which is what a
 * *substring* test can promise. The check is deliberately textual rather than
 * structural — `line.includes('assistant/message')` costs a scan, while knowing
 * the same fact exactly would mean parsing the line, which is the cost being
 * avoided. A host that serialized the type as `"assistant\/message"` would fall
 * through it, and no host does: the logs are `JSON.stringify` output.
 */
export const RELEVANT_MARKERS = Object.freeze(['assistant/message', 'request/header', 'session'])

/**
 * The exact event types the fold can act on.
 *
 * `session/end-seed` is the one a substring test reaches only through `session`
 * and an exact test therefore has to name: it is the fork cut. A fold that
 * learns a new type belongs in both this list and {@link RELEVANT_MARKERS}.
 */
export const RELEVANT_TYPES = Object.freeze(['assistant/message', 'request/header', 'session', 'session/end-seed'])

/** The shape `JSON.stringify` gives every line: its `type` key comes first. */
const TYPE_PREFIX = '{"type":"'

/** Whether one line can name an event a record is built from. */
export function isRelevantLine(line) {
  // The host writes `JSON.stringify` output, so a line opens with its `type`:
  // reading that twenty-character prefix is O(20), where scanning the whole line
  // once per marker is O(line) — and these lines average a kilobyte. A writer
  // that formats differently, or orders its keys differently, falls through to
  // the scan below, which is what decides the line either way.
  if (line.startsWith(TYPE_PREFIX)) {
    const end = line.indexOf('"', TYPE_PREFIX.length)
    if (end !== -1) return RELEVANT_TYPES.includes(line.slice(TYPE_PREFIX.length, end))
  }
  for (const marker of RELEVANT_MARKERS) {
    if (line.includes(marker)) return true
  }
  return false
}

/** Whether one decoded frame can carry such a line. */
function frameMayBeRelevant(chunk) {
  for (const marker of RELEVANT_MARKERS) {
    if (chunk.includes(marker)) return true
  }
  return false
}

/**
 * On-disk cache shape version.
 *
 * Bumped to 3 when a provider-less bucket key gained the `BARE_KEY_PREFIX`
 * marker (`./history.js`): a v2 document stores a model id that contains a slash
 * as `provider/model`, which the new split would read as a real provider, so a
 * v2 document must not be trusted. That bump *discarded* every entry and is why
 * this module now migrates instead (see below): it cost a full corpus rebuild —
 * ~12 s on the machine this was written on — the first time `/hist` opened.
 *
 * Bumped to 4 when an entry gained `done`/`tail`/`carry`: a v3 entry holds a
 * whole-file record but no resume point, which is perfectly readable — the
 * fields start out absent and the first append earns them — so v3 → v4 is a
 * migration rather than an invalidation.
 */
export const CACHE_VERSION = 4

/**
 * Per-version upgrades of a cache document, applied on read.
 *
 * Each step is a pure function from a document at version N to the same
 * document at version N+1, applied to every entry; returning `undefined` from a
 * step drops that entry. A *missing* step means the version cannot be read at
 * all, and the document degrades to an empty cache exactly as it always did —
 * so bumping {@link CACHE_VERSION} without adding a step is a deliberate
 * "rescan the world", and the version comment above says why.
 */
export const CACHE_MIGRATIONS = Object.freeze({
  // v3 → v4: the records themselves are already in the current shape (the
  // bucket-key marker came *in* v3), so an entry carries over as it is. Without
  // `done`/`tail`/`carry` it cannot resume, which simply means the first time
  // that log changes it is read whole and earns a resume point then.
  3: entry => entry,
})

/**
 * Bytes of a decoded prefix kept as its signature.
 *
 * A resume point is only trusted when the bytes just before it are unchanged:
 * session logs are appended to, never rewritten, and this is the guard that
 * says so instead of assuming it. Sixteen bytes make an accidental match
 * impossible in practice while costing one `subarray` and one base64 encode.
 */
export const TAIL_SIGNATURE_BYTES = 16

/**
 * Session records kept in the cache (newest files win).
 *
 * A corpus past this size is not silently shortened: the walk reports how many
 * logs it left out (`stats.droppedFiles`) and warns, so a board that depicts
 * "all history" can say when it does not.
 */
export const MAX_CACHED_FILES = 3000

/** Directory nesting the walk descends into before it gives up. */
export const MAX_WALK_DEPTH = 8

/**
 * Shortest gap between two progress notifications.
 *
 * The callback lands in the scene's store, and every write re-renders the whole
 * grid: a tick per file is ~340 full re-renders for a corpus this size, which
 * measured ~600 ms *inside the TUI* for a scan whose actual work (all files
 * cached) took 20 ms. Ticks are therefore coalesced, and only ever raised for a
 * file that was really decoded.
 */
export const PROGRESS_MIN_INTERVAL_MS = 60

/**
 * A rebuild checkpoints the cache every this many decoded files.
 *
 * The cache is otherwise written only once, at the very end, so a host restart
 * during the documented multi-second first scan threw all of it away and the
 * next open paid the full cost again.
 */
export const CHECKPOINT_EVERY_FILES = 64

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
      const next = buffer.indexOf(ZSTD_MAGIC, offset + 1)
      if (next === -1) {
        // Nothing decodable follows this boundary, so the tail itself is the
        // incomplete part: either the log is being appended to right now or its
        // last frame is damaged. A false boundary in the middle is followed by a
        // real frame and is reported through `failedFrames` alone — which is why
        // the flag is only ever set on the way out of the loop.
        truncated = true
        break
      }
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

/**
 * Parse decoded log text into events, skipping malformed lines.
 *
 * @param text - decoded log text.
 * @param options.keep - optional predicate; a line it rejects is never parsed,
 *   and so can never be counted as malformed either. This is how the scan keeps
 *   tool output and prose out of `JSON.parse` while still seeing every event a
 *   record is built from (`isRelevantLine`).
 * @returns `{ events, badLines }`.
 */
export function parseEvents(text, options = {}) {
  const keep = typeof options.keep === 'function' ? options.keep : undefined
  const events = []
  let badLines = 0
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue
    if (keep !== undefined && !keep(line)) continue
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

/**
 * The signature of the bytes just before a resume point.
 *
 * @param buffer - the log as read.
 * @param offset - the candidate resume point (a frame boundary).
 * @returns A base64 string (empty at offset 0), or `undefined` when the buffer
 *   does not even reach that far — a file that shrank, which cannot be resumed.
 */
export function tailSignatureAt(buffer, offset) {
  if (!Number.isFinite(offset) || offset < 0) return undefined
  if (offset === 0) return ''
  if (offset > buffer.length) return undefined
  return buffer.subarray(Math.max(0, offset - TAIL_SIGNATURE_BYTES), offset).toString('base64')
}

/**
 * Read the events a record can be built from, frame by frame.
 *
 * The log is never reassembled into one string: each frame is decoded, skipped
 * whole when it cannot name a relevant event, and otherwise parsed a line at a
 * time and dropped again. That keeps the lines that cannot change a record out
 * of `JSON.parse` (they are the small ones, so the byte saving is smaller than
 * the line saving — see the module notes), and it is what makes a *resumed* read
 * possible at all: a frame boundary is the point a later read can start from.
 *
 * @param buffer - the log as read.
 * @param options.start - byte offset of the first frame to read. Only a resume
 *   point from {@link readSessionLog} sets it; it must be a frame boundary, and
 *   a resume never falls back to plaintext (the offset came from a frame walk).
 * @returns `{ events, done, frames, failedFrames, badLines, truncated }`;
 *   `done` is the offset after the last complete frame read, which is the point
 *   a later resume would continue from. `failedFrames` counts what *this* read
 *   saw, a partial trailing frame included.
 */
export function extractLogEvents(buffer, options = {}) {
  const events = []
  let badLines = 0
  let failedFrames = 0
  let frames = 0
  let truncated = false
  const start = Number.isFinite(options.start) && options.start > 0 ? Math.floor(options.start) : 0

  const take = text => {
    const parsed = parseEvents(text, { keep: isRelevantLine })
    for (const event of parsed.events) events.push(event)
    badLines += parsed.badLines
  }

  if (buffer === undefined || buffer === null || buffer.length === 0) {
    return { events, done: start, frames, failedFrames, badLines, truncated }
  }
  if (start === 0 && buffer.indexOf(ZSTD_MAGIC) === -1) {
    // Not compressed (a plaintext `.jsonl` variant, or a foreign file). There
    // are no frames, so there is nothing to resume from either.
    take(buffer.toString('utf8'))
    return { events, done: buffer.length, frames, failedFrames, badLines, truncated }
  }

  let offset = start
  let done = start
  while (offset < buffer.length) {
    const size = frameSize(buffer, offset)
    if (size === undefined) {
      failedFrames += 1
      const next = buffer.indexOf(ZSTD_MAGIC, offset + 1)
      if (next === -1) {
        // Nothing decodable follows this boundary, so the tail itself is the
        // incomplete part: either the log is being appended to right now or its
        // last frame is damaged. A false boundary in the middle is followed by a
        // real frame and is reported through `failedFrames` alone — which is why
        // the flag is only ever set on the way out of the loop.
        truncated = true
        break
      }
      offset = next
      continue
    }
    let chunk
    let decoded = true
    try {
      chunk = zstdDecompressSync(buffer.subarray(offset, offset + size))
    } catch {
      failedFrames += 1
      decoded = false
    }
    offset += size
    done = offset
    if (!decoded) continue
    frames += 1
    // A frame the host wrote as one write is a whole number of lines, so this
    // never has to carry a half line across a frame boundary; a frame that
    // cannot name a relevant event is dropped without becoming a string.
    if (!frameMayBeRelevant(chunk)) continue
    take(chunk.toString('utf8'))
  }
  return { events, done, frames, failedFrames, badLines, truncated }
}

/** A record deep enough to fold into without touching the cached original. */
function cloneRecord(record) {
  try {
    return structuredClone(record)
  } catch {
    return JSON.parse(JSON.stringify(record))
  }
}

/**
 * Whether a cached entry can be continued instead of re-read from byte 0.
 *
 * Four things must hold, and each answers a way the cached prefix could be a
 * lie: the entry knows where it stopped, the file has not shrunk past it, the
 * bytes just before it are unchanged, and the fold it left behind can actually
 * be continued (a header was seen, and a fork cut that never resolved — the
 * legacy `isSeeded`-without-`seedLength` header — is not continued, because a
 * later batch could not tell whether a marker arrived in the gap).
 *
 * @returns The offset to continue from, or `undefined` for a full read.
 */
export function resumeOffsetOf(buffer, entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const done = entry.done
  if (!Number.isFinite(done) || done <= 0 || done >= buffer.length) return undefined
  // Folding continues *into* the cached record, so it has to look like one; a
  // hand-edited or foreign document must not get that far.
  const record = entry.record
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  const carry = entry.carry
  if (carry === null || typeof carry !== 'object' || carry.headerSeen !== true) return undefined
  if (carry.seedUnresolved === true) return undefined
  if (tailSignatureAt(buffer, done) !== entry.tail) return undefined
  // The bytes at the resume point must really start a frame, or the walk below
  // would be reading a hole.
  if (frameSize(buffer, done) === undefined) return undefined
  return done
}

/**
 * Read one stored log into the parts a cache entry holds.
 *
 * The single entry point for both readings: a file with no usable resume point
 * is decoded whole, and a file that only grew is finished from its cached
 * prefix, whose record and fold state it continues
 * ({@link createSessionFold}).
 *
 * @param buffer - the log as read (the whole file; the *decoding* is what is
 *   skipped, and reading 4 MB costs a millisecond where decoding it costs
 *   hundreds).
 * @param options.resume - the cache entry for this path. Ignored when
 *   {@link resumeOffsetOf} refuses it.
 * @returns `{ record, carry, done, tail, stats, resumed, failedFrames,
 *   badLines, truncated }`. `stats` is the *prefix's* diagnostics — the counts a
 *   full read would have accumulated before `done` — so the record can report
 *   whole-file numbers while the stored ones never count the partial trailing
 *   frame twice.
 */
export function readSessionLog(buffer, options = {}) {
  const resume = options.resume
  const start = resumeOffsetOf(buffer, resume)
  const resumed = start !== undefined
  const read = extractLogEvents(buffer, resumed ? { start } : {})
  const previousStats = resumed ? prefixStats(resume) : { failedFrames: 0, badLines: 0 }
  const fold = createSessionFold(
    resumed
      ? { ...resume.carry, record: cloneRecord(resume.record) }
      : undefined,
  )
  fold.push(read.events)
  const record = fold.record
  // A partial trailing frame is counted in the reading but never in the stored
  // prefix: `done` does not advance past it, so it is read again next time and
  // would otherwise be added to the totals on every scan.
  const partial = read.truncated ? 1 : 0
  const failedFrames = previousStats.failedFrames + read.failedFrames
  const badLines = previousStats.badLines + read.badLines
  record.failedFrames = failedFrames
  record.badLines = badLines
  // A partial trailing frame means the log was being appended to while it was
  // read; the record is still used, but the caller is told its tail is missing.
  record.truncated = read.truncated
  return {
    record,
    carry: fold.carry,
    done: read.done,
    tail: tailSignatureAt(buffer, read.done) ?? '',
    stats: {
      failedFrames: previousStats.failedFrames + Math.max(0, read.failedFrames - partial),
      badLines,
    },
    resumed,
    failedFrames,
    badLines,
    truncated: read.truncated,
  }
}

/** The stored prefix diagnostics of a cache entry (absent on pre-v4 entries). */
function prefixStats(entry) {
  const stats = entry?.stats
  return {
    failedFrames: typeof stats?.failedFrames === 'number' && Number.isFinite(stats.failedFrames) ? stats.failedFrames : 0,
    badLines: typeof stats?.badLines === 'number' && Number.isFinite(stats.badLines) ? stats.badLines : 0,
  }
}

/**
 * Reduce one whole buffer to a session record, the straightforward way.
 *
 * This is the reference reading: decode every frame, parse every line, fold the
 * lot. The scan does not use it — {@link readSessionLog} skips the frames and
 * lines that cannot matter, and continues a cached prefix — so this stays as the
 * documented meaning of "read a log", and as the oracle the filtered path is
 * checked against on crafted logs (and, by hand, on a real corpus).
 */
export function recordFromBuffer(buffer) {
  const decoded = decodeLog(buffer)
  const { events, badLines } = parseEvents(decoded.text)
  const record = foldSessionEvents(events)
  record.failedFrames = decoded.failedFrames
  record.badLines = badLines
  // A partial trailing frame means the log was being appended to while it was
  // read; the record is still used, but the caller is told its tail is missing.
  record.truncated = decoded.truncated
  return record
}

/**
 * Every session log under `root`, newest first, with what the walk had to skip.
 *
 * Links are never followed: `~/.dsh/sessions` is a plain tree written by the
 * host, so a symlink there is foreign, and a junction pointing back at an
 * ancestor would otherwise turn the walk into an infinite descent. The nesting
 * cap is the second guard, for a filesystem that reports a junction as a
 * directory instead of a link.
 *
 * @param options.maxFiles - cap on the returned list (default {@link MAX_CACHED_FILES}).
 * @param options.maxDepth - nesting cap (default {@link MAX_WALK_DEPTH}).
 * @returns `{ files, dropped, skippedLinks, tooDeep }`; `dropped` counts real
 *   history left out of `files` by the cap.
 */
export function collectLogFiles(root, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : MAX_CACHED_FILES
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : MAX_WALK_DEPTH
  const files = []
  let skippedLinks = 0
  let tooDeep = 0
  const walk = (directory, depth) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      try {
        if (entry.isSymbolicLink()) {
          skippedLinks += 1
        } else if (entry.isDirectory()) {
          if (depth >= maxDepth) tooDeep += 1
          else walk(path, depth + 1)
        } else if (entry.isFile() && isSessionLogName(entry.name)) {
          const stat = statSync(path)
          files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
        }
      } catch {
        // A file that vanished mid-walk is simply not part of this scan.
      }
    }
  }
  walk(root, 0)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const dropped = Math.max(0, files.length - maxFiles)
  return { files: dropped > 0 ? files.slice(0, maxFiles) : files, dropped, skippedLinks, tooDeep }
}

/** Every session log under `root`, newest first (bounded). */
export function listLogFiles(root) {
  return collectLogFiles(root).files
}

/** An empty cache document at the current version. */
function emptyCache() {
  return { version: CACHE_VERSION, builtAt: 0, files: {} }
}

/**
 * Upgrade a cache document's entries to the current version.
 *
 * @param version - the version the document was written at.
 * @param files - its entry map.
 * @returns The upgraded entry map, or `undefined` when no path to the current
 *   version exists (a document from the future, or one missing a step).
 */
function migrateFiles(version, files) {
  if (version === CACHE_VERSION) return files
  if (!Number.isInteger(version) || version < 1 || version > CACHE_VERSION) return undefined
  let current = files
  for (let from = version; from < CACHE_VERSION; from += 1) {
    const step = CACHE_MIGRATIONS[from]
    if (typeof step !== 'function') return undefined
    const next = {}
    for (const [key, entry] of Object.entries(current)) {
      const migrated = step(entry)
      if (migrated !== undefined) next[key] = migrated
    }
    current = next
  }
  return current
}

/**
 * Parse the cache document; anything unusable degrades to an empty cache.
 *
 * A document from an older version is migrated (see {@link CACHE_MIGRATIONS})
 * rather than discarded, and reports the version it came from so a caller can
 * say that its corpus did not have to be re-read.
 */
export function parseCache(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyCache()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyCache()
  // An array is an object by `typeof`, and spreading one into the entry map
  // would let index keys read as file paths.
  const files = parsed.files !== null && typeof parsed.files === 'object' && !Array.isArray(parsed.files)
    ? parsed.files
    : {}
  const migrated = migrateFiles(parsed.version, files)
  if (migrated === undefined) return emptyCache()
  return {
    version: CACHE_VERSION,
    builtAt: parsed.builtAt ?? 0,
    files: migrated,
    ...(parsed.version === CACHE_VERSION ? {} : { migratedFrom: parsed.version }),
  }
}

/** Read the cache file; never throws. */
export function readCache(options = {}) {
  const readFile = options.readFile ?? readFileSync
  const file = options.cachePath ?? historyCachePath(options.env)
  try {
    return parseCache(readFile(file, 'utf8'))
  } catch {
    return emptyCache()
  }
}

/**
 * The records a cache document holds, oldest first.
 *
 * `scanSessions` walks the newest file first and reverses at the end, so a
 * caller that consumes the cache directly (the `/hist` preload) has to restore
 * that order itself. Entries that are not a record-shaped object are skipped
 * rather than trusted: a document written by another version, or hand-edited,
 * must not smuggle a shape the view cannot read.
 *
 * @param cache - a {@link readCache} result (or anything else).
 * @returns The reduced session records, ready for `buildHistoryView`.
 */
export function recordsFromCache(cache) {
  const files = cache?.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return []
  return Object.values(files)
    .filter(isCachedRecord)
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    .reverse()
    .map(entry => entry.record)
}

/** Whether one cache entry is an object carrying an object-shaped record. */
function isCachedRecord(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
  const record = entry.record
  return record !== null && typeof record === 'object' && !Array.isArray(record)
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
 * @param options.onProgress - `({ done, total, path })` after a file is
 *   *decoded* — cached files are not work and are not reported. Calls are
 *   coalesced to one per {@link PROGRESS_MIN_INTERVAL_MS}, plus the last file.
 * @param options.onRecords - `(records, progress)` on the same coalesced ticks
 *   as `onProgress`, with everything reduced so far in the order the caller will
 *   get it at the end. A board can paint itself while a cold scan runs instead
 *   of showing a spinner for seconds; the newest logs are walked first, so the
 *   recent weeks are on screen almost immediately.
 * @param options.onWarning - `(message)` for a scan that finished short of the
 *   whole corpus: a log whose tail frame is still being written, logs dropped by
 *   {@link MAX_CACHED_FILES}, a link or a directory the walk refused to follow.
 *   Called at most once per condition, after the walk.
 * @param options.readFile - `readFileSync` override (tests).
 * @param options.writeFile - `writeFileSync` override (tests).
 * @param options.now - clock injection.
 * @param options.progressMinIntervalMs - override {@link PROGRESS_MIN_INTERVAL_MS}.
 * @param options.checkpointEvery - override {@link CHECKPOINT_EVERY_FILES}; `0`
 *   disables the mid-scan checkpoints.
 * @param options.maxFiles - override {@link MAX_CACHED_FILES} (tests).
 * @param options.maxDepth - override {@link MAX_WALK_DEPTH} (tests).
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
  const progressMinIntervalMs = options.progressMinIntervalMs ?? PROGRESS_MIN_INTERVAL_MS
  const checkpointEvery = options.checkpointEvery ?? CHECKPOINT_EVERY_FILES

  const listing = collectLogFiles(root, { maxFiles: options.maxFiles, maxDepth: options.maxDepth })
  const files = listing.files
  const nextFiles = {}
  const records = []
  let scanned = 0
  let reused = 0
  let resumedFiles = 0
  let failed = 0
  let failedFrames = 0
  let badLines = 0
  let aborted = false
  let lastProgressAt = 0
  let wrote = false

  /**
   * The cache document this run would write.
   *
   * `merge` keeps every entry the run has not reached yet. Without it an
   * interrupted rebuild (host restart, dispose, abort) replaced the cache with
   * the handful of files it had got through, so the next open decoded the whole
   * corpus again — the exact cost this module exists to avoid. The final
   * non-aborted write still prunes, so entries for deleted logs do not live on.
   */
  const documentFor = merge => ({
    version: CACHE_VERSION,
    builtAt: now,
    files: merge ? { ...cache.files, ...nextFiles } : nextFiles,
  })
  const checkpoint = () => writeCache(documentFor(true), { cachePath, writeFile: options.writeFile, env: options.env })

  for (const file of files) {
    if (options.signal?.aborted === true) {
      aborted = true
      break
    }
    const key = keyOf(root, file.path)
    const cached = cache.files[key]
    let decoded = false
    if (cached !== undefined && cached.size === file.size && cached.mtimeMs === file.mtimeMs && cached.record) {
      reused += 1
      nextFiles[key] = cached
      records.push(cached.record)
    } else {
      try {
        // The whole file is read (4 MB of it is a millisecond), but only the
        // frames a cache entry says are new get decoded: a log that was
        // appended to is finished from its cached prefix.
        const read = readSessionLog(readFile(file.path), { resume: cached })
        const record = read.record
        decoded = true
        scanned += 1
        if (read.resumed) resumedFiles += 1
        failedFrames += record.failedFrames ?? 0
        badLines += record.badLines ?? 0
        const entry = {
          size: file.size,
          mtimeMs: file.mtimeMs,
          record,
          carry: read.carry,
          done: read.done,
          tail: read.tail,
          stats: read.stats,
        }
        nextFiles[key] = entry
        records.push(record)
      } catch {
        // Unreadable file: skipped for this scan, retried next time.
        failed += 1
      }
    }
    const done = scanned + reused + failed
    if (decoded && (done === files.length || Date.now() - lastProgressAt >= progressMinIntervalMs)) {
      lastProgressAt = Date.now()
      const progress = { done, total: files.length, path: file.path }
      options.onProgress?.(progress)
      // Newest-first walk, so the reversal here matches the order of the final
      // `records` array: a caller can replace what it shows with each snapshot.
      options.onRecords?.([...records].reverse(), progress)
    }
    // A cached file is a map lookup: yielding for it (and reporting it) turned a
    // 20 ms scan into ~600 ms of event-loop round trips inside the TUI. Only
    // real work yields, so an up-to-date corpus finishes in a single turn.
    if (!decoded) continue
    await new Promise(resolve => {
      setImmediate(resolve)
    })
    if (checkpointEvery > 0 && scanned % checkpointEvery === 0) wrote = checkpoint() || wrote
  }

  const finalCache = documentFor(aborted)
  wrote = writeCache(finalCache, { cachePath, writeFile: options.writeFile, env: options.env }) || wrote
  records.reverse()

  const truncatedLogs = records.filter(record => record.truncated === true).length
  // A partial tail is the normal state of a log being appended to right now, but
  // it means this scan is missing that session's newest events; a corpus cut by
  // the cache cap or a refused link is missing history too. All of it is real,
  // so the caller gets told instead of the board quietly coming up short.
  if (truncatedLogs > 0) {
    options.onWarning?.(`${truncatedLogs} session log(s) end in an undecodable partial frame (still being appended to, or damaged); the next scan re-reads them`)
  }
  if (listing.dropped > 0) {
    options.onWarning?.(`${listing.dropped} session log(s) older than the newest ${files.length} were not scanned (cache cap)`)
  }
  if (listing.skippedLinks > 0) {
    options.onWarning?.(`${listing.skippedLinks} symbolic link(s) under the sessions root were not followed`)
  }
  if (listing.tooDeep > 0) {
    options.onWarning?.(`${listing.tooDeep} directories deeper than ${MAX_WALK_DEPTH} levels were not scanned`)
  }

  return {
    records,
    aborted,
    cache: finalCache,
    stats: {
      files: files.length,
      scanned,
      reused,
      resumedFiles,
      migratedFrom: cache.migratedFrom,
      failed,
      failedFrames,
      badLines,
      wrote,
      durationMs: Date.now() - startedAt,
      truncatedLogs,
      droppedFiles: listing.dropped,
      skippedLinks: listing.skippedLinks,
      tooDeep: listing.tooDeep,
      seededSessions: records.filter(record => record.seeded === true).length,
      subagentSessions: records.filter(record => record.subagent === true).length,
      events: records.reduce((sum, record) => sum + (record.events ?? 0), 0),
      skippedEvents: records.reduce((sum, record) => sum + (record.skipped ?? 0), 0),
    },
  }
}
