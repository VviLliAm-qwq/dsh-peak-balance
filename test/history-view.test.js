import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildHistoryView, foldSessionEvents } from '../lib/history.js'
import { createStore } from '../lib/store.js'
import {
  FLASH_MS,
  GRID_SCALES,
  cellColor,
  charWidth,
  clipWidth,
  createHistoryScene,
  displayWidth,
  metricLabel,
  monthLabelOf,
  resolveScale,
  windowStartFor,
} from '../lib/history-view.js'
import { createFakeReact, findNodes, treeText } from '../test-support/fake-react.js'

/** 2026-09-07 12:00 Beijing — a Monday, off-peak. */
const MONDAY_NOON = Date.UTC(2026, 8, 7, 4, 0, 0)

/** One session record with a single usage report on {@link MONDAY_NOON}. */
function record(id, usage, options = {}) {
  const header = { type: 'session', id, createdAt: MONDAY_NOON }
  if (options.subagent === true) header.origin = 'subagent'
  return foldSessionEvents([
    header,
    { type: 'request/header', seq: 0, time: MONDAY_NOON, data: { header: { config: { model: options.model ?? 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 1, time: MONDAY_NOON, data: { usage } },
  ])
}

/** A synthetic host ui kit that captures the input handler. */
function makeUi(options = {}) {
  const captured = { input: undefined, theme: options.theme ?? { accent: '#4C8DFF' } }
  return {
    captured,
    ui: {
      Box: 'Box',
      Text: 'Text',
      useInput(handler) {
        captured.input = handler
      },
      useTerminalSize: () => options.size ?? { columns: 120, rows: 32 },
      useTheme: () => captured.theme,
    },
  }
}

const DEFAULT_CONFIG = {
  historyMetric: 'tokens',
  historySpanWeeks: '13',
  historyWeekStart: 'mon',
  historyColorScale: 'github',
  historyLayout: 'card',
  historyHoverTokens: true,
  historyHoverCost: true,
  historyHoverCacheHit: true,
  historyHoverModels: true,
  historyIncludeSubagents: true,
}

/** Render the scene and return the tree plus its handles. */
function render(options = {}) {
  const records = options.records ?? [record('a', { inputTokens: 1_000_000, outputTokens: 2_000, cacheReadTokens: 500_000 })]
  const view = buildHistoryView(records, {
    now: options.now ?? MONDAY_NOON,
    spanWeeks: options.spanWeeks ?? 13,
    weekStart: options.weekStart ?? 'mon',
    metric: options.metric ?? 'tokens',
    includeSubagents: options.includeSubagents ?? true,
    customRates: options.customRates ?? {},
  })
  const store = createStore({
    status: options.status ?? 'ready',
    view: options.view === undefined ? view : options.view,
    scannedAt: MONDAY_NOON,
    progress: options.progress,
    error: options.error,
  })
  const calls = []
  const actions = {
    rescan: () => calls.push('rescan'),
    cycleMetric: () => calls.push('cycleMetric'),
    cycleSpan: () => calls.push('cycleSpan'),
    toggleSubagents: () => calls.push('toggleSubagents'),
  }
  const config = { ...DEFAULT_CONFIG, ...options.config }
  if (options.includeSubagents !== undefined) config.historyIncludeSubagents = options.includeSubagents
  const scene = createHistoryScene({
    store,
    getConfig: () => config,
    getLang: () => options.lang ?? 'zh',
    actions,
    shade: (hex, k) => (k >= 0 ? '#ffffff' : '#000000'),
  })
  const harness = createFakeReact()
  const { ui, captured } = makeUi({ size: options.size, theme: options.theme })
  let closed = 0
  const rendered = { harness, ui, captured, calls, view, store, config, close: () => closed, tree: undefined }
  // Every render refreshes `rendered.tree`, so a test that presses a key and
  // then inspects the tree sees the frame the press produced.
  rendered.renderTree = () => {
    harness.beginRender()
    rendered.tree = scene({ React: harness.React, ui, close: () => { closed += 1 } })
    return rendered.tree
  }
  rendered.text = () => treeText(rendered.renderTree())
  rendered.renderTree()
  return rendered
}

/** Boxes carrying the given prop value. */
const boxesWith = (tree, key, value) => findNodes(tree, 'Box').filter(node => node.props[key] === value)

/**
 * Press one key and re-render.
 *
 * The host re-registers the input handler on every render, so a keypress reads
 * the state of the LAST rendered frame. Tests must therefore render between
 * presses, exactly like the real terminal does.
 */
const press = (rendered, input, key = {}) => {
  rendered.captured.input(input, key)
  return rendered.text()
}

test('the scene draws a 7-row week grid with one cell per day', () => {
  const rendered = render()
  const text = rendered.text()
  assert.match(text, /Token 历史/)
  assert.match(text, /更新于/)
  assert.match(text, /总计/)
  assert.match(text, /子代理/)
  assert.match(text, /Mon/)

  const dayBoxes = findNodes(rendered.tree, 'Box').filter(node => typeof node.props.key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(node.props.key))
  assert.equal(dayBoxes.length, 13 * 7)
  const hoverable = dayBoxes.filter(node => typeof node.props.onMouseEnter === 'function')
  assert.equal(hoverable.length, 13 * 7 - 6)
  assert.equal(dayBoxes.filter(node => node.props.backgroundColor !== undefined).length, 13 * 7 - 6)
  rendered.harness.cleanup()
})

test('the arrows move the selection one SQUARE, not one calendar day', () => {
  const rendered = render()
  // Today is 2026-09-07, the Monday of the last column.
  assert.match(rendered.text(), /2026-09-07/)
  assert.match(press(rendered, '', { leftArrow: true }), /2026-08-31/)
  // Row 1 of that column is the next day.
  assert.match(press(rendered, '', { downArrow: true }), /2026-09-01/)
  // And back up one row.
  assert.match(press(rendered, '', { upArrow: true }), /2026-08-31/)
  // Two columns left, then one row down: 08-17 (row 0) -> 08-18 (row 1).
  press(rendered, '', { leftArrow: true })
  assert.match(press(rendered, '', { leftArrow: true }), /2026-08-17/)
  assert.match(press(rendered, '', { downArrow: true }), /2026-08-18/)
  // `t` returns to today.
  assert.match(press(rendered, 't'), /2026-09-07/)
  rendered.harness.cleanup()
})

test('the selection stops at the grid edges and never enters the future', () => {
  const rendered = render({ spanWeeks: 2 })
  const firstDay = rendered.view.weeks[0].days[0].key
  // Walk far past the left edge.
  let text = rendered.text()
  for (let index = 0; index < 40; index += 1) text = press(rendered, '', { leftArrow: true })
  assert.match(text, new RegExp(firstDay))
  // The top row cannot move up.
  assert.match(press(rendered, '', { upArrow: true }), new RegExp(firstDay))
  // Today is the last column's Monday: nothing below it has happened yet.
  press(rendered, 't')
  assert.match(press(rendered, '', { downArrow: true }), /2026-09-07/)
  assert.match(press(rendered, '', { rightArrow: true }), /2026-09-07/)
  rendered.harness.cleanup()
})

test('the detail card follows the hovered day and defaults to the latest active one', () => {
  const rendered = render({
    records: [
      record('a', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      record('b', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }),
    ],
  })
  assert.match(rendered.text(), /2026-09-07/)
  assert.match(rendered.text(), /1,000,000/)

  const firstKey = rendered.view.weeks[0].days[0].key
  const hoverable = findNodes(rendered.tree, 'Box').filter(node => typeof node.props.onMouseEnter === 'function')
  const first = hoverable.find(node => node.props.key === firstKey)
  assert.ok(first, `expected a hoverable cell for ${firstKey}`)
  first.props.onMouseEnter()
  const text = rendered.text()
  // The card describes the hovered day (which has no usage), while the totals
  // below keep describing the whole span.
  assert.match(text, new RegExp(`${firstKey}\\s+周`))
  assert.match(text, /无用量/)
  assert.match(text, /1,000,000/)
  rendered.harness.cleanup()
})

test('the hover card honours the field switches', () => {
  const rendered = render({
    config: { historyHoverTokens: false, historyHoverCost: false, historyHoverCacheHit: false, historyHoverModels: false },
  })
  assert.match(rendered.text(), /2026-09-07/)
  assert.doesNotMatch(rendered.text(), /未命中输入 1,000,000/)
  assert.doesNotMatch(rendered.text(), /缓存命中 99/)
  rendered.harness.cleanup()
})

test('the subagent chip flips, flashes, and reports what was excluded', () => {
  const on = render()
  assert.match(on.text(), /子代理 计入/)
  assert.equal(findNodes(on.tree, 'Text').some(node => node.props.inverse === true), false)
  on.harness.cleanup()

  const off = render({
    includeSubagents: false,
    records: [
      record('a', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      record('child', { inputTokens: 400_000, outputTokens: 0, cacheReadTokens: 0 }, { subagent: true }),
    ],
  })
  assert.match(off.text(), /子代理 不计入/)
  assert.match(off.text(), /已排除 1 会话 \/ 1 次上报/)

  // Pressing `s` flashes the chip (inverse) and asks the wiring to persist it.
  const flashedText = press(off, 's', {})
  assert.deepEqual(off.calls, ['toggleSubagents'])
  const flashed = findNodes(off.tree, 'Text').filter(node => node.props.inverse === true)
  assert.equal(flashed.length, 1)
  assert.match(treeText(flashed[0]), /子代理/)
  assert.match(flashedText, /子代理/)
  assert.ok(FLASH_MS >= 500)
  off.harness.cleanup()
})

test('the metric, span and rescan chips flash on their own keys', () => {
  const rendered = render()
  press(rendered, 'm')
  let flashed = findNodes(rendered.tree, 'Text').filter(node => node.props.inverse === true)
  assert.equal(treeText(flashed[0]), ' 总 token ')
  press(rendered, 'w')
  flashed = findNodes(rendered.tree, 'Text').filter(node => node.props.inverse === true)
  assert.match(treeText(flashed[0]), /13w|周/)
  press(rendered, 'r')
  flashed = findNodes(rendered.tree, 'Text').filter(node => node.props.inverse === true)
  assert.match(treeText(flashed[0]), /扫描中|更新于/)
  assert.deepEqual(rendered.calls, ['cycleMetric', 'cycleSpan', 'rescan'])
  rendered.harness.cleanup()
})

test('the keyboard closes the scene', () => {
  const rendered = render()
  assert.equal(rendered.close(), 0)
  press(rendered, 'q')
  press(rendered, '', { escape: true })
  assert.equal(rendered.close(), 2)
  rendered.harness.cleanup()
})

test('card and plain layouts differ, and card degrades on a small terminal', () => {
  const card = render({ size: { columns: 120, rows: 32 } })
  assert.equal(boxesWith(card.tree, 'borderStyle', 'round').length, 2) // outer frame + detail card
  card.harness.cleanup()

  const plain = render({ size: { columns: 120, rows: 32 }, config: { historyLayout: 'plain' } })
  assert.equal(boxesWith(plain.tree, 'borderStyle', 'round').length, 0)
  assert.match(plain.text(), /Token 历史/)
  plain.harness.cleanup()

  // `card` on a terminal that cannot hold the frame falls back to plain
  // rendering instead of overflowing.
  const small = render({ size: { columns: 60, rows: 20 } })
  assert.equal(boxesWith(small.tree, 'borderStyle', 'round').length, 0)
  assert.match(small.text(), /Token 历史/)
  small.harness.cleanup()
})

test('the size matrix keeps the right sections for each terminal', () => {
  const wide = render({ size: { columns: 160, rows: 40 }, spanWeeks: 26 })
  assert.match(wide.text(), /费率来源/)
  assert.match(wide.text(), /模型/)
  assert.match(wide.text(), /总花费/)
  wide.harness.cleanup()

  const mid = render({ size: { columns: 90, rows: 28 }, spanWeeks: 26 })
  assert.match(mid.text(), /模型/)
  assert.doesNotMatch(mid.text(), /费率来源/)
  mid.harness.cleanup()

  const short = render({ size: { columns: 70, rows: 18 } })
  assert.match(short.text(), /总计/)
  assert.doesNotMatch(short.text(), /模型/)
  short.harness.cleanup()

  const tiny = render({ size: { columns: 44, rows: 13 } })
  assert.match(tiny.text(), /Token 历史/)
  assert.doesNotMatch(tiny.text(), /总花费/)
  assert.doesNotMatch(tiny.text(), /模型/)
  tiny.harness.cleanup()

  const list = render({ size: { columns: 24, rows: 10 } })
  assert.match(list.text(), /\d{4}-\d{2}-\d{2}/)
  assert.doesNotMatch(list.text(), /费率来源/)
  assert.doesNotMatch(list.text(), /Mon/)
  list.harness.cleanup()
})

test('a trimmed window reports itself and follows the selection', () => {
  const rendered = render({ size: { columns: 60, rows: 32 }, spanWeeks: 53 })
  // 60 columns hold (60 - 2 - 4) / 2 = 27 week columns.
  assert.match(rendered.text(), /显示 27\/53 周/)
  let text = rendered.text()
  for (let index = 0; index < 30; index += 1) text = press(rendered, '', { leftArrow: true })
  // The selection is 30 columns back (2026-02-09) and the window scrolled with
  // it instead of hiding it.
  assert.match(text, /2026-02-09/)
  assert.match(text, /▲/)
  rendered.harness.cleanup()
})

test('loading, error and missing-view states still render', () => {
  const loading = render({ view: undefined, status: 'loading', progress: { done: 3, total: 341 } })
  assert.match(loading.text(), /扫描中 3\/341/)
  loading.harness.cleanup()

  const failed = render({ view: undefined, status: 'error', error: 'boom' })
  assert.match(failed.text(), /扫描失败: boom/)
  failed.harness.cleanup()

  const empty = render({ records: [] })
  assert.match(empty.text(), /无用量|总计/)
  empty.harness.cleanup()
})

test('palettes resolve deterministically', () => {
  assert.equal(resolveScale('github', undefined, () => '#000000'), GRID_SCALES.github)
  assert.equal(resolveScale('nonsense', undefined, () => '#000000'), GRID_SCALES.github)
  assert.equal(resolveScale('blue', undefined, () => '#000000'), GRID_SCALES.blue)
  // A theme accent that is not a literal hex (ANSI names are legal) falls back.
  assert.equal(resolveScale('theme', 'cyan', () => '#000000'), GRID_SCALES.github)
  assert.equal(resolveScale('theme', undefined, () => '#000000'), GRID_SCALES.github)
  const themed = resolveScale('theme', '#4C8DFF', (hex, k) => `shade(${hex},${k})`)
  assert.deepEqual(themed.levels, ['shade(#4C8DFF,-0.25)', '#4C8DFF', 'shade(#4C8DFF,0.25)', 'shade(#4C8DFF,0.5)'])
  assert.equal(cellColor(GRID_SCALES.github, 0), GRID_SCALES.github.empty)
  assert.equal(cellColor(GRID_SCALES.github, 1), GRID_SCALES.github.levels[0])
  assert.equal(cellColor(GRID_SCALES.github, 9), GRID_SCALES.github.levels[3])
})

test('small display helpers are localized', () => {
  assert.equal(metricLabel('zh', 'tokens'), '总 token')
  assert.equal(metricLabel('en', 'tokens'), 'Total tokens')
  assert.equal(metricLabel('zh', 'cost'), '花费')
  assert.equal(metricLabel('zh', 'output'), '输出 token')
  assert.equal(metricLabel('zh', 'cacheMiss'), '未命中输入')
  assert.equal(metricLabel('zh', undefined), '总 token')
  assert.equal(monthLabelOf('2026-09-07', 'zh'), '9月')
  assert.equal(monthLabelOf('2026-09-07', 'en'), 'Sep')
  assert.equal(monthLabelOf('bad', 'zh'), '')
})

test('windowStartFor scrolls minimally and stays in range', () => {
  // Nothing to scroll: the span fits.
  assert.equal(windowStartFor(4, undefined, 13, 13), 0)
  // Inside the default (newest) window: unchanged.
  assert.equal(windowStartFor(40, 26, 27, 53), 26)
  // A stale start beyond the last valid one is clamped.
  assert.equal(windowStartFor(40, 99, 27, 53), 26)
  // Crossing the left edge scrolls by exactly one column.
  assert.equal(windowStartFor(25, 26, 27, 53), 25)
  // Crossing the right edge scrolls right by one.
  assert.equal(windowStartFor(54, 26, 27, 53), 26)
  // Clamped at both ends.
  assert.equal(windowStartFor(0, 5, 27, 53), 0)
  assert.equal(windowStartFor(52, 0, 27, 53), 26)
  assert.equal(windowStartFor(10, Number.NaN, 13, 53), 10)
})

test('a store update re-renders the scene', () => {
  const rendered = render({ records: [] })
  assert.match(rendered.text(), /无用量|总计/)
  const next = buildHistoryView([record('a', { inputTokens: 1_000_000 })], {
    now: MONDAY_NOON,
    spanWeeks: 13,
    metric: 'tokens',
  })
  rendered.store.set({ ...rendered.store.get(), view: next })
  assert.match(treeText(rendered.renderTree()), /1,000,000/)
  rendered.harness.cleanup()
})

test('displayWidth counts CJK and emoji as two cells', () => {
  assert.equal(displayWidth('模型'), 4)
  assert.equal(displayWidth('总 token'), 8)
  assert.equal(displayWidth('花费(估)'), 8)
  assert.equal(displayWidth('¥37.42'), 6)
  assert.equal(displayWidth('705.7M'), 6)
  assert.equal(displayWidth('🐋'), 2)
  assert.equal(displayWidth('…'), 1)
  assert.equal(displayWidth(''), 0)
  assert.equal(displayWidth(undefined), 0)
  assert.equal(charWidth('a'), 1)
  assert.equal(charWidth('，'), 2)
})

test('clipWidth pads and truncates by cells, never by code points', () => {
  assert.equal(displayWidth(clipWidth('模型', 10)), 10)
  assert.equal(displayWidth(clipWidth('总 token', 10)), 10)
  // A wide label that does not fit is cut on a cell boundary.
  const cut = clipWidth('未命中输入', 7)
  assert.equal(displayWidth(cut), 7)
  assert.match(cut, /…$/)
  // A label that fits exactly is left alone.
  assert.equal(clipWidth('缓存命中', 8), '缓存命中')
  assert.equal(clipWidth('anything', 0), '')
})

/**
 * Flatten the model table the way the terminal would: every column is a
 * fixed-width Box, so a row's cell text lands at a deterministic offset.
 */
function tableCells(rendered) {
  const table = findNodes(rendered.tree, 'Box').find(node => node.props.key === 'table')
  assert.ok(table, 'expected the model table')
  return table.children
    .filter(node => node.type === 'Box' && Array.isArray(node.children) && node.children.length > 0 && node.children[0].type === 'Box')
    .map(row => {
      let offset = 0
      return row.children.map(column => {
        const start = offset
        offset += column.props.width
        const text = treeText(column)
        return { start, width: column.props.width, text, cells: displayWidth(text) }
      })
    })
}

test('every table column lands on the same cell in the header and the rows', () => {
  const rendered = render({
    size: { columns: 160, rows: 40 },
    spanWeeks: 26,
    records: [
      record('a', { inputTokens: 1_000_000, outputTokens: 2_000, cacheReadTokens: 500_000 }),
      record('b', { inputTokens: 400_000, outputTokens: 0, cacheReadTokens: 0 }, { model: 'mystery-model' }),
    ],
  })
  const rows = tableCells(rendered)
  assert.ok(rows.length >= 3, 'expected a header, a separator-free row and at least two models')
  const offsets = rows[0].map(cell => cell.start)
  for (const row of rows) {
    assert.deepEqual(row.map(cell => cell.start), offsets, 'column start offsets must not drift')
    assert.deepEqual(row.map(cell => cell.width), rows[0].map(cell => cell.width))
    for (const cell of row) {
      assert.ok(cell.cells <= cell.width, `"${cell.text.trim()}" is ${cell.cells} cells in a ${cell.width}-cell column`)
    }
  }
  // The header is the row that carries the wide CJK labels; its last column is
  // right-aligned inside its own box, which is what the host pads for us.
  assert.match(rows[0][0].text, /模型/)
  assert.match(rows[0][1].text, /总 token/)
  rendered.harness.cleanup()
})

test('the detail card and the totals put their labels in the same column', () => {
  const rendered = render({ size: { columns: 120, rows: 32 } })
  const labelWidths = []
  for (const key of ['tokens', 'cost', 'rate', 'sum', 'sub']) {
    const row = findNodes(rendered.tree, 'Box').find(node => node.props.key === key)
    if (row === undefined) continue
    const label = row.children[0]
    assert.equal(label.type, 'Box')
    assert.equal(label.props.width, 12)
    labelWidths.push(label.props.width)
  }
  assert.ok(labelWidths.length >= 3, `expected detail/totals label cells, saw ${labelWidths.length}`)
  assert.equal(new Set(labelWidths).size, 1, 'all label columns must be the same width')
  rendered.harness.cleanup()
})
