#!/usr/bin/env node
/**
 * Encoding pre-flight for dsh-peak-balance.
 *
 * The documented way to brick a dsh profile is a UTF-8 BOM: the loader
 * `JSON.parse`s manifests and settings documents directly, so `EF BB BF`
 * turns a plugin that "worked yesterday" into a host that refuses to start.
 * This script sweeps every shipped text file for that byte order mark, for
 * replacement characters (a file that was decoded with the wrong code page and
 * re-saved), for tabs used as YAML indentation, and for JSON that no longer
 * parses.
 *
 * Exits 1 with a reason on failure; never writes anything.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'coverage'])
const TEXT_EXTENSIONS = ['.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.md', '.txt', '']
const BOM = [0xef, 0xbb, 0xbf]

const failures = []
const fail = message => failures.push(message)

/** Every file in the package, minus VCS/dependency directories. */
function walk(directory) {
  const out = []
  for (const name of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(name)) continue
    const absolute = join(directory, name)
    if (statSync(absolute).isDirectory()) out.push(...walk(absolute))
    else out.push(absolute)
  }
  return out
}

const files = walk(root)
let checked = 0

for (const absolute of files) {
  const rel = relative(root, absolute).split('\\').join('/')
  const bytes = readFileSync(absolute)

  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    fail(`UTF-8 BOM found (would break the host's JSON.parse): ${rel}`)
    continue
  }

  const extension = rel.slice(rel.lastIndexOf('.'))
  const isText = TEXT_EXTENSIONS.includes(rel.includes('.') ? extension : '')
  if (!isText) continue
  checked += 1

  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD')) {
    fail(`replacement character (encoding damage) in: ${rel}`)
  }

  if (extension === '.json') {
    try {
      JSON.parse(text)
    } catch (error) {
      fail(`invalid JSON in ${rel}: ${error.message}`)
    }
  }

  if (extension === '.yml' || extension === '.yaml') {
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (/^\t| +\t/.test(line)) {
        fail(`tab used as YAML indentation in ${rel}:${index + 1} (YAML forbids tabs)`)
      }
    })
  }

  if (rel === 'cordis.patch.yml') {
    if (!/^- insert:/m.test(text)) fail('cordis.patch.yml must contain a top-level "- insert:" entry')
    if (!/^\s+- id: dsh-peak-balance$/m.test(text)) {
      fail('cordis.patch.yml must insert the row id "dsh-peak-balance"')
    }
    if (!/^\s+name: 'dsh-peak-balance'$/m.test(text)) {
      fail('cordis.patch.yml must insert the row name "dsh-peak-balance"')
    }
  }
}

// The manifest and the patch are the two files the host parses before any of
// this plugin's code runs; name them explicitly so the check stays meaningful
// even if the walk above ever narrows.
for (const required of ['package.json', 'dsh-plugin.json', 'cordis.patch.yml']) {
  const absolute = join(root, required)
  try {
    const bytes = readFileSync(absolute)
    if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
      fail(`UTF-8 BOM found in the required file: ${required}`)
    }
  } catch (error) {
    fail(`required file is unreadable: ${required} (${error.message})`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`❌ ${failure}`)
  process.exit(1)
}
console.log(`✅ encoding verified (${checked} text files, no BOM, no damaged sequences)`)
