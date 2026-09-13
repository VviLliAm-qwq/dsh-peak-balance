/**
 * The `/th` scene: a GitHub-style contribution grid of token usage.
 *
 * Rendering rules this component obeys:
 *
 * - It never imports React: hooks and elements come from the host-injected
 *   `props.React`, and the widget kit from `props.ui` (the single-React rule
 *   the scene seam documents — a plugin-owned React copy would break hooks).
 * - It never touches the terminal or the filesystem: everything it draws comes
 *   from the store snapshot the plugin wiring publishes.
 * - Every row it draws is budgeted before it is drawn: the scene owns a
 *   full-screen surface, so a layout that overflows is not clipped politely —
 *   it pushes the frame around. Sections are therefore dropped in a fixed
 *   priority order as the terminal shrinks.
 * - Pointer support (hover for the day card) is pure `Box` props; the keyboard
 *   path stays the fallback when mouse tracking is off (inline terminals).
 *
 * @module dsh-peak-balance/history-view
 */

import { describeDay, gridPositionOf, stepGrid, todayKeyOf } from './history.js'
import { formatCny, formatDecimal, formatPercent, formatTokens, formatTokensFull } from './format.js'
import { t } from './i18n.js'

/** Fixed grid palettes (the scene is not inside the status-line theme kit). */
export const GRID_SCALES = Object.freeze({
  github: Object.freeze({
    empty: '#161b22',
    levels: Object.freeze(['#0e4429', '#006d32', '#26a641', '#39d353']),
  }),
  blue: Object.freeze({
    empty: '#0d1b2a',
    levels: Object.freeze(['#12355b', '#1c5d99', '#2f8fdc', '#7cc4ff']),
  }),
})

/** How long a toggled chip stays highlighted. */
export const FLASH_MS = 1200

/** Cells reserved for the weekday gutter ("Mon "). */
const GUTTER = 4

/** Cell width of one day square; the grid always ends at today's week. */
const CELL_WIDTH = 2

/** English month abbreviations for the axis labels. */
const MONTHS_EN = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])

/** Weekday names, indexed by `Date#getUTCDay()`. */
const WEEKDAYS = Object.freeze({
  zh: Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']),
  en: Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']),
})

/** Rows that carry a weekday label (GitHub labels every other row). */
const LABELED_ROWS = Object.freeze({ mon: Object.freeze({ 0: 'Mon', 2: 'Wed', 4: 'Fri' }), sun: Object.freeze({ 1: 'Mon', 3: 'Wed', 5: 'Fri' }) })

/** Localized metric names. */
export function metricLabel(lang, metric) {
  switch (metric) {
    case 'cost':
      return t(lang, 'historyMetricCost')
    case 'output':
      return t(lang, 'historyMetricOutput')
    case 'cacheMiss':
      return t(lang, 'historyMetricCacheMiss')
    default:
      return t(lang, 'historyMetricTokens')
  }
}

/** `'2026-09-05'` -> `'Sep'` / `'9月'`. */
export function monthLabelOf(dayKey, lang) {
  const month = Number(String(dayKey).slice(5, 7))
  if (!Number.isFinite(month) || month < 1 || month > 12) return ''
  if (lang === 'zh') return t(lang, 'historyMonthLabel', { m: month })
  return MONTHS_EN[month - 1]
}

/** `'2026-09-05'` -> `'周六'` / `'Sat'` (the key is a local date; noon UTC keeps it). */
export function weekdayLabelOf(dayKey, lang) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey))
  if (match === null) return ''
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return (WEEKDAYS[lang] ?? WEEKDAYS.en)[day]
}

/** Format one metric value for the legend / detail card. */
export function metricText(metric, value) {
  if (metric === 'cost') return formatCny(value)
  return formatTokensFull(value)
}

/** Color for one cell level under the effective scale. */
export function cellColor(scale, level) {
  if (level <= 0) return scale.empty
  return scale.levels[Math.min(scale.levels.length - 1, level - 1)]
}

/**
 * Resolve the palette for a scale name.
 *
 * `theme` derives its shades from the host theme's accent, falling back to the
 * GitHub palette when the accent is not a literal hex color (themes may use
 * ANSI names) — a colored grid is better than a red one.
 *
 * @param scaleName - `'github'` / `'blue'` / `'theme'`.
 * @param accent - host theme accent, when available.
 * @param shade - the plugin's `shade` helper (injected to keep this module pure).
 */
export function resolveScale(scaleName, accent, shade) {
  if (scaleName !== 'theme') return GRID_SCALES[scaleName] ?? GRID_SCALES.github
  if (typeof accent !== 'string' || !/^#?[0-9a-f]{6}$/i.test(accent.trim())) return GRID_SCALES.github
  const base = accent.trim().startsWith('#') ? accent.trim() : `#${accent.trim()}`
  return {
    empty: GRID_SCALES.github.empty,
    levels: [shade(base, -0.25), base, shade(base, 0.25), shade(base, 0.5)],
  }
}

/**
 * Display width of one code point, in terminal cells.
 *
 * CJK and emoji occupy TWO cells while `String#length` counts them as one, and
 * that is exactly what misaligned the model table: a header like `总 token` is 7
 * code points but 8 cells, so padding by length drifted every column to its
 * right.
 */
const WIDE_RANGES = Object.freeze([
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK punctuation
  [0x3041, 0x33ff], // Kana, Bopomofo, Hangul compat, CJK compat
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compat ideographs
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // Emoji
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK ext B+
  [0x30000, 0x3fffd],
])

/** Code points that take no cell at all (combining marks, joiners, selectors). */
const ZERO_RANGES = Object.freeze([
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
])

/** Whether `codePoint` falls inside any `[from, to]` range. */
function inRanges(codePoint, ranges) {
  for (const [from, to] of ranges) {
    if (codePoint >= from && codePoint <= to) return true
  }
  return false
}

/** Terminal cells one code point occupies (0, 1 or 2). */
export function charWidth(char) {
  const codePoint = typeof char === 'string' ? char.codePointAt(0) : char
  if (!Number.isFinite(codePoint)) return 0
  if (inRanges(codePoint, ZERO_RANGES)) return 0
  return inRanges(codePoint, WIDE_RANGES) ? 2 : 1
}

/** Terminal cells a whole string occupies. */
export function displayWidth(text) {
  let width = 0
  for (const char of String(text ?? '')) width += charWidth(char)
  return width
}

/**
 * Fit a label into `width` CELLS, padding with spaces and truncating with `…`.
 *
 * The cell-accurate counterpart of `String#padEnd`. Column alignment does not
 * depend on it (columns are fixed-width `Box`es and the host does the padding),
 * but truncation does: a wide label must not spill into its neighbour.
 */
export function clipWidth(text, width) {
  const value = String(text ?? '')
  if (width <= 0) return ''
  const actual = displayWidth(value)
  if (actual <= width) return value + ' '.repeat(width - actual)
  let out = ''
  let used = 0
  for (const char of value) {
    const size = charWidth(char)
    if (used + size > width - 1) break
    out += char
    used += size
  }
  return `${out}…${' '.repeat(Math.max(0, width - used - 1))}`
}

/**
 * The smallest window start that keeps `column` visible.
 *
 * Trimming weeks (a narrow terminal cannot show 53 columns) must not hide the
 * day the user just navigated to: crossing an edge scrolls the window by one
 * column instead of jumping.
 *
 * @param column - column index of the selected day.
 * @param current - current window start (`undefined` = "the newest weeks").
 * @param visible - columns that fit.
 * @param total - columns in the span.
 */
export function windowStartFor(column, current, visible, total) {
  const last = Math.max(0, total - visible)
  let start = Number.isFinite(current) ? current : last
  if (column < start) start = column
  else if (column > start + visible - 1) start = column - visible + 1
  return Math.max(0, Math.min(last, start))
}

/**
 * Build the scene component.
 *
 * @param options.store - store carrying `{ status, view, progress, error, stats }`.
 * @param options.getConfig - resolved plugin config (hover flags, palette, layout…).
 * @param options.getLang - `'zh'` / `'en'`.
 * @param options.actions - `{ rescan, cycleMetric, cycleSpan, toggleSubagents }`.
 * @returns A component for `tuiScenes.register({ component })`.
 */
export function createHistoryScene(options) {
  const store = options.store
  const getConfig = options.getConfig ?? (() => ({}))
  const getLang = options.getLang ?? (() => 'zh')
  const actions = options.actions ?? {}
  const shade = options.shade ?? ((hex) => hex)

  return function TokenHistoryScene({ React, ui, close }) {
    const { Box, Text } = ui
    const h = React.createElement
    const [snapshot, setSnapshot] = React.useState(() => store.get())
    React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [])

    const view = snapshot?.view
    const config = getConfig()
    const lang = getLang()
    const [cursor, setCursor] = React.useState(undefined)
    const [hovered, setHovered] = React.useState(undefined)
    const [closeHovered, setCloseHovered] = React.useState(false)
    const [flash, setFlash] = React.useState(undefined)
    const [windowStart, setWindowStart] = React.useState(undefined)

    /** Flash a header chip for {@link FLASH_MS}: a toggle needs visible feedback. */
    const bump = kind => setFlash(previous => ({ kind, n: (previous?.n ?? 0) + 1 }))
    React.useEffect(() => {
      if (flash === undefined) return undefined
      const timer = setTimeout(() => setFlash(undefined), FLASH_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    }, [flash])

    const weeks = view?.weeks ?? []
    const days = weeks.flatMap(week => week.days)
    const fallbackKey = days.filter(day => !day.future && day.active).slice(-1)[0]?.key
    const defaultKey = fallbackKey ?? todayKeyOf(view) ?? days.filter(day => !day.future).slice(-1)[0]?.key
    const selectedKey = cursor ?? defaultKey
    const selectedPosition = view === undefined ? undefined : gridPositionOf(view, selectedKey)

    // Hooks must be called unconditionally and in a stable order: the seam
    // always ships this kit, and the fallbacks keep a partial host renderable.
    const useInput = typeof ui.useInput === 'function' ? ui.useInput : () => {}
    const useTerminalSize = typeof ui.useTerminalSize === 'function' ? ui.useTerminalSize : () => ({ columns: 120, rows: 32 })
    const useTheme = typeof ui.useTheme === 'function' ? ui.useTheme : () => undefined

    const size = useTerminalSize()
    const rows = size?.rows ?? 32
    const columns = size?.columns ?? 120
    const layoutCard = config.historyLayout !== 'plain'
    // The framed card needs a little more room than the plain layout; when it
    // does not fit, the same content is drawn plain rather than cramped.
    const framed = layoutCard && rows >= 24 && columns >= 72
    const innerWidth = Math.max(20, columns - (framed ? 4 : 2))
    const compact = rows < 12 || columns < 40
    const visibleWeeks = Math.max(1, Math.min(weeks.length || 1, Math.floor((innerWidth - GUTTER) / CELL_WIDTH)))
    const totalWeeks = weeks.length
    const start = totalWeeks === 0
      ? 0
      : Math.max(0, Math.min(Math.max(0, totalWeeks - visibleWeeks), Number.isFinite(windowStart) ? windowStart : totalWeeks - visibleWeeks))
    const shown = weeks.slice(start, start + visibleWeeks)
    const trimmed = totalWeeks > visibleWeeks

    /** Select one day and keep it inside the visible window. */
    const move = nextKey => {
      if (nextKey === undefined || nextKey === selectedKey) return
      setCursor(nextKey)
      setHovered(undefined)
      const position = view === undefined ? undefined : gridPositionOf(view, nextKey)
      if (position === undefined) return
      setWindowStart(current => windowStartFor(position.column, current ?? Math.max(0, totalWeeks - visibleWeeks), visibleWeeks, totalWeeks))
    }

    useInput((input, key) => {
      if (key?.escape === true || input === 'q') {
        close?.()
        return
      }
      if (input === 'r') {
        actions.rescan?.()
        bump('rescan')
        return
      }
      if (input === 'm') {
        actions.cycleMetric?.()
        bump('metric')
        return
      }
      if (input === 'w') {
        actions.cycleSpan?.()
        bump('span')
        return
      }
      if (input === 's') {
        actions.toggleSubagents?.()
        bump('subagent')
        return
      }
      if (input === 'p') {
        actions.cycleProvider?.()
        bump('provider')
        return
      }
      if (input === 't') {
        move(todayKeyOf(view))
        return
      }
      // The arrows move the SQUARE, not the calendar: ←/→ step one week column
      // (same weekday), ↑/↓ step one weekday row inside the column.
      const direction = key?.leftArrow === true
        ? 'left'
        : key?.rightArrow === true
          ? 'right'
          : key?.upArrow === true
            ? 'up'
            : key?.downArrow === true
              ? 'down'
              : undefined
      if (direction === undefined) return
      move(stepGrid(view, selectedKey, direction))
    })

    // ---- layout budget (top to bottom, first-come-first-served) -------------
    let left = rows - (framed ? 2 : 0)
    const take = count => {
      if (count < 0 || left < count) return false
      left -= count
      return true
    }
    take(1) // header
    const showStatus = take(1)
    const showTopSeparator = take(1)
    take(1 + 7 + 1) // month axis + seven weekday rows + the selection caret
    const showLegend = take(1)

    const scale = resolveScale(config.historyColorScale, useTheme()?.accent, shade)
    const subagentsOn = config.historyIncludeSubagents === true
    /** Provider filter state: `'all'` or one provider id (see the `p` key). */
    const providerFilter = typeof view.providerFilter === 'string' && view.providerFilter !== '' ? view.providerFilter : 'all'
    const allProviders = Array.isArray(view.allProviders) ? view.allProviders : []

    // The detail card degrades field by field rather than disappearing: on a
    // short terminal a one-row card is still the thing the pointer is for.
    const detailKey = hovered ?? selectedKey
    const detailDay = describeDay(view.days.get(detailKey))
    const detailFields = []
    if (detailDay !== undefined) {
      if (config.historyHoverTokens === true) detailFields.push('tokens')
      if (config.historyHoverCost === true) detailFields.push('cost')
      if (config.historyHoverCacheHit === true) detailFields.push('rate')
      if (config.historyHoverModels === true) detailFields.push('models')
    }
    const detailRoom = Math.max(0, left - 5) - (framed ? 2 : 0)
    const shownDetailFields = detailFields.slice(0, Math.max(0, detailRoom))
    const detailHeight = 1 + shownDetailFields.length + (framed ? 2 : 0)
    // The title row alone is still worth drawing: it names the day the caret is
    // on, which is the only feedback a keyboard user gets for an empty day.
    const showDetail = take(detailHeight)
    const showTotals = take(3)
    const showHint = take(1)
    const tableCapacity = left - 2
    const showTable = tableCapacity >= 1 && innerWidth >= 56
    const tableRows = showTable ? tableCapacity : 0

    const chip = (key, text, chipOptions = {}) =>
      h(
        Text,
        {
          key,
          color: chipOptions.color,
          dimColor: chipOptions.color === undefined,
          bold: flash?.kind === key,
          inverse: flash?.kind === key,
        },
        ` ${text} `,
      )

    const header = h(
      Box,
      { flexDirection: 'row', height: 1, flexShrink: 0 },
      h(Text, { bold: true, color: 'accent' }, '🐋 '),
      h(Text, { bold: true }, t(lang, 'historyTitle')),
      h(Text, { dimColor: true }, ' '),
      chip('metric', metricLabel(lang, config.historyMetric)),
      chip('span', trimmed ? t(lang, 'historyWindow', { a: visibleWeeks, b: totalWeeks }) : `${totalWeeks}w`),
      chip('subagent', `${t(lang, 'historySubagentShort')} ${subagentsOn ? t(lang, 'historySubagentOn') : t(lang, 'historySubagentOff')}`, {
        color: subagentsOn ? 'success' : 'subtle',
      }),
      // Only meaningful once there is more than one account to choose between.
      allProviders.length > 1
        ? chip('provider', `${t(lang, 'historyProviderShort')} ${providerFilter === 'all' ? t(lang, 'historyProviderAll') : providerFilter}`, {
            color: providerFilter === 'all' ? 'subtle' : 'accent',
          })
        : null,
      h(Box, { flexGrow: 1 }),
      h(
        Box,
        { onClick: () => close?.(), onMouseEnter: () => setCloseHovered(true), onMouseLeave: () => setCloseHovered(false) },
        h(Text, { color: closeHovered ? 'text' : 'subtle' }, ' ✕ '),
      ),
    )

    const status = showStatus
      ? h(
          Box,
          { height: 1, flexShrink: 0 },
          h(
            Text,
            { dimColor: true, wrap: 'truncate', inverse: flash?.kind === 'rescan' },
            snapshot?.status === 'loading'
              ? `${t(lang, 'historyScanning')} ${snapshot?.progress?.done ?? 0}/${snapshot?.progress?.total ?? 0}`
              : snapshot?.status === 'error'
                ? `${t(lang, 'historyError')}: ${snapshot?.error ?? ''}`
                : `${t(lang, 'historyScannedAt')} ${snapshot?.scannedAt === undefined ? '—' : new Date(snapshot.scannedAt).toLocaleTimeString()}` +
                  (view === undefined
                    ? ''
                    : ` · ${view.totals.sessions} ${t(lang, 'historySessions')} · ${formatTokensFull(view.totals.events)} ${t(lang, 'historyEvents')} · ${view.totals.activeDays} ${t(lang, 'historyActiveDays')}`) +
                  // A scan running behind an on-screen grid is a refresh, not a
                  // load: the numbers stay put and only this chip changes.
                  (snapshot?.refreshing === true ? ` · ${t(lang, 'historyRefreshing')}` : ''),
          ),
        )
      : null

    const separator = key =>
      h(Box, { key, height: 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate' }, '─'.repeat(Math.max(0, innerWidth))))

    /** The fallback for terminals that cannot hold the grid at all. */
    if (compact || view === undefined) {
      const body = []
      if (view === undefined) {
        body.push(h(Text, { key: 'loading', dimColor: true }, t(lang, 'historyLoading')))
      } else {
        const capacity = Math.max(1, rows - 4)
        for (const day of days.filter(entry => !entry.future).slice(-capacity).reverse()) {
          const detailDay = describeDay(view.days.get(day.key))
          const summary = detailDay === undefined
            ? t(lang, 'historyNoData')
            : `${formatTokens(detailDay.tokens)}  ${formatCny(detailDay.cost)}  ${formatPercent(detailDay.cacheHitRate)}`
          body.push(h(Text, { key: day.key, dimColor: true, wrap: 'truncate' }, `${day.key}  ${summary}`))
        }
        body.push(
          h(
            Text,
            { key: 'totals', wrap: 'truncate' },
            `${t(lang, 'historyTotalTokens')} ${formatTokens(view.totals.tokens)} · ${t(lang, 'historyTotalCost')} ${formatCny(view.totals.cost)}`,
          ),
        )
      }
      return h(Box, { flexDirection: 'column', paddingX: 1 }, header, ...body, h(Text, { dimColor: true, wrap: 'truncate' }, t(lang, 'historyHint')))
    }

    // ---- grid ---------------------------------------------------------------
    // Month labels are laid out by hand: a 2-cell week column cannot hold the
    // 3-4 cells of `9月` / `Sep`, so a label claims the NEXT column's slot too
    // (its neighbour is empty by construction — labels only appear where a
    // month starts). Everything stays cell-exact, so the grid below is aligned.
    const monthCells = []
    for (let index = 0; index < shown.length; index += 1) {
      const week = shown[index]
      const label = week.monthLabel === undefined ? '' : monthLabelOf(week.monthLabel, lang)
      if (label === '') {
        monthCells.push(h(Text, { key: `m${week.index}`, dimColor: true }, '  '))
        continue
      }
      monthCells.push(h(Text, { key: `m${week.index}`, dimColor: true }, clipWidth(label, CELL_WIDTH * 2)))
      index += 1
    }
    const monthRow = h(
      Box,
      { flexDirection: 'row', height: 1, flexShrink: 0 },
      h(Text, { dimColor: true }, ' '.repeat(GUTTER)),
      ...monthCells,
    )

    const gridRows = []
    for (let row = 0; row < 7; row += 1) {
      const label = LABELED_ROWS[config.historyWeekStart === 'sun' ? 'sun' : 'mon'][row] ?? ''
      const cells = []
      for (const week of shown) {
        const day = week.days.find(entry => entry.row === row)
        if (day === undefined) {
          cells.push(h(Text, { key: `e${week.index}`, dimColor: true }, '  '))
          continue
        }
        const isSelected = day.key === selectedKey
        const base = day.future ? undefined : cellColor(scale, day.level)
        // The selected square is lightened rather than overwritten with a
        // marker: the tile color IS the data, and `[]` inside it read as noise.
        // A caret row under the grid points at the selected column instead.
        const background = isSelected && base !== undefined ? shade(base, 0.35) : base
        const hoverProps = day.future
          ? {}
          : {
              onMouseEnter: () => {
                setHovered(day.key)
                setCursor(day.key)
              },
              onMouseLeave: () => setHovered(current => (current === day.key ? undefined : current)),
            }
        cells.push(
          h(
            Box,
            { key: day.key, width: CELL_WIDTH, height: 1, flexShrink: 0, backgroundColor: background, ...hoverProps },
            h(Text, { color: hovered === day.key ? 'text' : undefined }, '  '),
          ),
        )
      }
      gridRows.push(
        h(
          Box,
          { key: `r${row}`, flexDirection: 'row', height: 1, flexShrink: 0 },
          h(Box, { width: GUTTER - 1, flexShrink: 0 }, h(Text, { dimColor: true, wrap: 'truncate' }, clipWidth(label, GUTTER - 1))),
          h(Text, { dimColor: true }, ' '),
          ...cells,
        ),
      )
    }

    const caretColumn = selectedPosition === undefined ? -1 : selectedPosition.column - start
    const caretRow = h(
      Box,
      { height: 1, flexShrink: 0 },
      h(Text, { color: 'accent' }, caretColumn >= 0 && caretColumn < visibleWeeks ? `${' '.repeat(GUTTER + caretColumn * CELL_WIDTH)}▲` : ' '),
    )

    const legend = showLegend
      ? h(
          Box,
          { flexDirection: 'row', height: 1, flexShrink: 0 },
          h(Text, { dimColor: true }, `${metricLabel(lang, config.historyMetric)} ${t(lang, 'historyLegendLow')} `),
          ...[0, 1, 2, 3, 4].map(level => h(Box, { key: `l${level}`, width: CELL_WIDTH, height: 1 }, h(Text, { backgroundColor: cellColor(scale, level) }, '  '))),
          h(Text, { dimColor: true, wrap: 'truncate' }, ` ${t(lang, 'historyLegendHigh')} · ${t(lang, 'historyLegendMax')} ${metricText(view.metric, view.legend.max)}`),
        )
      : null

    // ---- detail card --------------------------------------------------------
    // The label sits in a fixed-width Box and the value in the flexing box next
    // to it, so the value column starts on the same cell no matter how wide the
    // (possibly CJK) label is. Hand-padding was what drifted.
    // Wide enough for the longest label (子代理会话 = 10 cells) plus a gap, so
    // the value column starts on one fixed cell for both the detail card and
    // the totals rows below it.
    const LABEL_CELLS = 12
    const labelCell = (key, text) =>
      h(
        Box,
        { key, width: LABEL_CELLS, flexShrink: 0 },
        h(Text, { dimColor: true, wrap: 'truncate' }, clipWidth(text, LABEL_CELLS)),
      )
    const detailRows = []
    if (showDetail) {
      detailRows.push(
        h(Text, { key: 'title', bold: true, wrap: 'truncate' }, `${detailKey ?? '—'}  ${weekdayLabelOf(detailKey, lang)}${detailDay === undefined ? `  ${t(lang, 'historyNoData')}` : ''}`),
      )
      if (detailDay !== undefined) {
        if (shownDetailFields.includes('tokens')) {
          detailRows.push(
            h(
              Box,
              { key: 'tokens', flexDirection: 'row', height: 1, flexShrink: 0 },
              labelCell('l', t(lang, 'historyTokens')),
              h(
                Box,
                { flexShrink: 1, minWidth: 0 },
                h(
                  Text,
                  { wrap: 'truncate' },
                  `${t(lang, 'historyInput')} ${formatTokensFull(detailDay.counts.input)} · ${t(lang, 'historyCacheRead')} ${formatTokensFull(detailDay.counts.cacheRead)} · ${t(lang, 'historyOutput')} ${formatTokensFull(detailDay.counts.output)}`,
                ),
              ),
            ),
          )
        }
        if (shownDetailFields.includes('cost')) {
          detailRows.push(
            h(
              Box,
              { key: 'cost', flexDirection: 'row', height: 1, flexShrink: 0 },
              labelCell('l', t(lang, 'historyCost')),
              h(
                Box,
                { flexShrink: 1, minWidth: 0 },
                h(Text, { wrap: 'truncate' }, `${formatCny(detailDay.cost)}${detailDay.costIncomplete ? `（${t(lang, 'historyCostIncomplete')}）` : ''}`),
              ),
            ),
          )
        }
        if (shownDetailFields.includes('rate')) {
          detailRows.push(
            h(
              Box,
              { key: 'rate', flexDirection: 'row', height: 1, flexShrink: 0 },
              labelCell('l', t(lang, 'historyCacheHit')),
              h(
                Box,
                { flexShrink: 1, minWidth: 0 },
                h(
                  Text,
                  { wrap: 'truncate' },
                  `${formatPercent(detailDay.cacheHitRate)}${detailDay.subagentShare === undefined ? '' : ` · ${t(lang, 'historySubagentShare')} ${formatPercent(detailDay.subagentShare)}`}`,
                ),
              ),
            ),
          )
        }
        if (shownDetailFields.includes('models') && detailDay.models.length > 0) {
          detailRows.push(
            h(
              Box,
              { key: 'models', flexDirection: 'row', height: 1, flexShrink: 0 },
              labelCell('l', t(lang, 'historyColModel')),
              h(
                Box,
                { flexShrink: 1, minWidth: 0 },
                h(Text, { wrap: 'truncate' }, detailDay.models.slice(0, 4).map(entry => `${entry.model} ${formatTokens(entry.tokens)}`).join(' · ')),
              ),
            ),
          )
        }
      }
    }

    // ---- totals -------------------------------------------------------------
    // A cost total is only meaningful in ONE unit: an official CNY estimate and
    // a subscription's credits are different things, so a board that adds them
    // prints a number in no unit at all. When the selected providers disagree,
    // the cost column says so and the per-provider rows carry the figures.
    const perProvider = Array.isArray(view.providers) ? view.providers : []
    const unitLabel = provider => (provider?.unit === undefined
      ? t(lang, 'historyRateUnknown')
      : provider.unit.kind === 'money' ? formatCny(provider.cost) : `${formatDecimal(provider.cost)} ${t(lang, 'creditsUnit')}`)
    const totalsRows = []
    if (showTotals) {
      const costText = view.mixedUnits === true
        ? t(lang, 'historyCostMixed')
        : `${formatCny(view.totals.cost)}${view.totals.costIncomplete ? '*' : ''}`
      totalsRows.push(
        h(
          Box,
          { key: 'sum', flexDirection: 'row', height: 1, flexShrink: 0 },
          labelCell('l', t(lang, 'historyTotalTokens')),
          h(
            Box,
            { flexShrink: 1, minWidth: 0 },
            h(
              Text,
              { wrap: 'truncate' },
              `${formatTokensFull(view.totals.tokens)} · ${t(lang, 'historyTotalCost')} ${costText} · ${t(lang, 'historyCacheHit')} ${formatPercent(view.totals.cacheHitRate)}`,
            ),
          ),
        ),
      )
      if (perProvider.length > 1) {
        totalsRows.push(
          h(
            Box,
            { key: 'providers', flexDirection: 'row', height: 1, flexShrink: 0 },
            labelCell('l', t(lang, 'historyProviderShort')),
            h(
              Box,
              { flexShrink: 1, minWidth: 0 },
              h(
                Text,
                { wrap: 'truncate' },
                perProvider
                  .map(provider => `${provider.label} ${formatTokens(provider.tokens)} ${unitLabel(provider)}`)
                  .join(' · '),
              ),
            ),
          ),
        )
      }
      totalsRows.push(
        h(
          Box,
          { key: 'sub', flexDirection: 'row', height: 1, flexShrink: 0 },
          labelCell('l', t(lang, 'historySubagentShort')),
          h(
            Box,
            { flexShrink: 1, minWidth: 0 },
            h(
              Text,
              { wrap: 'truncate' },
              subagentsOn
                ? `${view.totals.subagentSessions}/${view.totals.sessions} ${t(lang, 'historySessions')} · ${formatTokensFull(view.totals.subagentEvents)} ${t(lang, 'historyEvents')}` +
                  (view.totals.bestDay === undefined ? '' : ` · ${t(lang, 'historyBestDay')} ${view.totals.bestDay.key}`)
                : `${t(lang, 'historySubagentOff')} · ${t(lang, 'historyExcluded', { sessions: view.totals.excluded.sessions, events: view.totals.excluded.events })}`,
            ),
          ),
        ),
      )
      if (view.totals.costIncomplete) {
        totalsRows.push(h(Text, { key: 'note', dimColor: true, wrap: 'truncate' }, `* ${t(lang, 'historyCostIncomplete')}`))
      }
      if (view.metricFallback === true) {
        // The grid asked for cost but the selection mixes units; it fell back to
        // tokens, and saying so is the difference between a caveat and a lie.
        totalsRows.push(h(Text, { key: 'fallback', dimColor: true, wrap: 'truncate' }, `* ${t(lang, 'historyCostMixed')}`))
      }
    }

    // ---- model table --------------------------------------------------------
    // One fixed-width Box per column; the host pads and right-aligns inside it,
    // so a wide header label can never shift a neighbouring column.
    const tableNodes = []
    if (showTable && tableRows >= 1) {
      const wide = innerWidth >= 76
      const modelWidth = Math.max(12, Math.min(28, innerWidth - (wide ? 46 : 40)))
      const columns = [
        { key: 'm', width: modelWidth, right: false },
        { key: 't', width: 11, right: true },
        { key: 'c', width: 12, right: true },
        { key: 'h', width: 9, right: true },
      ]
      if (wide) columns.push({ key: 's', width: 9, right: true })
      const tableRow = (key, values, options = {}) =>
        h(
          Box,
          { key, flexDirection: 'row', height: 1, flexShrink: 0 },
          ...columns.map((column, index) =>
            h(
              Box,
              {
                key: column.key,
                width: column.width,
                flexShrink: 0,
                justifyContent: column.right ? 'flex-end' : 'flex-start',
              },
              h(
                Text,
                { dimColor: options.dim === true, bold: options.bold === true, wrap: 'truncate' },
                column.right ? ` ${clipWidth(values[index], column.width - 1)}` : clipWidth(values[index], column.width),
              ),
            ),
          ),
        )
      tableNodes.push(
        tableRow('thead', [
          t(lang, 'historyColModel'),
          t(lang, 'historyColTokens'),
          t(lang, 'historyColCost'),
          t(lang, 'historyColCacheHit'),
          t(lang, 'historyColRate'),
        ], { bold: true, dim: true }),
      )
      tableNodes.push(separator('tsep'))
      for (const entry of view.models.slice(0, tableRows)) {
        const source = entry.source === 'custom'
          ? t(lang, 'historyRateCustom')
          : entry.source === 'unknown'
            ? t(lang, 'historyRateUnknown')
            : t(lang, 'historyRateBuiltin')
        const cost = entry.source === 'unknown' ? '—' : formatCny(entry.cost)
        // With more than one account in play, the model column carries its
        // provider: two rows reading `deepseek-v4.1-flash` from different
        // accounts are otherwise indistinguishable.
        const name = allProviders.length > 1 && entry.providerLabel !== undefined && entry.providerLabel !== '—'
          ? `${entry.providerLabel}:${entry.model}`
          : entry.model
        tableNodes.push(tableRow(entry.key, [name, formatTokens(entry.tokens), cost, formatPercent(entry.cacheHitRate), source], { dim: true }))
      }
    }

    const content = [
      header,
      status,
      showTopSeparator ? separator('sep1') : null,
      monthRow,
      ...gridRows,
      caretRow,
      legend,
      showDetail
        ? framed
          ? h(Box, { key: 'detail', flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', marginTop: 1 }, ...detailRows)
          : h(Box, { key: 'detail', flexDirection: 'column', marginTop: 1 }, ...detailRows)
        : null,
      showTotals
        ? h(Box, { key: 'totals', flexDirection: 'column', marginTop: 1, paddingLeft: framed ? 1 : 0 }, ...totalsRows)
        : null,
      tableNodes.length > 0 ? separator('sep2') : null,
      tableNodes.length > 0 ? h(Box, { key: 'table', flexDirection: 'column' }, ...tableNodes) : null,
      showHint ? h(Text, { key: 'hint', dimColor: true, wrap: 'truncate' }, t(lang, 'historyHint')) : null,
    ].filter(node => node !== null)

    return framed
      ? h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1 }, ...content)
      : h(Box, { flexDirection: 'column', paddingX: 1 }, ...content)
  }
}
