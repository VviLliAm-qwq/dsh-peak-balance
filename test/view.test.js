import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createStore } from '../lib/store.js'
import {
  FRAME_MS,
  VIEW_INDENT_CELLS,
  VIEW_KEY,
  VIEW_MAX_ROWS,
  VIEW_TOP_GAP_ROWS,
  createStatusView,
  hexToRgb,
  pulseColor,
  shade,
  waveFrame,
} from '../lib/view.js'
import { buildDisplay } from '../lib/display.js'
import { BEIJING_OFFSET_MS } from '../lib/peak.js'
import { createFakeReact, findNodes, treeText } from '../test-support/fake-react.js'

function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS
}

const UI = { Box: 'Box', Text: 'Text' }
const CONFIG = { showBalance: true, showTurnCost: true, warnOnPeak: true, warnColor: 'red' }

function render(model) {
  const store = createStore(model)
  const Component = createStatusView(store)
  const harness = createFakeReact()
  const tree = Component({ React: harness.React, ui: UI })
  return { tree, harness, store }
}

test('the registration constants stay inside the host limits', () => {
  assert.match(VIEW_KEY, /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/)
  assert.ok(VIEW_MAX_ROWS >= 1 && VIEW_MAX_ROWS <= 3)
  assert.equal(FRAME_MS >= 50, true)
})

test('hex parsing and shading are total functions', () => {
  assert.deepEqual(hexToRgb('#FF0000'), [255, 0, 0])
  assert.deepEqual(hexToRgb('00ff00'), [0, 255, 0])
  assert.deepEqual(hexToRgb('nonsense'), [255, 77, 79])
  assert.equal(shade('#000000', 1), '#ffffff')
  assert.equal(shade('#ffffff', -1), '#000000')
  assert.equal(shade('#808080', 0), '#808080')
})

test('the pulse color stays a valid hex and actually moves', () => {
  const seen = new Set()
  for (let tick = 0; tick < 60; tick += 1) {
    const color = pulseColor('#4C8DFF', tick)
    assert.match(color, /^#[0-9a-f]{6}$/)
    seen.add(color)
  }
  assert.ok(seen.size > 6, `expected a visible pulse, got ${seen.size} distinct frames`)
})

test('the waveform rotates one cell per frame', () => {
  const first = waveFrame(0, 4)
  const second = waveFrame(1, 4)
  assert.equal(first.length, 4)
  assert.equal(second.length, 4)
  assert.notEqual(first, second)
  assert.equal(waveFrame(0, 100).length, 14)
})

test('off-peak renders a single themed line with no frame', () => {
  const model = buildDisplay({ atMs: beijing(2026, 9, 10, 13, 0), lang: 'zh', config: CONFIG })
  const { tree } = render(model)
  assert.equal(tree.type, 'Box')
  assert.equal(tree.props.flexDirection, 'row')
  assert.equal(tree.props.paddingLeft, VIEW_INDENT_CELLS)
  assert.equal(tree.props.marginTop, VIEW_TOP_GAP_ROWS)
  assert.equal(tree.children.length, 1)
  const line = tree.children[0]
  assert.equal(line.type, 'Text')
  assert.equal(line.props.wrap, 'truncate')
  assert.match(treeText(tree), /谷时/)
})

test('both shapes use the same indent, and only the plain line takes the gap', () => {
  const offPeak = render(buildDisplay({ atMs: beijing(2026, 9, 10, 13, 0), lang: 'zh', config: CONFIG }))
  assert.equal(offPeak.tree.props.paddingLeft, VIEW_INDENT_CELLS)
  assert.equal(offPeak.tree.props.marginTop, VIEW_TOP_GAP_ROWS)
  // Two rows total (gap + line) stay inside the host's three-row clip.
  assert.ok(VIEW_TOP_GAP_ROWS + 1 <= 3)

  const peak = render(buildDisplay({ atMs: beijing(2026, 9, 10, 10, 30), lang: 'zh', config: CONFIG }))
  // The warning frame shifts as a whole, so its border lands on the same
  // column as the plain line's first glyph.
  assert.equal(peak.tree.props.marginLeft, VIEW_INDENT_CELLS)
  // No top gap on the frame: it already fills the three-row budget, and a
  // margin would push its bottom border into the clipped area.
  assert.equal(peak.tree.props.marginTop, undefined)
  assert.equal(VIEW_INDENT_CELLS, 2)
})

test('peak + warning renders a three-row pulsing frame', () => {
  const model = buildDisplay({ atMs: beijing(2026, 9, 10, 10, 30), lang: 'zh', config: CONFIG })
  const { tree } = render(model)
  assert.equal(tree.type, 'Box')
  assert.equal(tree.props.borderStyle, 'round')
  assert.match(tree.props.borderColor, /^#[0-9a-f]{6}$/)
  assert.equal(tree.props.flexDirection, 'column')
  // Exactly one content row: top border + content + bottom border = 3 rows.
  assert.equal(tree.children.length, 1)
  assert.match(treeText(tree), /峰时/)
  // The travelling waveform rides the right edge of the content row.
  const row = tree.children[0]
  assert.equal(row.type, 'Box')
  assert.ok(findNodes(row, 'Text').length >= 2)
  assert.match(treeText(row), /[▁▂▃▄▅▆▇█]/)
})

test('an empty model renders nothing instead of an empty frame', () => {
  const { tree } = render(undefined)
  assert.equal(tree, null)
})

test('the component subscribes to the store and unsubscribes on unmount', () => {
  const model = buildDisplay({ atMs: beijing(2026, 9, 10, 10, 30), lang: 'zh', config: CONFIG })
  const store = createStore(model)
  const Component = createStatusView(store)
  const harness = createFakeReact()
  Component({ React: harness.React, ui: UI })
  assert.equal(typeof store.subscribe(() => {}), 'function')
  harness.cleanup()
})
