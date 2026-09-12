import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { FOCUS_FILE, FOCUS_POLL_MS, createMarkerWatcher, focusFilePath, readFocusMarker } from '../lib/focus.js'
import { CLEARED_FOCUS_FIXTURE, FIXTURE_SESSION_ID, FOCUS_FIXTURE } from '../test-support/harness.js'

test('the marker is the launcher file, overridable for tests', () => {
  assert.equal(FOCUS_FILE, join(homedir(), '.dsh-tui', 'resume.txt'))
  assert.equal(focusFilePath({}), FOCUS_FILE)
  assert.equal(focusFilePath({ DSH_PEAK_BALANCE_FOCUS_FILE: '' }), FOCUS_FILE)
  assert.equal(focusFilePath({ DSH_PEAK_BALANCE_FOCUS_FILE: 'C:/tmp/marker.txt' }), 'C:/tmp/marker.txt')
  // The fallback must not outrun the seam it stands in for, nor spin.
  assert.ok(FOCUS_POLL_MS > 0 && FOCUS_POLL_MS <= 5_000)
})

test('a named session is read and trimmed', () => {
  const read = content => readFocusMarker({ file: 'marker', readFile: () => content })
  // `mtimeMs` stays in the shape (undefined here: the injected reader has no
  // file behind it) so callers can rely on the same keys everywhere.
  assert.deepEqual(read('session-abc'), { state: 'focused', id: 'session-abc', raw: 'session-abc', mtimeMs: undefined })
  assert.deepEqual(read('  session-abc\n'), {
    state: 'focused',
    id: 'session-abc',
    raw: 'session-abc',
    mtimeMs: undefined,
  })
  assert.deepEqual(read('session-abc\r\n'), {
    state: 'focused',
    id: 'session-abc',
    raw: 'session-abc',
    mtimeMs: undefined,
  })
})

test('an emptied marker is "cleared", an unreadable one is "absent"', () => {
  const read = content => readFocusMarker({ file: 'marker', readFile: () => content })
  // The host clears the marker on /new (and when a session it cannot resume
  // exits): the focused conversation is gone, and that is information rather
  // than silence.
  assert.deepEqual(read(''), { state: 'cleared', raw: '', mtimeMs: undefined })
  assert.deepEqual(read('\n  \n'), { state: 'cleared', raw: '', mtimeMs: undefined })
  // Malformed or unreadable content carries no information at all.
  assert.deepEqual(read(42), { state: 'absent' })
  assert.deepEqual(readFocusMarker({ file: 'marker', readFile: () => { throw new Error('ENOENT') } }), {
    state: 'absent',
  })
})

test('the committed fixtures read as absent, focused and cleared', () => {
  assert.deepEqual(readFocusMarker({ file: join(homedir(), '.dsh-tui', 'no-such-marker-file.txt') }), {
    state: 'absent',
  })
  const focused = readFocusMarker({ file: FOCUS_FIXTURE })
  assert.equal(focused.state, 'focused')
  assert.equal(focused.id, FIXTURE_SESSION_ID)
  assert.ok(Number.isFinite(focused.mtimeMs), 'a real file carries its write instant')

  const cleared = readFocusMarker({ file: CLEARED_FOCUS_FIXTURE })
  assert.equal(cleared.state, 'cleared')
  assert.ok(Number.isFinite(cleared.mtimeMs))
})

test('the marker watcher applies a reading once, and a rewrite again', () => {
  const changed = createMarkerWatcher()
  const reading = { state: 'focused', id: 'a', raw: 'a', mtimeMs: 1 }
  assert.equal(changed(reading), true)
  assert.equal(changed({ ...reading }), false, 'the same reading polled again is not news')
  // A rewrite with identical content is still a new statement: `/new` twice
  // in a row writes the same empty string, and the second one matters.
  assert.equal(changed({ ...reading, mtimeMs: 2 }), true)
  // A different conversation.
  assert.equal(changed({ state: 'focused', id: 'b', raw: 'b', mtimeMs: 2 }), true)
  assert.equal(changed({ state: 'focused', id: 'b', raw: 'b', mtimeMs: 2 }), false)
  // Absence is silence, and only counts as news once.
  assert.equal(changed({ state: 'absent' }), true)
  assert.equal(changed({ state: 'absent' }), false)
})

test('readings without a stat still detect a change, and only a change', () => {
  const changed = createMarkerWatcher()
  // A reader with no file behind it (tests, exotic hosts): content is the key.
  assert.equal(changed({ state: 'cleared', raw: '', mtimeMs: undefined }), true)
  assert.equal(changed({ state: 'cleared', raw: '', mtimeMs: undefined }), false)
  assert.equal(changed({ state: 'focused', id: 'a', raw: 'a', mtimeMs: undefined }), true)
  assert.equal(changed({ state: 'focused', id: 'a', raw: 'a', mtimeMs: undefined }), false)
})
