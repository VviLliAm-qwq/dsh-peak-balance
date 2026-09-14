import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  CACHE_MIGRATIONS,
  CACHE_VERSION,
  ZSTD_MAGIC,
  collectLogFiles,
  decodeLog,
  extractLogEvents,
  frameSize,
  historyCachePath,
  isSessionLogName,
  listLogFiles,
  parseCache,
  parseEvents,
  readCache,
  readSessionLog,
  recordFromBuffer,
  recordsFromCache,
  resumeOffsetOf,
  scanSessions,
  sessionsRoot,
  tailSignatureAt,
  writeCache,
} from '../lib/history-scan.js'

/** Compress one JSONL line as its own zstd frame. */
function frame(line) {
  return zstdCompressSync(Buffer.from(`${line}\n`))
}

/**
 * A hand-built single-segment zstd frame holding one raw block.
 *
 * `zstdCompressSync` will not deliberately emit the frame magic inside a block,
 * but a real multi-megabyte block can contain those four bytes by chance — and
 * that is the case a byte-scanning splitter gets wrong. Building the frame by
 * hand makes the regression test deterministic.
 */
function rawFrame(payload) {
  const size = payload.length
  const header = Buffer.from([(1 | (0 << 1) | (size << 3)) & 0xff, ((size << 3) >> 8) & 0xff, ((size << 3) >> 16) & 0xff])
  return Buffer.concat([ZSTD_MAGIC, Buffer.from([0x20]), Buffer.from([size & 0xff]), header, payload])
}

/** A stored log built from one frame per line (objects are serialized). */
function logBuffer(lines) {
  return Buffer.concat(lines.map(line => frame(typeof line === 'string' ? line : JSON.stringify(line))))
}

const SESSION = { type: 'session', id: 's1', createdAt: Date.UTC(2026, 8, 7, 4, 0, 0), delegationDepth: 0 }
const HEADER = { type: 'request/header', seq: 0, time: Date.UTC(2026, 8, 7, 4, 0, 0), data: { header: { config: { model: 'deepseek-flash' } } } }
const USAGE = { type: 'assistant/message', seq: 1, time: Date.UTC(2026, 8, 7, 4, 0, 0), data: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 } } }

/** Create a temp sessions tree; returns `{ root, stateDir, cleanup }`. */
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pb-scan-'))
  const root = join(base, 'sessions')
  const stateDir = join(base, 'state')
  mkdirSync(join(root, '--work--', 's1'), { recursive: true })
  mkdirSync(join(root, '--work--', 's2'), { recursive: true })
  writeFileSync(join(root, '--work--', 's1', 'session.jsonl.zstd'), logBuffer([SESSION, HEADER, USAGE]))
  writeFileSync(
    join(root, '--work--', 's2', 'session.v3.jsonl.zstd'),
    logBuffer([{ ...SESSION, id: 's2' }, HEADER, { ...USAGE, data: { usage: { inputTokens: 7 } } }]),
  )
  writeFileSync(join(root, '--work--', 'notes.txt'), 'not a log')
  return {
    base,
    root,
    stateDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

test('paths derive from the environment', () => {
  assert.equal(historyCachePath({ DSH_TUI_STATE_DIR: '/tmp/state' }), join('/tmp/state', 'dsh-peak-balance-history.json'))
  assert.match(historyCachePath({}), /dsh-peak-balance-history\.json$/)
  assert.equal(sessionsRoot({ DSH_HOME: '/tmp/dsh' }), join('/tmp/dsh', 'sessions'))
  assert.match(sessionsRoot({}), /[\\/]\.dsh[\\/]sessions$/)
  assert.equal(isSessionLogName('session.jsonl.zstd'), true)
  assert.equal(isSessionLogName('session.v3.jsonl.zstd'), true)
  assert.equal(isSessionLogName('session.jsonl'), true)
  assert.equal(isSessionLogName('notes.txt'), false)
})

test('frameSize measures a frame exactly, magic bytes inside a block included', () => {
  const single = frame('{"a":1}')
  assert.equal(frameSize(single, 0), single.length)
  assert.equal(frameSize(Buffer.concat([single, frame('{"b":2}')]), 0), single.length)
  assert.equal(frameSize(single, 0) > 0, true)

  // Payload carrying the magic twice: a scanning splitter sees three "frames"
  // here and silently truncates the first one; the exact frame walk does not.
  const payload = Buffer.concat([Buffer.from('HEAD'), ZSTD_MAGIC, Buffer.from('MID'), ZSTD_MAGIC, Buffer.from('TAIL\n')])
  const crafted = rawFrame(payload)
  assert.equal(frameSize(crafted, 0), crafted.length)
  const combined = Buffer.concat([crafted, frame('{"real":1}')])
  const decoded = decodeLog(combined)
  assert.equal(decoded.frames, 2)
  assert.equal(decoded.failedFrames, 0)
  assert.equal(decoded.text, `${payload.toString('utf8')}{"real":1}\n`)
})

test('frameSize refuses truncated and foreign input', () => {
  assert.equal(frameSize(undefined, 0), undefined)
  assert.equal(frameSize(Buffer.alloc(0), 0), undefined)
  assert.equal(frameSize(Buffer.from('not zstd at all'), 0), undefined)
  const single = frame('{"a":1}')
  assert.equal(frameSize(single, 2), undefined)
  // A frame whose tail is missing is not a frame yet.
  assert.equal(frameSize(single.subarray(0, single.length - 4), 0), undefined)
  assert.equal(frameSize(single.subarray(0, 8), 0), undefined)
})

test('decodeLog reassembles every frame', () => {
  const buffer = logBuffer(['{"a":1}', '{"b":2}', '{"c":3}'])
  const decoded = decodeLog(buffer)
  assert.equal(decoded.frames, 3)
  assert.equal(decoded.failedFrames, 0)
  assert.equal(decoded.text, '{"a":1}\n{"b":2}\n{"c":3}\n')
  // A single frame still works (the common small-session case).
  assert.equal(decodeLog(frame('{"only":true}')).text, '{"only":true}\n')
})

test('decodeLog tolerates plaintext, empty, damaged and truncated input', () => {
  assert.equal(decodeLog(Buffer.from('{"plain":1}\n')).text, '{"plain":1}\n')
  assert.deepEqual(decodeLog(Buffer.alloc(0)), { text: '', frames: 0, failedFrames: 0, truncated: false })
  assert.equal(decodeLog(undefined).text, '')

  // A candidate split that is not a frame (a magic byte pair occurring inside
  // the stream) must never cost a complete frame: both real frames survive.
  const damaged = Buffer.concat([frame('{"a":1}'), ZSTD_MAGIC, Buffer.from([0, 1, 2, 3]), frame('{"b":2}')])
  const decoded = decodeLog(damaged)
  assert.equal(decoded.text.includes('{"a":1}'), true)
  assert.equal(decoded.text.includes('{"b":2}'), true)

  // A log being appended to right now can end in a partial frame. The complete
  // frames survive, the incomplete tail is reported (never guessed at), and a
  // later scan re-reads the file once its size changes.
  const truncated = Buffer.concat([frame('{"a":1}'), frame('{"complete":2}').subarray(0, 12)])
  const partial = decodeLog(truncated)
  assert.equal(partial.failedFrames, 1)
  assert.equal(partial.truncated, true)
  const { events, badLines } = parseEvents(partial.text)
  assert.deepEqual(events, [{ a: 1 }])
  assert.equal(badLines, 0)
})

test('parseEvents skips malformed and non-object lines', () => {
  const { events, badLines } = parseEvents('{"type":"session"}\n\nnot json\n[1,2]\nnull\n{"type":"turn/end"}')
  assert.deepEqual(events.map(event => event.type), ['session', 'turn/end'])
  // `not json`, the array and `null` are not event objects; blank lines are not
  // counted at all.
  assert.equal(badLines, 3)
  assert.deepEqual(parseEvents(undefined).events, [])
})

test('recordFromBuffer folds one stored log', () => {
  const record = recordFromBuffer(logBuffer([SESSION, HEADER, USAGE]))
  assert.equal(record.id, 's1')
  assert.equal(record.events, 1)
  assert.equal(record.failedFrames, 0)
  assert.equal(record.badLines, 0)
  assert.equal(record.models['deepseek-flash'].days['2026-09-07'].idle.input, 100)

  const noisy = recordFromBuffer(Buffer.concat([frame('{"type":"session","id":"x"}'), frame('garbage'), frame('{}')]))
  assert.equal(noisy.id, 'x')
  assert.equal(noisy.badLines, 1)
})

test('the filtered reading matches the reference one, minus the lines it never parses', () => {
  const later = USAGE.time + 60_000
  const buffer = logBuffer([
    SESSION,
    HEADER,
    USAGE,
    { type: 'tool/result', seq: 2, time: USAGE.time, data: { text: 'x'.repeat(500) } },
    'not json at all, and no marker either',
    { ...USAGE, seq: 3, time: later },
  ])
  const reference = recordFromBuffer(buffer)
  const filtered = readSessionLog(buffer).record
  // Every number the board reads is identical...
  for (const key of ['id', 'subagent', 'seeded', 'createdAt', 'lastTime', 'models', 'events', 'skipped', 'failedFrames', 'truncated']) {
    assert.deepEqual(filtered[key], reference[key])
  }
  assert.equal(filtered.events, 2)
  assert.equal(filtered.lastTime, later)
  // ...except the diagnostic, by design: the reference parses every line and so
  // counts garbage that cannot name an event, which the scan never looks at.
  assert.equal(reference.badLines, 1)
  assert.equal(filtered.badLines, 0)
  // A malformed line that *could* name an event is still counted.
  const broken = readSessionLog(logBuffer([SESSION, '{"type":"assistant/message", broken'])).record
  assert.equal(broken.badLines, 1)
})

test('extractLogEvents reports the frame boundary a resume would continue from', () => {
  const buffer = logBuffer([SESSION, HEADER, USAGE])
  const whole = extractLogEvents(buffer)
  assert.equal(whole.frames, 3)
  assert.equal(whole.events.length, 3)
  assert.equal(whole.done, buffer.length)
  assert.equal(whole.truncated, false)

  // A half-written trailing frame is reported, and never advances the point.
  const partial = extractLogEvents(Buffer.concat([buffer, frame(JSON.stringify(USAGE)).subarray(0, 10)]))
  assert.equal(partial.truncated, true)
  assert.equal(partial.failedFrames, 1)
  assert.equal(partial.done, buffer.length)

  // Reading from a resume point sees only what follows it.
  const grown = Buffer.concat([buffer, frame(JSON.stringify({ ...USAGE, seq: 4 }))])
  const tailOnly = extractLogEvents(grown, { start: buffer.length })
  assert.equal(tailOnly.events.length, 1)
  assert.equal(tailOnly.done, grown.length)

  // Plaintext logs have no frames: read whole, and never resumed.
  const plainText = '{"type":"session","id":"p"}\n'
  const plain = extractLogEvents(Buffer.from(plainText))
  assert.equal(plain.events.length, 1)
  assert.equal(plain.frames, 0)
  assert.equal(plain.done, plainText.length)

  assert.equal(tailSignatureAt(Buffer.from('abcdef'), 0), '')
  assert.equal(tailSignatureAt(Buffer.from('abcdef'), 6), Buffer.from('abcdef').toString('base64'))
  assert.equal(tailSignatureAt(Buffer.from('abcdef'), 99), undefined)
})

test('a log that only grew is finished from its cached prefix', () => {
  const first = logBuffer([SESSION, HEADER, USAGE])
  const entry = readSessionLog(first)
  assert.equal(entry.resumed, false)
  assert.equal(entry.done, first.length)
  assert.equal(entry.tail, tailSignatureAt(first, first.length))
  assert.equal(entry.record.events, 1)

  const grown = Buffer.concat([first, frame(JSON.stringify({ ...USAGE, seq: 4, time: USAGE.time + 60_000 }))])
  assert.equal(resumeOffsetOf(grown, entry), first.length)
  const resumed = readSessionLog(grown, { resume: entry })
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.done, grown.length)
  // Continuing a prefix has to land on exactly what a full read produces.
  assert.deepEqual(resumed.record, recordFromBuffer(grown))
  assert.equal(resumed.record.events, 2)
  // The cached record is not folded into in place: a scan that discards this
  // entry must not leave a half-updated record behind.
  assert.equal(entry.record.events, 1)

  // Nothing to continue from, or a prefix that was rewritten instead of
  // appended to, or a file that shrank: all read whole again.
  assert.equal(resumeOffsetOf(grown, undefined), undefined)
  assert.equal(resumeOffsetOf(grown, { record: entry.record, done: 10, tail: '' }), undefined)
  assert.equal(resumeOffsetOf(grown, { ...entry, carry: undefined }), undefined)
  assert.equal(resumeOffsetOf(grown, { ...entry, done: 0 }), undefined)
  assert.equal(resumeOffsetOf(grown, { ...entry, done: grown.length + 10 }), undefined)
  // A hand-edited document must not get as far as folding into a non-record.
  assert.equal(resumeOffsetOf(grown, { ...entry, record: 7 }), undefined)
  assert.equal(resumeOffsetOf(grown, { ...entry, record: [] }), undefined)
  const tampered = Buffer.from(grown)
  tampered[tampered.length - 1] ^= 0xff
  assert.equal(resumeOffsetOf(tampered, { ...entry, done: grown.length - 1 }), undefined)
  const shrunk = readSessionLog(first.subarray(0, first.length - 5), { resume: entry })
  assert.equal(shrunk.resumed, false)
})

test('a fork-seeded log continues under the same cut', () => {
  const header = { type: 'session', id: 'child', createdAt: USAGE.time, seedLength: 4 }
  const buffer = logBuffer([
    header,
    HEADER,
    { ...USAGE, seq: 1 },
    { ...USAGE, seq: 3 },
    { ...USAGE, seq: 4, time: USAGE.time + 1000 },
  ])
  const entry = readSessionLog(buffer)
  assert.equal(entry.record.events, 1)
  assert.equal(entry.record.skipped, 2)

  const grown = Buffer.concat([buffer, frame(JSON.stringify({ ...USAGE, seq: 5, time: USAGE.time + 2000 }))])
  const resumed = readSessionLog(grown, { resume: entry })
  assert.equal(resumed.resumed, true)
  assert.deepEqual(resumed.record, recordFromBuffer(grown))
  assert.equal(resumed.record.events, 2)
  assert.equal(resumed.record.skipped, 2)

  // The legacy header (`isSeeded` with no `seedLength`) leaves the cut resolved
  // by a marker that may still arrive, so such a log is never continued.
  const legacy = logBuffer([{ ...SESSION, isSeeded: true }, HEADER, USAGE])
  const legacyEntry = readSessionLog(legacy)
  assert.equal(legacyEntry.carry.seedUnresolved, true)
  assert.equal(resumeOffsetOf(Buffer.concat([legacy, frame(JSON.stringify(USAGE))]), legacyEntry), undefined)

  // That cut marker has to survive the line filter too: `session/end-seed` is
  // reached by an exact type test only because {@link RELEVANT_TYPES} names it.
  const marked = logBuffer([
    { ...SESSION, isSeeded: true },
    HEADER,
    { ...USAGE, seq: 1 },
    { type: 'session/end-seed', seq: 2 },
    { ...USAGE, seq: 3, time: USAGE.time + 1000 },
  ])
  const markedRecord = readSessionLog(marked).record
  assert.equal(markedRecord.seeded, true)
  assert.equal(markedRecord.events, 1)
  assert.equal(markedRecord.skipped, 1)
  assert.deepEqual(markedRecord, recordFromBuffer(marked))
})

test('a line that does not open with its type is still read', () => {
  // Anything the host writes opens with `type`, but a hand-edited or foreign log
  // need not: the marker scan behind the prefix test catches it either way.
  const odd = JSON.stringify({ seq: 5, time: USAGE.time, type: 'assistant/message', data: { usage: { inputTokens: 3 } } })
  const buffer = logBuffer([SESSION, HEADER, odd])
  const record = readSessionLog(buffer).record
  assert.equal(record.events, 1)
  assert.deepEqual(record, recordFromBuffer(buffer))
})

test('listLogFiles walks nested directories newest first and ignores other files', () => {
  const tree = makeTree()
  try {
    const files = listLogFiles(tree.root)
    assert.equal(files.length, 2)
    for (const file of files) {
      assert.equal(isSessionLogName(file.path.split(/[\\/]/).pop()), true)
      assert.equal(typeof file.size, 'number')
      assert.equal(typeof file.mtimeMs, 'number')
    }
    assert.ok(files[0].mtimeMs >= files[1].mtimeMs)
    assert.deepEqual(listLogFiles(join(tree.base, 'missing')), [])
  } finally {
    tree.cleanup()
  }
})

test('scanSessions reuses the incremental cache and rescans only changed files', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    const progress = []
    const first = await scanSessions({ root: tree.root, cachePath, onProgress: step => progress.push(step) })
    assert.equal(first.stats.files, 2)
    assert.equal(first.stats.scanned, 2)
    assert.equal(first.stats.reused, 0)
    assert.equal(first.stats.wrote, true)
    assert.equal(first.stats.events, 2)
    assert.equal(first.records.length, 2)
    assert.equal(progress.length, 2)
    assert.equal(progress[0].total, 2)
    assert.equal(first.stats.durationMs >= 0, true)

    const second = await scanSessions({ root: tree.root, cachePath })
    assert.equal(second.stats.scanned, 0)
    assert.equal(second.stats.reused, 2)
    assert.equal(second.cache.builtAt > 0, true)

    // Appending one frame makes exactly one file dirty (size changes even when
    // the filesystem timestamp resolution would not).
    const target = join(tree.root, '--work--', 's1', 'session.jsonl.zstd')
    writeFileSync(target, Buffer.concat([readFileSync(target), frame(JSON.stringify({ ...USAGE, seq: 2 }))]))
    const third = await scanSessions({ root: tree.root, cachePath })
    assert.equal(third.stats.scanned, 1)
    assert.equal(third.stats.reused, 1)
    assert.equal(third.stats.events, 3)

    // A new file is picked up without touching the cached ones.
    writeFileSync(join(tree.root, '--work--', 's2', 'session.fork.jsonl.zstd'), logBuffer([{ ...SESSION, id: 's3' }, HEADER, USAGE]))
    const fourth = await scanSessions({ root: tree.root, cachePath })
    assert.equal(fourth.stats.files, 3)
    assert.equal(fourth.stats.scanned, 1)
    assert.equal(fourth.stats.reused, 2)
  } finally {
    tree.cleanup()
  }
})

test('the scan continues an appended log instead of re-reading it', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    const first = await scanSessions({ root: tree.root, cachePath })
    assert.equal(first.stats.resumedFiles, 0)

    // Appending to a log leaves its prefix cached, so the rescan decodes the new
    // frames only — and has to land on the same record a full read would.
    const target = join(tree.root, '--work--', 's1', 'session.jsonl.zstd')
    const grown = Buffer.concat([readFileSync(target), frame(JSON.stringify({ ...USAGE, seq: 2, time: USAGE.time + 60_000 }))])
    writeFileSync(target, grown)
    const again = await scanSessions({ root: tree.root, cachePath })
    assert.equal(again.stats.scanned, 1)
    assert.equal(again.stats.reused, 1)
    assert.equal(again.stats.resumedFiles, 1)
    const grownRecord = again.records.find(record => record.id === 's1')
    assert.deepEqual(grownRecord, recordFromBuffer(grown))
    assert.equal(grownRecord.events, 2)

    // The entry a resumed read writes is itself resumable again.
    const entry = readCache({ cachePath }).files['--work--/s1/session.jsonl.zstd']
    assert.equal(entry.done, grown.length)
    assert.equal(entry.tail, tailSignatureAt(grown, grown.length))
  } finally {
    tree.cleanup()
  }
})

test('a cache written by the previous version is migrated instead of rescanned', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    const first = await scanSessions({ root: tree.root, cachePath })

    // Rewrite the document the way v3 wrote one: same records, no resume point.
    const document = JSON.parse(readFileSync(cachePath, 'utf8'))
    for (const entry of Object.values(document.files)) {
      delete entry.done
      delete entry.tail
      delete entry.carry
      delete entry.stats
    }
    document.version = 3
    writeFileSync(cachePath, JSON.stringify(document))

    const again = await scanSessions({ root: tree.root, cachePath })
    assert.equal(again.stats.migratedFrom, 3)
    // Migrated, not discarded: a plugin update must not cost a corpus rebuild.
    assert.equal(again.stats.reused, 2)
    assert.equal(again.stats.scanned, 0)
    assert.equal(again.stats.events, first.stats.events)
    // The migrated entries still hold their records...
    assert.equal(recordsFromCache(readCache({ cachePath })).length, 2)
    // ...but no resume point, so the first append re-reads the log and earns one.
    assert.equal(readCache({ cachePath }).files['--work--/s1/session.jsonl.zstd'].done, undefined)
  } finally {
    tree.cleanup()
  }
})

test('a cold scan reports what it has reduced so far, a cached one does not', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    const snapshots = []
    const first = await scanSessions({
      root: tree.root,
      cachePath,
      onRecords: (records, progress) => snapshots.push({ records, progress }),
    })
    // One snapshot per decoded file, the last of which is what the caller is
    // about to receive anyway — a board can paint itself while the scan runs.
    assert.equal(snapshots.length, 2)
    assert.equal(snapshots[0].records.length, 1)
    assert.equal(snapshots[1].records.length, 2)
    assert.equal(snapshots[1].progress.total, 2)
    assert.deepEqual(snapshots.at(-1).records.map(record => record.id), first.records.map(record => record.id))

    // Nothing decoded, nothing to report: the scan that finds a fresh cache does
    // not repaint a board it has no news for.
    const quiet = []
    await scanSessions({ root: tree.root, cachePath, onRecords: records => quiet.push(records) })
    assert.deepEqual(quiet, [])
  } finally {
    tree.cleanup()
  }
})

test('a corrupt or foreign cache degrades to a full rescan', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    mkdirSync(tree.stateDir, { recursive: true })
    writeFileSync(cachePath, '{ this is not json')
    assert.deepEqual(readCache({ cachePath }).files, {})
    const scan = await scanSessions({ root: tree.root, cachePath })
    assert.equal(scan.stats.scanned, 2)

    writeFileSync(cachePath, JSON.stringify({ version: 999, files: { x: 1 } }))
    assert.deepEqual(parseCache(readFileSync(cachePath, 'utf8')).files, {})
    writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, files: null }))
    assert.deepEqual(parseCache(readFileSync(cachePath, 'utf8')).files, {})
  } finally {
    tree.cleanup()
  }
})

test('a missing sessions root scans as empty without throwing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-pb-missing-'))
  try {
    const cachePath = join(base, 'state', 'cache.json')
    const scan = await scanSessions({ root: join(base, 'nope'), cachePath })
    assert.deepEqual(scan.records, [])
    assert.equal(scan.stats.files, 0)
    assert.equal(scan.stats.wrote, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('an aborted scan stops between files and reports the abort', async () => {
  const tree = makeTree()
  try {
    const controller = new AbortController()
    controller.abort()
    const scan = await scanSessions({
      root: tree.root,
      cachePath: historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir }),
      signal: controller.signal,
    })
    assert.equal(scan.aborted, true)
    assert.deepEqual(scan.records, [])
    assert.equal(scan.stats.scanned, 0)
  } finally {
    tree.cleanup()
  }
})

test('a fully cached scan reports no progress and decodes nothing', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    await scanSessions({ root: tree.root, cachePath })

    const progress = []
    const again = await scanSessions({ root: tree.root, cachePath, onProgress: step => progress.push(step) })
    assert.equal(again.stats.reused, 2)
    assert.equal(again.stats.scanned, 0)
    // Nothing was decoded, so there is no work to report. A tick per file here
    // is what turned a 20 ms scan into ~600 ms inside the TUI: every tick
    // re-rendered the whole `/hist` grid.
    assert.deepEqual(progress, [])
  } finally {
    tree.cleanup()
  }
})

test('an interrupted rebuild keeps the cache entries it never reached', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    await scanSessions({ root: tree.root, cachePath })

    const controller = new AbortController()
    controller.abort()
    const aborted = await scanSessions({ root: tree.root, cachePath, signal: controller.signal })
    assert.equal(aborted.aborted, true)
    assert.equal(aborted.stats.scanned, 0)
    // The aborted run visited no file at all, so the previous scan's work must
    // still be there — writing only what this run touched would discard it.
    assert.equal(Object.keys(readCache({ cachePath }).files).length, 2)
  } finally {
    tree.cleanup()
  }
})

test('a long rebuild checkpoints the cache so a restart resumes it', async () => {
  const tree = makeTree()
  try {
    const documents = []
    const scan = await scanSessions({
      root: tree.root,
      cachePath: join(tree.stateDir, 'cache.json'),
      checkpointEvery: 1,
      writeFile: (file, text) => documents.push(JSON.parse(text)),
    })
    assert.equal(scan.stats.scanned, 2)
    // One checkpoint per decoded file, then the final prune: the file on disk
    // is never missing the records an interrupted run already paid for.
    assert.equal(documents.length, 3)
    assert.equal(Object.keys(documents[0].files).length, 1)
    assert.equal(Object.keys(documents[1].files).length, 2)
    assert.equal(Object.keys(documents.at(-1).files).length, 2)
  } finally {
    tree.cleanup()
  }
})

test('recordsFromCache restores the scan order and skips unusable entries', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    const scan = await scanSessions({ root: tree.root, cachePath })
    const records = recordsFromCache(readCache({ cachePath }))
    assert.deepEqual(records.map(record => record.id), scan.records.map(record => record.id))

    // A hand-edited or future document must not smuggle a shape the view reads.
    assert.deepEqual(recordsFromCache({ files: { a: { size: 1 }, b: null } }), [])
    assert.deepEqual(recordsFromCache(undefined), [])
    assert.deepEqual(recordsFromCache({ files: null }), [])
    // `typeof [] === 'object'`, so an array document must be refused too.
    assert.deepEqual(recordsFromCache({ files: [{ record: { id: 'x' } }] }), [])
    // Only an object-shaped record is trusted; a number or a string is not.
    assert.deepEqual(recordsFromCache({ files: { a: { record: 7 }, b: { record: 'x' }, c: { record: [] } } }), [])
    const real = { id: 'ok', models: {} }
    assert.deepEqual(recordsFromCache({ files: { d: { mtimeMs: 1, record: real } } }), [real])
  } finally {
    tree.cleanup()
  }
})

test('a cache document whose shape is wrong is refused, not spread', () => {
  assert.deepEqual(parseCache(JSON.stringify({ version: CACHE_VERSION, files: [1, 2] })).files, {})
  assert.deepEqual(parseCache(JSON.stringify({ version: CACHE_VERSION, files: 'nope' })).files, {})
  assert.deepEqual(parseCache(JSON.stringify([1, 2])).files, {})
  assert.deepEqual(parseCache('null').files, {})
})

test('collectLogFiles reports the logs a cap or the walk left out', () => {
  const tree = makeTree()
  try {
    assert.equal(listLogFiles(tree.root).length, 2)
    const capped = collectLogFiles(tree.root, { maxFiles: 1 })
    assert.equal(capped.files.length, 1)
    assert.equal(capped.dropped, 1)
    assert.equal(capped.skippedLinks, 0)
    assert.equal(capped.tooDeep, 0)

    // A nesting cap refuses to descend rather than looping on a link-like tree.
    const shallow = collectLogFiles(tree.root, { maxDepth: 0 })
    assert.equal(shallow.files.length, 0)
    assert.equal(shallow.tooDeep, 1)
  } finally {
    tree.cleanup()
  }
})

test('a linked log is counted as skipped instead of silently ignored', () => {
  const tree = makeTree()
  try {
    const link = join(tree.root, '--work--', 'session.linked.jsonl.zstd')
    try {
      // Windows only allows this with Developer Mode or elevation; where it is
      // not allowed the guard below is simply not exercised.
      symlinkSync(join(tree.root, '--work--', 's1', 'session.jsonl.zstd'), link)
    } catch {
      return
    }
    const listing = collectLogFiles(tree.root)
    assert.equal(listing.skippedLinks, 1)
    assert.equal(listing.files.length, 2)
  } finally {
    tree.cleanup()
  }
})

test('a log whose tail frame is incomplete is reported instead of quietly short', async () => {
  const tree = makeTree()
  try {
    const cachePath = historyCachePath({ DSH_TUI_STATE_DIR: tree.stateDir })
    await scanSessions({ root: tree.root, cachePath })

    // A real log being appended to: the last frame is only half written.
    const target = join(tree.root, '--work--', 's1', 'session.jsonl.zstd')
    const partial = frame('{"type":"assistant/message","seq":9,"data":{"usage":{"inputTokens":3}}}')
    writeFileSync(target, Buffer.concat([readFileSync(target), partial.subarray(0, 12)]))

    const warnings = []
    const scan = await scanSessions({ root: tree.root, cachePath, onWarning: message => warnings.push(message) })
    assert.equal(scan.stats.scanned, 1)
    assert.equal(scan.stats.reused, 1)
    assert.equal(scan.stats.truncatedLogs, 1)
    const truncated = scan.records.find(record => record.truncated === true)
    assert.equal(truncated.id, 's1')
    // The complete frames still made it into the record.
    assert.equal(truncated.events, 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /partial frame/)

    // A corpus cut by the cache cap says so too, instead of shortening history
    // without a word.
    const capped = []
    const limited = await scanSessions({
      root: tree.root,
      cachePath: join(tree.stateDir, 'other.json'),
      maxFiles: 1,
      onWarning: message => capped.push(message),
    })
    assert.equal(limited.stats.files, 1)
    assert.equal(limited.stats.droppedFiles, 1)
    // The truncated log warns here too (same corpus), so assert on the cap
    // message itself rather than on the total call count.
    assert.equal(capped.filter(message => /not scanned \(cache cap\)/.test(message)).length, 1)
  } finally {
    tree.cleanup()
  }
})

test('writeCache reports an unwritable path instead of throwing', () => {
  const wrote = writeCache({ version: CACHE_VERSION, files: {} }, {
    cachePath: join(tmpdir(), 'dsh-pb-definitely-missing', '\u0000bad', 'cache.json'),
  })
  assert.equal(wrote, false)
})
