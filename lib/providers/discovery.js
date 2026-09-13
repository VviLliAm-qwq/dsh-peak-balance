/**
 * Provider discovery — "what do I need in order to ask this provider anything?"
 *
 * The LLM seam publishes a route's identity (`{ id, name }`) and, for routes a
 * plugin declared, a pointer into its settings section
 * (`settingsNs` + `settingsPath`). That pointer is the only generic way to learn
 * a route's base URL and credential reference, because both are commonly
 * declared in a composition patch (`cordis.yml` / a bundle's patch) rather than
 * in `settings.yaml`.
 *
 * The chain is layered and every layer is optional:
 *
 *   spec `apiBases` / provider stanza → the route's own settings section →
 *   the generated catalog snapshot → nothing
 *
 * A miss at every layer is not an error: it means the quota probe cannot run for
 * that provider, and the caller says so instead of inventing an endpoint.
 *
 * @module dsh-peak-balance/providers/discovery
 */

import { catalogEntry } from './catalog.js'

/** Read the first non-empty string among the candidates. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Walk a settings path (`['providers', 'openrouter']`) over a section. */
export function drill(section, path) {
  if (!Array.isArray(path) || path.length === 0) return section
  let current = section
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/**
 * Find the seam's directory entry for one provider route.
 *
 * @param llmServices - candidate `ctx.llm` services (soft-probed by the caller).
 * @returns `{ provider, displayName, settingsNs, settingsPath, declared }`.
 */
export function findConfigurableProvider(llmServices, provider) {
  if (typeof provider !== 'string' || provider === '') return undefined
  for (const llm of Array.isArray(llmServices) ? llmServices : []) {
    try {
      const entries = llm?.listConfigurableProviders?.()
      if (!Array.isArray(entries)) continue
      const match = entries.find(entry => entry?.provider === provider)
      if (match !== undefined) {
        return {
          provider,
          displayName: firstText(match.displayName) ?? provider,
          settingsNs: firstText(match.settingsNs),
          settingsPath: Array.isArray(match.settingsPath) ? match.settingsPath : [],
          declared: match.declared === true,
        }
      }
    } catch {
      // A refusing seam is treated as "no directory entry".
    }
  }
  return undefined
}

/**
 * Read one provider's settings profile (`{ api, baseURL, apiKeyEnv, … }`).
 *
 * @param settingsServices - candidate `ctx.settings` services.
 * @param entry - a {@link findConfigurableProvider} result.
 */
export function readProviderSection(settingsServices, entry) {
  if (entry?.settingsNs === undefined) return undefined
  for (const settings of Array.isArray(settingsServices) ? settingsServices : []) {
    try {
      const section = settings?.get?.(entry.settingsNs)
      if (section === null || section === undefined) continue
      const profile = drill(section, entry.settingsPath)
      if (profile !== null && typeof profile === 'object') return profile
    } catch {
      // Unregistered namespace, or a seam that refuses: keep looking.
    }
  }
  return undefined
}

/**
 * Resolve everything a quota probe needs for one provider.
 *
 * @param options.provider - provider route id.
 * @param options.llmServices - candidate `ctx.llm` services.
 * @param options.settingsServices - candidate `ctx.settings` services.
 * @param options.spec - parsed spec document (`./spec.js`).
 * @returns `{ provider, displayName, baseUrl, apiKeyRef, declared, protocol, adapterHint, sources }`.
 */
export function discoverProvider(options = {}) {
  const provider = typeof options.provider === 'string' ? options.provider : ''
  const spec = options.spec ?? { apiBases: {}, providers: {} }
  const stanza = spec.providers?.[provider]
  const entry = findConfigurableProvider(options.llmServices, provider)
  const section = readProviderSection(options.settingsServices, entry)
  const catalog = catalogEntry(provider)

  const baseUrl = firstText(
    spec.apiBases?.[provider],
    stanza?.baseUrl,
    section?.baseURL,
    section?.baseUrl,
    section?.apiBase,
    catalog?.baseUrl,
  )
  const apiKeyRef = firstText(
    stanza?.apiKeyEnv,
    section?.apiKeyEnv,
    section?.apiKey,
    catalog?.apiKeyEnv,
  )
  const sources = []
  if (spec.apiBases?.[provider] !== undefined) sources.push('spec.apiBases')
  if (stanza?.baseUrl !== undefined) sources.push('spec.provider')
  if (firstText(section?.baseURL, section?.baseUrl, section?.apiBase) !== undefined) sources.push('settings section')
  if (catalog?.baseUrl !== undefined && baseUrl === catalog.baseUrl) sources.push('catalog')

  return {
    provider,
    displayName: firstText(stanza?.label, entry?.displayName, catalog?.name) ?? provider,
    baseUrl,
    apiKeyRef,
    declared: entry?.declared === true,
    protocol: firstText(section?.api, catalog?.protocol),
    stanza,
    sources,
  }
}

/**
 * Resolve a credential reference to its value.
 *
 * The credentials seam is consulted first (that is where the settings card and
 * the provider plugins store keys), the process environment second — the same
 * order this plugin has always used for `DEEPSEEK_API_KEY`.
 *
 * @param credentialsServices - candidate `ctx.credentials` services.
 * @param ref - environment-variable-style reference, e.g. `COMMANDCODE_API_KEY`.
 * @param env - environment (injected for tests).
 * @returns The secret, or `''` when nothing resolves. Never throws.
 */
export async function resolveCredential(credentialsServices, ref, env = process.env) {
  if (typeof ref !== 'string' || ref === '') return ''
  for (const credentials of Array.isArray(credentialsServices) ? credentialsServices : []) {
    try {
      const resolved = await credentials?.resolve?.(ref)
      if (typeof resolved?.value === 'string' && resolved.value !== '') return resolved.value
    } catch {
      // Refusing seam: fall through to the environment.
    }
  }
  const fromEnv = env?.[ref]
  return typeof fromEnv === 'string' ? fromEnv : ''
}
