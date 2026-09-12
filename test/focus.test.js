import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { FOCUS_FILE, FOCUS_POLL_MS, focusFilePath, readFocusMarker } from '../lib/focus.js'
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
  assert.deepEqual(read('session-abc'), { state: 'focused', id: 'session-abc' })
  assert.deepEqual(read('  session-abc\n'), { state: 'focused', id: 'session-abc' })
  assert.deepEqual(read('session-abc\r\n'), { state: 'focused', id: 'session-abc' })
})

test('an emptied marker is "cleared", an unreadable one is "absent"', () => {
  const read = content => readFocusMarker({ file: 'marker', readFile: () => content })
  // The host clears the marker on /new: the focused conversation is gone, and
  // that is information rather than silence.
  assert.deepEqual(read(''), { state: 'cleared' })
  assert.deepEqual(read('\n  \n'), { state: 'cleared' })
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
  assert.deepEqual(readFocusMarker({ file: FOCUS_FIXTURE }), { state: 'focused', id: FIXTURE_SESSION_ID })
  assert.deepEqual(readFocusMarker({ file: CLEARED_FOCUS_FIXTURE }), { state: 'cleared' })
})
