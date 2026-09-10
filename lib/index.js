/**
 * dsh-peak-balance — Cordis entry.
 *
 * This module is deliberately a shell: it re-exports exactly the three symbols
 * the host reads from a plugin entry (`name`, `Config`, `apply`) and nothing
 * else. A module namespace carrying extra symbols changes how the loader wraps
 * the activation, and the dsh-tui seams then reject its registrations with
 * `requires a live Cordis activation context` — the plugin looks half-alive
 * (the settings namespace registers, the card and the status line never
 * appear). The shipped TUI plugins have this same minimal shape.
 *
 * Implementation lives in `./plugin.js`; `test/entry.test.js` pins the shape.
 *
 * @module dsh-peak-balance
 */

export { Config, apply, name } from './plugin.js'
