/**
 * The provider catalog snapshot (GENERATED — do not edit by hand).
 *
 * Regenerate with `node scripts/gen-provider-catalog.mjs [pi-ai path]`. The
 * snapshot records the pi-ai release it was taken from; a provider missing here
 * is still reachable through a spec file (`./spec.js`).
 *
 * @module dsh-peak-balance/providers/catalog
 */

/** Provenance of the snapshot. */
export const CATALOG_SOURCE = Object.freeze({
  package: '@earendil-works/pi-ai',
  version: "0.85.1",
  generatedAt: "2026-09-13T06:10:33.891Z",
})

/**
 * `provider route id -> { name, baseUrl?, apiKeyEnv?, protocol?, headers? }`.
 *
 * Metadata only: no model list, no pricing, no secrets.
 */
export const PROVIDER_CATALOG = Object.freeze({
  "amazon-bedrock": {
    "name": "Amazon Bedrock"
  },
  "ant-ling": {
    "name": "Ant Ling",
    "baseUrl": "https://api.ant-ling.com/v1",
    "apiKeyEnv": "ANT_LING_API_KEY"
  },
  "anthropic": {
    "name": "Anthropic",
    "baseUrl": "https://api.anthropic.com"
  },
  "azure-openai-responses": {
    "name": "Azure OpenAI",
    "apiKeyEnv": "AZURE_OPENAI_API_KEY"
  },
  "baseten": {
    "name": "Baseten",
    "baseUrl": "https://inference.baseten.co/v1",
    "apiKeyEnv": "BASETEN_API_KEY"
  },
  "cerebras": {
    "name": "Cerebras",
    "baseUrl": "https://api.cerebras.ai/v1",
    "apiKeyEnv": "CEREBRAS_API_KEY"
  },
  "cloudflare-ai-gateway": {
    "name": "Cloudflare AI Gateway",
    "protocol": "anthropic-messages"
  },
  "cloudflare-workers-ai": {
    "name": "Cloudflare Workers AI"
  },
  "deepseek": {
    "name": "DeepSeek",
    "baseUrl": "https://api.deepseek.com",
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "fireworks": {
    "name": "Fireworks",
    "baseUrl": "https://api.fireworks.ai/inference",
    "apiKeyEnv": "FIREWORKS_API_KEY",
    "protocol": "anthropic-messages"
  },
  "github-copilot": {
    "name": "GitHub Copilot",
    "baseUrl": "https://api.individual.githubcopilot.com",
    "apiKeyEnv": "COPILOT_GITHUB_TOKEN",
    "protocol": "anthropic-messages"
  },
  "google": {
    "name": "Google",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "apiKeyEnv": "GEMINI_API_KEY"
  },
  "google-vertex": {
    "name": "Google Vertex AI"
  },
  "groq": {
    "name": "Groq",
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyEnv": "GROQ_API_KEY"
  },
  "huggingface": {
    "name": "Hugging Face",
    "baseUrl": "https://router.huggingface.co/v1",
    "apiKeyEnv": "HF_TOKEN"
  },
  "kimi-coding": {
    "name": "Kimi For Coding",
    "baseUrl": "https://api.kimi.com/coding",
    "apiKeyEnv": "KIMI_API_KEY"
  },
  "minimax": {
    "name": "MiniMax",
    "baseUrl": "https://api.minimax.io/anthropic",
    "apiKeyEnv": "MINIMAX_API_KEY"
  },
  "minimax-cn": {
    "name": "MiniMax CN",
    "baseUrl": "https://api.minimaxi.com/anthropic",
    "apiKeyEnv": "MINIMAX_CN_API_KEY"
  },
  "mistral": {
    "name": "Mistral",
    "baseUrl": "https://api.mistral.ai",
    "apiKeyEnv": "MISTRAL_API_KEY"
  },
  "moonshotai": {
    "name": "Moonshot AI",
    "baseUrl": "https://api.moonshot.ai/v1",
    "apiKeyEnv": "MOONSHOT_API_KEY"
  },
  "moonshotai-cn": {
    "name": "Moonshot AI CN",
    "baseUrl": "https://api.moonshot.cn/v1",
    "apiKeyEnv": "MOONSHOT_API_KEY"
  },
  "nvidia": {
    "name": "NVIDIA",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "apiKeyEnv": "NVIDIA_API_KEY"
  },
  "openai": {
    "name": "OpenAI",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "openai-codex": {
    "name": "OpenAI Codex",
    "baseUrl": "https://chatgpt.com/backend-api"
  },
  "opencode": {
    "name": "OpenCode Zen",
    "apiKeyEnv": "OPENCODE_API_KEY",
    "protocol": "anthropic-messages"
  },
  "opencode-go": {
    "name": "OpenCode Go",
    "apiKeyEnv": "OPENCODE_API_KEY",
    "protocol": "anthropic-messages"
  },
  "openrouter": {
    "name": "OpenRouter",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "protocol": "anthropic-messages"
  },
  "qwen-token-plan": {
    "name": "Qwen Token Plan",
    "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "apiKeyEnv": "QWEN_TOKEN_PLAN_API_KEY"
  },
  "qwen-token-plan-cn": {
    "name": "Qwen Token Plan CN",
    "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "apiKeyEnv": "QWEN_TOKEN_PLAN_CN_API_KEY"
  },
  "qwen-token-plan-individual": {
    "name": "Qwen Token Plan Individual",
    "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "apiKeyEnv": "QWEN_TOKEN_PLAN_API_KEY"
  },
  "radius": {
    "name": "Radius",
    "apiKeyEnv": "RADIUS_API_KEY"
  },
  "together": {
    "name": "Together",
    "baseUrl": "https://api.together.ai/v1",
    "apiKeyEnv": "TOGETHER_API_KEY"
  },
  "vercel-ai-gateway": {
    "name": "Vercel AI Gateway",
    "baseUrl": "https://ai-gateway.vercel.sh",
    "apiKeyEnv": "AI_GATEWAY_API_KEY"
  },
  "xai": {
    "name": "xAI",
    "baseUrl": "https://api.x.ai/v1",
    "apiKeyEnv": "XAI_API_KEY"
  },
  "xiaomi": {
    "name": "Xiaomi",
    "baseUrl": "https://api.xiaomimimo.com/v1",
    "apiKeyEnv": "XIAOMI_API_KEY"
  },
  "xiaomi-token-plan-ams": {
    "name": "Xiaomi Token Plan AMS",
    "baseUrl": "https://token-plan-ams.xiaomimimo.com/v1",
    "apiKeyEnv": "XIAOMI_TOKEN_PLAN_AMS_API_KEY"
  },
  "xiaomi-token-plan-cn": {
    "name": "Xiaomi Token Plan CN",
    "baseUrl": "https://token-plan-cn.xiaomimimo.com/v1",
    "apiKeyEnv": "XIAOMI_TOKEN_PLAN_CN_API_KEY"
  },
  "xiaomi-token-plan-sgp": {
    "name": "Xiaomi Token Plan SGP",
    "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1",
    "apiKeyEnv": "XIAOMI_TOKEN_PLAN_SGP_API_KEY"
  },
  "zai": {
    "name": "Z.AI",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "apiKeyEnv": "ZAI_API_KEY"
  },
  "zai-coding-cn": {
    "name": "Z.AI Coding CN",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "apiKeyEnv": "ZAI_CODING_CN_API_KEY"
  },
})

/** One catalog entry, or `undefined`. */
export function catalogEntry(provider) {
  if (typeof provider !== 'string' || provider === '') return undefined
  const entry = PROVIDER_CATALOG[provider]
  return entry === undefined ? undefined : entry
}

/** Every provider id the snapshot knows, sorted. */
export function catalogIds() {
  return Object.keys(PROVIDER_CATALOG)
}
