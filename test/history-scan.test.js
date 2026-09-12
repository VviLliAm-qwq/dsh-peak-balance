import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  CACHE_VERSION,
  ZSTD_MAGIC,
  decodeLog,
  frameSize,
  historyCachePath,
  isSessionLogName,
  listLogFiles,
  parseCache,
  parseEvents,
  readCache,
  recordFromBuffer,
  scanSessions,
  sessionsRoot,
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

test('writeCache reports an unwritable path instead of throwing', () => {
  const wrote = writeCache({ version: CACHE_VERSION, files: {} }, {
    cachePath: join(tmpdir(), 'dsh-pb-definitely-missing', '\u0000bad', 'cache.json'),
  })
  assert.equal(wrote, false)
})
