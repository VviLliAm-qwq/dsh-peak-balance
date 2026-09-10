/**
 * The status contribution rendered above the prompt.
 *
 * Two shapes, decided by the display model:
 *
 * - off-peak (or warning mode off): one themed line, no frame;
 * - peak + warning mode: a three-row rounded frame whose border and phase
 *   label pulse in the configured warning color, with a travelling waveform
 *   on the right — the "peak hour" effect.
 *
 * The component only consumes host capabilities (`props.React`, `props.ui`):
 * it never imports React itself (single-React rule) and never touches the
 * terminal directly.
 *
 * @module dsh-peak-balance/view
 */

/** Status key (also the registration key); plugin-namespaced slug. */
export const VIEW_KEY = 'dsh-peak-balance'

/** Rows requested from the host: frame top + content + frame bottom. */
export const VIEW_MAX_ROWS = 3

/** Animation frame interval in milliseconds (~9 fps while peaking). */
export const FRAME_MS = 110

/**
 * Left indent of the contribution, in terminal cells.
 *
 * The prompt's own content starts one cell in from the left edge (the `❯`
 * cursor sits inside the input box's first column), plus one cell of air —
 * which is where the line reads as aligned against the box below instead of
 * crowding it.
 */
export const VIEW_INDENT_CELLS = 2

/**
 * Blank row above the single-line shape, so the line never touches whatever
 * the transcript left above it.
 *
 * Only the plain line takes it: the warning frame already fills the host's
 * three-row budget (top border + content + bottom border), and a margin there
 * would push the bottom border into the clipped area.
 */
export const VIEW_TOP_GAP_ROWS = 1

/** Frames in one full "breath" cycle. */
const BREATH_FRAMES = 14

/** Hard flash toggle period, in frames. */
const FLASH_FRAMES = 4

/** Waveform barrel for the right-hand flourish. */
const WAVE = '▁▂▃▄▅▆▇█▇▆▅▄▃▂'

/** Theme token per display tone. */
const TONE_COLORS = Object.freeze({
  peak: 'warning',
  idle: 'success',
  muted: 'subtle',
  value: 'text',
  error: 'error',
})

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** `#RRGGBB` -> `[r, g, b]`; malformed input falls back to the warning red. */
export function hexToRgb(hex) {
  const text = typeof hex === 'string' ? hex.trim() : ''
  const match = /^#?([0-9a-f]{6})$/i.exec(text)
  if (match === null) return [255, 77, 79]
  const value = Number.parseInt(match[1], 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** Blend `hex` toward white (`k > 0`) or black (`k < 0`); `k` in [-1, 1]. */
export function shade(hex, k) {
  const [r, g, b] = hexToRgb(hex)
  const target = k >= 0 ? 255 : 0
  const amount = Math.abs(k)
  const mix = channel => Math.round(channel + (target - channel) * amount)
  return `#${[mix(r), mix(g), mix(b)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Frame color for one animation tick: a slow breath overlaid with a hard
 * flash, so the frame reads as pulsing rather than merely fading.
 *
 * @param hex - base warning color.
 * @param tick - frame counter.
 */
export function pulseColor(hex, tick) {
  const phase = ((tick % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES
  const breath = 0.5 + 0.5 * Math.sin((phase / BREATH_FRAMES) * Math.PI * 2)
  const flash = Math.floor(Math.max(0, tick) / FLASH_FRAMES) % 2 === 0 ? 1 : 0
  const level = Math.min(1, 0.2 + 0.45 * breath + 0.35 * flash)
  return shade(hex, clamp01(level * 0.75) - 0.18)
}

/** One frame of the travelling waveform. */
export function waveFrame(tick, length = 6) {
  const size = Math.max(1, Math.min(WAVE.length, Math.floor(length)))
  let out = ''
  for (let index = 0; index < size; index += 1) {
    out += WAVE[(((tick + index) % WAVE.length) + WAVE.length) % WAVE.length]
  }
  return out
}

/** Colored spans for the model's parts, honoring the optional frame color. */
function renderParts(React, Text, model, frameColor) {
  return model.parts.map(part => {
    const color = part.tone === 'peak' && frameColor !== undefined
      ? frameColor
      : (TONE_COLORS[part.tone] ?? 'text')
    return React.createElement(
      Text,
      { key: part.key, color },
      part.key === 'phase' ? part.text : ` · ${part.text}`,
    )
  })
}

/**
 * Build the status-view component for one store.
 *
 * @param store - display-model store written by the plugin wiring.
 * @returns A component for `tuiStatus.registerView({ component })`.
 */
export function createStatusView(store) {
  return function PeakBalanceStatusView({ React, ui }) {
    const { Box, Text } = ui
    const [model, setModel] = React.useState(() => store.get())
    React.useEffect(() => store.subscribe(() => setModel(store.get())), [])

    const warn = model !== undefined && model.warn === true
    const [tick, setTick] = React.useState(0)
    React.useEffect(() => {
      if (!warn) return undefined
      const timer = setInterval(() => setTick(value => (value + 1) % 4096), FRAME_MS)
      // The host owns process lifetime; an unref'd timer can never hold it open.
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, [warn])

    if (model === undefined || model.parts.length === 0) return null

    if (!warn) {
      return React.createElement(
        Box,
        {
          flexDirection: 'row',
          paddingLeft: VIEW_INDENT_CELLS,
          marginTop: VIEW_TOP_GAP_ROWS,
        },
        React.createElement(Text, { wrap: 'truncate' }, renderParts(React, Text, model, undefined)),
      )
    }

    const frameColor = pulseColor(model.colorHex, tick)
    return React.createElement(
      Box,
      {
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: frameColor,
        paddingX: 1,
        marginLeft: VIEW_INDENT_CELLS,
      },
      React.createElement(
        Box,
        { flexDirection: 'row' },
        React.createElement(
          Box,
          { flexShrink: 1, minWidth: 0 },
          React.createElement(Text, { wrap: 'truncate' }, renderParts(React, Text, model, frameColor)),
        ),
        React.createElement(Box, { flexGrow: 1 }),
        React.createElement(
          Box,
          { flexShrink: 0 },
          React.createElement(Text, { color: frameColor }, waveFrame(tick)),
        ),
      ),
    )
  }
}
