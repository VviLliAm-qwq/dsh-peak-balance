import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The entry's export shape is load-bearing, not cosmetic.
 *
 * A Cordis entry that re-exports its internals (helpers, constants, extra
 * functions) is wrapped differently by the loader, and the dsh-tui seam
 * services then reject every registration from that activation with
 * `requires a live Cordis activation context`: the settings namespace still
 * registers, so the plugin looks half-alive while the settings card and the
 * status line never appear. Shipping a shell that exports exactly the three
 * contract symbols is what keeps the activation admissible.
 *
 * Regression: reproduced 2026-09-10 in a headless profile — the same module
 * registering from a sibling plugin's context succeeded, from its own row it
 * failed, and a `{ name, Config, apply }` shell fixed it.
 */
test('the entry exports exactly the contract symbols', async () => {
  const entry = await import('../lib/index.js')
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'name'])
  assert.equal(entry.name, 'dsh-peak-balance')
  assert.equal(typeof entry.apply, 'function')
  assert.equal(typeof entry.Config, 'function')
})

test('the entry has no default export', async () => {
  const entry = await import('../lib/index.js')
  assert.equal('default' in entry, false)
})

test('the entry re-exports the implementation rather than duplicating it', async () => {
  const entry = await import('../lib/index.js')
  const implementation = await import('../lib/plugin.js')
  assert.equal(entry.apply, implementation.apply)
  assert.equal(entry.Config, implementation.Config)
  assert.equal(entry.name, implementation.name)
})

test('the manifest entry points at the shell, and the shell really loads', async () => {
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.facets.host.entry, 'lib/index.js')
  const shell = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // The shell must stay a shell: one re-export line, no logic.
  assert.match(shell, /export \{ Config, apply, name \} from '\.\/plugin\.js'/)
  assert.doesNotMatch(shell, /^export (const|function) (?!Config|apply|name)/m)
})
