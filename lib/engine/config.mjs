/** Explicit configuration and private local storage. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const FOUNDRY_HOME = process.env.FOUNDRY_HOME || join(DSH_HOME, 'research-foundry')
export const CONFIG_PATH = join(FOUNDRY_HOME, 'config.json')

export const DEFAULT_CODEX_BIN = 'codex'

/** 三线默认配置：模型名、端点、协议都可以改。 */
export function defaultConfig() {
  return {
    version: 1,
    language: 'zh',
    venue: 'neurips',
    vault: join(FOUNDRY_HOME, 'vault'),
    lanes: {
      deepseek: {
        enabled: true,
        kind: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        model: '',
        apiKey: '',
        lens: 'mechanism',
      },
      claude: {
        enabled: true,
        kind: 'anthropic',
        label: 'Claude',
        baseUrl: 'https://api.anthropic.com',
        model: '',
        apiKey: '',
        lens: 'measurement',
      },
      chatgpt: {
        enabled: true,
        kind: 'codex',
        label: 'ChatGPT (Codex)',
        bin: DEFAULT_CODEX_BIN,
        model: '',
        reasoning: 'medium',
        lens: 'analogy',
      },
    },
    protocol: {
      lead: 'claude',
      seedsPerLane: 3,
      maxTokensDiverge: 3200,
      maxTokensCritique: 2400,
      maxTokensSynthesis: 5000,
      timeoutMs: 300000,
      retries: 2,
      keepTopSeeds: 6,
    },
    weights: { novelty: 0.35, significance: 0.3, feasibility: 0.2, testability: 0.15 },
  }
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

export function readConfigFile() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { return null }
}

export function loadConfig(overrides = {}) {
  const cfg = deepMerge(defaultConfig(), readConfigFile() || {})
  return deepMerge(cfg, overrides)
}

export function saveConfig(cfg) {
  mkdirSync(FOUNDRY_HOME, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(CONFIG_PATH, 0o600) } catch { /* 非 POSIX 忽略 */ }
  return CONFIG_PATH
}

/** Credentials come only from explicit config or environment; never persist environment keys. */
export async function resolveConfig(overrides = {}) {
  const cfg = loadConfig(overrides)
  cfg.lanes.deepseek.apiKey ||= process.env.DEEPSEEK_API_KEY || ''
  cfg.lanes.claude.apiKey ||= process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || ''
  cfg.lanes.deepseek.model = process.env.DEEPSEEK_MODEL || cfg.lanes.deepseek.model
  cfg.lanes.claude.model = process.env.ANTHROPIC_MODEL || cfg.lanes.claude.model
  cfg.lanes.chatgpt.bin = process.env.CODEX_BIN || cfg.lanes.chatgpt.bin
  return cfg
}

/** Return a fully redacted view for UI/logging. */
export function maskConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg))
  for (const lane of Object.values(out.lanes || {})) {
    if (lane.apiKey) lane.apiKey = '[REDACTED]'
  }
  return out
}

export function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
  return p
}
