#!/usr/bin/env node
/**
 * Manifest sanity check for dsh-peak-balance.
 *
 * Mirrors the admission-driven shape a dsh-tui host enforces (TUI-PKG-001 /
 * TUI-PKG-002) without depending on @dsh-std/manifest: the manifest must parse,
 * keep the v0.15 shape, declare every sibling file it needs, and agree with
 * package.json on id-independent facts (version, launcher entry).
 *
 * Exits 1 with a reason on failure; never writes anything.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const failures = []
const fail = message => failures.push(message)

let manifest
try {
  manifest = JSON.parse(readFileSync(join(root, 'dsh-plugin.json'), 'utf8'))
} catch (error) {
  console.error(`❌ dsh-plugin.json is not valid JSON: ${error.message}`)
  process.exit(1)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`❌ package.json is not valid JSON: ${error.message}`)
  process.exit(1)
}

// A. Identity
if (manifest.$schema !== 'https://dsh.community/schemas/dsh-plugin-0.15.json') {
  fail('$schema must be the absolute dsh-plugin-0.15.json URI')
}
if (manifest.manifestVersion !== '0.15') fail('manifestVersion must be "0.15"')
if (typeof manifest.id !== 'string' || !manifest.id.includes('.') || manifest.id.length < 8) {
  fail('plugin id must be a stable reverse-DNS string')
}
if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? '')) fail('version must be semver')
if (pkg.version !== manifest.version) {
  fail(`package.json version (${pkg.version}) must equal the manifest version (${manifest.version})`)
}
if (manifest.name !== pkg.name) fail('manifest name must equal the package name')

// B. Facet — v0.15 allows the host facet only, entry + apiVersion.
const host = manifest.facets?.host
if (!host || typeof host.entry !== 'string' || host.apiVersion !== 'v1alpha1') {
  fail('facets.host must declare entry + apiVersion "v1alpha1"')
}
if (manifest.facets?.client || manifest.facets?.worker) {
  fail('client/worker facets are not allowed in v0.15')
}
if (typeof host?.entry === 'string' && !existsSync(join(root, host.entry))) {
  fail(`facets.host.entry does not exist: ${host.entry}`)
}

// C. Requirements — exactly two contract coordinates:
//    * `tui.dsh/v1alpha1#DecisionEvents` stays OPTIONAL: the session-switch
//      notification behind it makes the status line follow the focused
//      conversation, while every host without the capability covers the same
//      feature from the focused-session marker. A required declaration would
//      make such a host REFUSE ADMISSION outright (negotiate -> rejected),
//      taking the whole plugin down; an optional contract without a fallback
//      is refused by admission too.
//    * `commands.dsh/v1alpha1#Command` is required: `/th` (and its
//      `/tokenhistory` alias) are the plugin's other half, and the mediated
//      `tuiPluginHost.registerCommand` path refuses a component that does not
//      declare it.
// `subscriptions` must stay empty: the registry carries no `event` entry for
// this capability, so a subscription row referencing it fails admission.
if (!Array.isArray(manifest.requires?.contracts)) fail('requires.contracts must be an array')
if (manifest.requires?.services) fail('requires.services must not be declared (v0.15)')
if (manifest.provides) fail('provides must not be declared (v0.15)')
if (!Array.isArray(manifest.permissions)) fail('permissions must be an array')
if (!Array.isArray(manifest.subscriptions)) fail('subscriptions must be an array')
if ((manifest.subscriptions ?? []).length > 0) {
  fail('subscriptions must stay empty — no registry event backs the session-switch capability')
}
const contracts = manifest.requires?.contracts ?? []
for (const contract of contracts) {
  if (typeof contract !== 'object' || contract === null) {
    fail('requires.contracts entries must be objects')
    continue
  }
  const coordinate = `${contract.apiVersion}#${contract.kind}`
  if (coordinate === 'tui.dsh/v1alpha1#DecisionEvents') {
    if (contract.optional !== true) {
      fail('the DecisionEvents contract must be optional, or a host without it refuses admission')
    }
    if (typeof contract.fallback !== 'string' || contract.fallback === '') {
      fail('an optional contract must declare the fallback that covers it')
    }
  } else if (coordinate === 'commands.dsh/v1alpha1#Command') {
    if (contract.optional === true) fail('the Command contract must be required to register /th')
  } else {
    fail(`unexpected required contract: ${coordinate}`)
  }
}
const coordinates = contracts.map(contract => `${contract?.apiVersion}#${contract?.kind}`)
for (const expected of ['tui.dsh/v1alpha1#DecisionEvents', 'commands.dsh/v1alpha1#Command']) {
  if (!coordinates.includes(expected)) fail(`requires.contracts must include ${expected}`)
}
if (coordinates.length !== new Set(coordinates).size) fail('requires.contracts must not repeat a coordinate')

// D. Contributions — exactly the command roots the wiring registers, and one
// `commands.invoke` grant per declared id (that permission is scoped to a single
// contribution id by the catalogue). `/hist` is the reliable short name; `/th`
// is kept for the owner's muscle memory (a bare `/th` is captured by the host's
// completion overlay, which is why the description says so). `/quota` reports
// which provider adapter answers and why it last failed.
const COMMAND_IDS = [
  'com.dsh-tui-ecosystem.dsh-peak-balance.hist',
  'com.dsh-tui-ecosystem.dsh-peak-balance.th',
  'com.dsh-tui-ecosystem.dsh-peak-balance.tokenhistory',
  'com.dsh-tui-ecosystem.dsh-peak-balance.quota',
]
const contributions = manifest.contributes?.commands
if (!Array.isArray(contributions)) fail('contributes.commands must be an array')
else {
  const ids = contributions.map(contribution => contribution?.id)
  if (ids.length !== COMMAND_IDS.length || !COMMAND_IDS.every(id => ids.includes(id))) {
    fail(`contributes.commands must declare exactly ${COMMAND_IDS.join(', ')}`)
  }
  for (const contribution of contributions) {
    if (typeof contribution?.title !== 'string' || contribution.title === '') {
      fail(`contribution ${contribution?.id ?? '?'} needs a title`)
    }
    if (typeof contribution?.description !== 'string' || contribution.description === '') {
      fail(`contribution ${contribution?.id ?? '?'} needs a description`)
    }
  }
}
const permissions = manifest.permissions ?? []
if (permissions.length !== COMMAND_IDS.length) {
  fail(`permissions must grant commands.invoke for exactly ${COMMAND_IDS.length} command ids`)
}
for (const permission of permissions) {
  if (permission?.name !== 'commands.invoke') {
    fail(`unexpected permission: ${permission?.name} (only commands.invoke is granted)`)
    continue
  }
  if (!COMMAND_IDS.includes(permission.scope)) {
    fail(`commands.invoke scope must be a declared contribution id, saw ${permission.scope}`)
  }
  if (typeof permission.reason !== 'string' || permission.reason === '') {
    fail(`commands.invoke for ${permission.scope} needs a reason`)
  }
}
for (const id of COMMAND_IDS) {
  if (!permissions.some(permission => permission?.scope === id)) {
    fail(`permissions must grant commands.invoke for scope ${id}`)
  }
}

// E. Runtime declarations must not drift from what the code imports.
const peers = Object.keys(pkg.peerDependencies ?? {})
for (const dependency of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
  if (!peers.includes(dependency)) fail(`peerDependencies must declare ${dependency}`)
  if (!(dependency in (pkg.devDependencies ?? {}))) {
    fail(`devDependencies must mirror the peer ${dependency} so local tests can resolve it`)
  }
}

// F. Bundle patch — a bundle without its patch row never loads.
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('package.json must declare dsh.bundle.patch = "./cordis.patch.yml"')
}
if (!existsSync(join(root, 'cordis.patch.yml'))) fail('cordis.patch.yml is missing')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('dsh-peak-balance')) fail('cordis.patch.yml must insert the dsh-peak-balance row')

// G. License + published file set.
if (manifest.license !== 'MIT') fail('license must be MIT')
for (const required of ['README.md', 'LICENSE', 'CHANGELOG.md', 'lib/index.js']) {
  if (!existsSync(join(root, required))) fail(`missing published file: ${required}`)
  if (!(pkg.files ?? []).some(entry => required === entry || required.startsWith(`${entry}/`))) {
    fail(`package.json "files" must include ${required}`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`❌ ${failure}`)
  process.exit(1)
}
console.log(`✅ dsh-plugin.json looks valid (id=${manifest.id}, version=${manifest.version})`)
