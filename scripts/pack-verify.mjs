#!/usr/bin/env node
/**
 * Package-layout verification for dsh-peak-balance.
 *
 * `files` decides what `dsh plugin add` copies into a profile, so a module the
 * entry imports but the file set omits is a plugin that loads locally and dies
 * after install. This script walks every relative import reachable from the
 * manifest entry and proves it lands inside the published set — the same
 * failure the host would hit on the next restart.
 *
 * Exits 1 with a reason on failure; never writes anything.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const failures = []
const fail = message => failures.push(message)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'dsh-plugin.json'), 'utf8'))
const files = pkg.files ?? []

/** Whether a repo-relative path is inside the published file set. */
function published(relPath) {
  const normalized = relPath.split('\\').join('/')
  return files.some(entry => normalized === entry || normalized.startsWith(`${entry.replace(/\/$/, '')}/`))
}

// A. Every declared entry exists and is published.
const entry = manifest.facets?.host?.entry
if (typeof entry !== 'string') fail('manifest has no facets.host.entry')
else if (!existsSync(join(root, entry))) fail(`entry file is missing: ${entry}`)
else if (!published(entry)) fail(`entry file is not in package.json "files": ${entry}`)

// B. Walk relative imports from the entry, inside lib/ only.
const seen = new Set()
const queue = [entry]
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"()]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g

while (queue.length > 0) {
  const current = queue.shift()
  if (seen.has(current)) continue
  seen.add(current)
  const absolute = join(root, current)
  if (!existsSync(absolute)) continue
  const source = readFileSync(absolute, 'utf8')
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2]
    const target = relative(root, resolve(dirname(absolute), specifier)).split('\\').join('/')
    if (!published(target)) fail(`${current} imports ${specifier}, which is outside the published file set`)
    if (!existsSync(join(root, target))) fail(`${current} imports ${specifier}, which does not exist`)
    if (target.startsWith('lib/')) queue.push(target)
  }
}

// C. Published lib/ files must be reachable (no orphan module left behind).
const libFiles = []
const walk = directory => {
  for (const name of readdirSync(join(root, directory))) {
    const rel = `${directory}/${name}`
    if (statSync(join(root, rel)).isDirectory()) walk(rel)
    else if (name.endsWith('.js')) libFiles.push(rel)
  }
}
if (existsSync(join(root, 'lib'))) walk('lib')
for (const file of libFiles) {
  if (!seen.has(file)) fail(`lib module is never imported from the entry: ${file}`)
}

// D. Nothing private may ship: tests, scripts and support helpers stay out.
for (const entryName of ['test', 'test-support', 'scripts', '.github', 'node_modules']) {
  if (published(entryName)) fail(`"files" must not publish ${entryName}/`)
}

// E. Required package metadata.
for (const field of ['name', 'version', 'description', 'license', 'type', 'main', 'exports', 'engines']) {
  if (pkg[field] === undefined) fail(`package.json is missing "${field}"`)
}
if (pkg.type !== 'module') fail('package.json must declare type: module')
if (pkg.main !== entry) fail(`package.json "main" (${pkg.main}) must equal the manifest entry (${entry})`)
if (!/^\^22\.19 \|\| >=24$/.test(pkg.engines?.node ?? '')) {
  fail('engines.node must stay "^22.19 || >=24"')
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`❌ ${failure}`)
  process.exit(1)
}
console.log(`✅ package layout verified (${seen.size} published modules, no missing imports)`)
