#!/usr/bin/env node
/**
 * Regenerate `lib/providers/catalog.js`.
 *
 * The LLM seam publishes only `{ id, name }` per provider route, so a quota
 * probe needs its own table of what dsh can host: which base URL a route talks
 * to and which credential reference its key usually comes from. That table is
 * generated, not hand-typed, because `@earendil-works/pi-ai` ships it — and the
 * snapshot has to carry the pi-ai version so a stale file is obvious.
 *
 * The generated module is *data*: nothing at runtime imports pi-ai, and a
 * consumer treats a missing entry as "unknown provider".
 *
 * Usage:
 *   node scripts/gen-provider-catalog.mjs [path/to/@earendil-works/pi-ai]
 *
 * Without an argument the package is resolved from the running dsh installation
 * (Node resolution first, then the npx cache the launcher uses).
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUTPUT = join(here, '..', 'lib', 'providers', 'catalog.js')

/** Candidate locations for the pi-ai package, cheapest first. */
function resolvePiAi(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return explicit
  try {
    const require = createRequire(import.meta.url)
    return dirname(require.resolve('@earendil-works/pi-ai/package.json'))
  } catch {
    // Not resolvable from here: fall through to the launcher's cache.
  }
  const cache = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'npm-cache', '_npx')
  if (!existsSync(cache)) return undefined
  const candidates = readdirSync(cache)
    .map(name => join(cache, name, 'node_modules', '@earendil-works', 'pi-ai'))
    .filter(dir => existsSync(join(dir, 'package.json')))
    .sort((a, b) => (readFileSync(join(b, 'package.json'), 'utf8').length - readFileSync(join(a, 'package.json'), 'utf8').length))
  return candidates[0]
}

/** Environment references named by an `envApiKeyAuth(...)` call, best effort. */
function envRefsOf(source) {
  const refs = []
  const pattern = /envApiKeyAuth\s*\(([\s\S]{0,200}?)\)\s*[,)]/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    for (const quoted of match[1].matchAll(/"([A-Z0-9_]+)"/g)) {
      if (!refs.includes(quoted[1])) refs.push(quoted[1])
    }
  }
  return refs
}

/** Protocol ids named inside the provider's `api` block, best effort. */
function protocolsOf(source) {
  const block = source.match(/api:\s*\{([\s\S]{0,400}?)\n\s*\}/)
  if (block === null) return []
  return [...block[1].matchAll(/"([a-z][a-z0-9-]+)"\s*:/g)].map(match => match[1])
}

/** Every provider object one provider module exports. */
async function providersOf(filePath) {
  const module = await import(pathToFileURL(filePath).href)
  const out = []
  for (const [exportName, value] of Object.entries(module)) {
    if (typeof value !== 'function' || !/Provider$/.test(exportName)) continue
    if (value.length > 0) continue // factories here take no arguments
    try {
      const provider = value()
      if (provider !== null && typeof provider === 'object' && typeof provider.id === 'string') out.push(provider)
    } catch {
      // A provider whose factory needs runtime state is skipped, not fatal.
    }
  }
  return out
}

async function main() {
  const explicit = process.argv[2]
  const packageDir = resolvePiAi(explicit)
  if (packageDir === undefined || !existsSync(packageDir)) {
    console.error('gen-provider-catalog: @earendil-works/pi-ai not found; pass its path as the first argument')
    process.exitCode = 1
    return
  }
  const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const providersDir = join(packageDir, 'dist', 'providers')
  const files = readdirSync(providersDir)
    .filter(name => name.endsWith('.js') && !name.endsWith('.models.js'))
    .sort()

  const table = {}
  for (const name of files) {
    const filePath = join(providersDir, name)
    const source = readFileSync(filePath, 'utf8')
    const envRefs = envRefsOf(source)
    const protocols = protocolsOf(source)
    for (const provider of await providersOf(filePath)) {
      const entry = {
        name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
      }
      if (typeof provider.baseUrl === 'string' && provider.baseUrl !== '') entry.baseUrl = provider.baseUrl
      if (envRefs.length > 0) entry.apiKeyEnv = envRefs[0]
      if (protocols.length > 0) entry.protocol = protocols[0]
      if (provider.headers !== null && typeof provider.headers === 'object' && Object.keys(provider.headers).length > 0) {
        entry.headers = provider.headers
      }
      table[provider.id] = entry
    }
  }

  const ids = Object.keys(table).sort()
  const sorted = Object.fromEntries(ids.map(id => [id, table[id]]))
  // The object body without its braces: the module wraps it in `Object.freeze`.
  const body = ids
    .map(id => `  ${JSON.stringify(id)}: ${JSON.stringify(sorted[id], null, 2).replace(/\n/g, '\n  ')},`)
    .join('\n')
  const source = `/**
 * The provider catalog snapshot (GENERATED — do not edit by hand).
 *
 * Regenerate with \`node scripts/gen-provider-catalog.mjs [pi-ai path]\`. The
 * snapshot records the pi-ai release it was taken from; a provider missing here
 * is still reachable through a spec file (\`./spec.js\`).
 *
 * @module dsh-peak-balance/providers/catalog
 */

/** Provenance of the snapshot. */
export const CATALOG_SOURCE = Object.freeze({
  package: '@earendil-works/pi-ai',
  version: ${JSON.stringify(packageJson.version ?? '')},
  generatedAt: ${JSON.stringify(new Date().toISOString())},
})

/**
 * \`provider route id -> { name, baseUrl?, apiKeyEnv?, protocol?, headers? }\`.
 *
 * Metadata only: no model list, no pricing, no secrets.
 */
export const PROVIDER_CATALOG = Object.freeze({
${body}
})

/** One catalog entry, or \`undefined\`. */
export function catalogEntry(provider) {
  if (typeof provider !== 'string' || provider === '') return undefined
  const entry = PROVIDER_CATALOG[provider]
  return entry === undefined ? undefined : entry
}

/** Every provider id the snapshot knows, sorted. */
export function catalogIds() {
  return Object.keys(PROVIDER_CATALOG)
}
`
  writeFileSync(OUTPUT, source)
  console.log(`gen-provider-catalog: wrote ${ids.length} providers from pi-ai ${packageJson.version} -> ${realpathSync(OUTPUT)}`)
}

await main()
