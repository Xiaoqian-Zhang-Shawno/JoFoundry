/** Explicit configuration and private local storage. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const FOUNDRY_HOME = process.env.FOUNDRY_HOME || join(DSH_HOME, 'research-foundry')
export const CONFIG_PATH = join(FOUNDRY_HOME, 'config.json')

export const DEFAULT_CODEX_BIN = 'codex'

/** Example roles; lane IDs, protocols and participant count are configurable. */
export function defaultConfig() {
  return {
    version: 1,
    language: 'zh',
    venue: 'neurips',
    vault: join(FOUNDRY_HOME, 'vault'),
    lanes: {
      controller: {
        enabled: true, kind: 'openai', label: '总控', role: 'controller',
        baseUrl: '', model: '', apiKey: '',
        baseUrlEnv: 'FOUNDRY_CONTROLLER_BASE_URL', modelEnv: 'FOUNDRY_CONTROLLER_MODEL', apiKeyEnv: 'FOUNDRY_CONTROLLER_API_KEY',
        lens: 'mechanism',
      },
      worker: {
        enabled: true, kind: 'openai', label: '执行者',
        baseUrl: '', model: '', apiKey: '',
        baseUrlEnv: 'FOUNDRY_WORKER_BASE_URL', modelEnv: 'FOUNDRY_WORKER_MODEL', apiKeyEnv: 'FOUNDRY_WORKER_API_KEY',
        lens: 'measurement',
      },
    },
    protocol: {
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
  const merge = (base, patch) => {
    const out = deepMerge(base, patch)
    if (patch?.lanes) out.lanes = deepMerge({}, patch.lanes)
    return out
  }
  return merge(merge(defaultConfig(), readConfigFile() || {}), overrides)
}

export function enabledLanes(cfg) {
  return Object.keys(cfg.lanes || {}).filter(k => cfg.lanes[k] && cfg.lanes[k].enabled !== false)
}

export function controllerLane(cfg) {
  const active = enabledLanes(cfg)
  const id = cfg.protocol?.controller || cfg.protocol?.lead || active.find(k => cfg.lanes[k].role === 'controller') || active[0]
  if (!active.includes(id)) throw new Error('总控线路未配置或已禁用')
  return id
}

function selectLanes(cfg, selected, fallback) {
  const ids = selected ?? fallback
  if (!Array.isArray(ids) || !ids.length) throw new Error('参与线路列表不能为空')
  const active = enabledLanes(cfg)
  for (const id of ids) if (!active.includes(id)) throw new Error(`线路未配置或已禁用: ${id}`)
  return [...new Set(ids)]
}

export function workerLanes(cfg, selected) {
  const controller = controllerLane(cfg)
  const ids = selectLanes(cfg, selected ?? cfg.protocol?.workers, enabledLanes(cfg).filter(k => k !== controller))
  if (ids.includes(controller)) throw new Error('总控不能同时作为本轮执行者')
  return ids
}

export function reviewConfig(cfg) {
  const lanes = selectLanes(cfg, cfg.protocol?.reviewers, enabledLanes(cfg))
  const rounds = cfg.protocol?.reviewRounds ?? 10
  const ratio = cfg.protocol?.reviewPassRatio ?? 0.8
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('reviewRounds 必须为 1–100 的整数')
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new Error('reviewPassRatio 必须在 (0, 1]')
  const planned = lanes.length * rounds
  return { lanes, rounds, planned, threshold: Math.ceil(planned * ratio) }
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
  for (const [id, lane] of Object.entries(cfg.lanes || {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) || ['constructor', 'prototype'].includes(id)) throw new Error(`无效线路 ID: ${id}`)
    for (const field of ['apiKey', 'model', 'baseUrl', 'bin']) {
      const env = lane[`${field}Env`]
      if (env && process.env[env]) lane[field] = process.env[env]
    }
    // Compatibility with explicitly configured legacy provider IDs.
    if (id === 'deepseek') { lane.apiKey ||= process.env.DEEPSEEK_API_KEY || ''; lane.model ||= process.env.DEEPSEEK_MODEL || '' }
    if (id === 'claude') { lane.apiKey ||= process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || ''; lane.model ||= process.env.ANTHROPIC_MODEL || '' }
    if (lane.kind === 'codex') lane.bin = process.env.CODEX_BIN || lane.bin || DEFAULT_CODEX_BIN
  }
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
