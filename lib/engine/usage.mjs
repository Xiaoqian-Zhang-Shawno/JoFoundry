/** Local call statistics and explicitly enabled API-key quota queries. */
import { createHash } from 'node:crypto'
import { orderedProviders, providerConfig } from './config.mjs'
const CACHE_MS = 60_000

// Conservative heuristic for memory pressure, not a provider specification.
const DEFAULT_WINDOWS = {}
export function laneWindow(lane) {
  return DEFAULT_WINDOWS[lane] || 200_000
}

export const laneStats = {}

export function recordCall(lane, { inputTokens = null, outputTokens = null, promptChars = 0, ms = 0, ok = true } = {}) {
  const s = (laneStats[lane] ||= {
    calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, lastInput: null, lastInputEstimated: false,
    maxInput: 0, lastAt: null, since: new Date().toISOString(),
  })
  s.calls += 1
  if (!ok) { s.failures += 1; return }
  // codex 不返回输入 token：按字符估算（中英混排约 1.6 字符/token），标注为估算
  const est = inputTokens == null && promptChars ? Math.round(promptChars / 1.6) : null
  const input = inputTokens ?? est
  if (input != null) {
    s.inputTokens += input
    s.lastInput = input
    s.lastInputEstimated = inputTokens == null
    s.maxInput = Math.max(s.maxInput, input)
  }
  if (outputTokens != null) s.outputTokens += outputTokens
  s.lastAt = new Date().toISOString()
  s.lastMs = ms
}

function attachContext(lane, u) {
  const s = laneStats[lane]
  u.session = s ? { ...s } : null
  const w = u.window?.input
  if (w && s?.lastInput != null) {
    u.context = {
      window: w, lastInput: s.lastInput, maxInput: s.maxInput, estimated: s.lastInputEstimated,
      remaining: Math.max(0, w - s.lastInput), usedPercent: Math.round((s.lastInput / w) * 1000) / 10,
    }
  } else if (w) {
    u.context = { window: w, lastInput: null, remaining: w, usedPercent: 0 }
  }
  return u
}

const quotaCache = new WeakMap()

async function queryBalance(origin, apiKey) {
  const lmu = origin === 'https://api.lmuai.ai'
  const path = lmu ? '/v1/user/balance' : '/api/v1/key'
  const response = await fetch(origin + path, {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return { balanceError: `余额查询失败（HTTP ${response.status}）` }
  const payload = await response.json()
  if (lmu) {
    if (!Number.isFinite(payload?.balance)) return { balanceError: '供应商未返回可用额度' }
    return { balanceLabel: '当前密钥可用额度', balance: {
      total: payload.balance,
      unit: payload.unit === 'requests' ? 'requests' : 'USD',
      available: payload.is_active !== false,
    } }
  }

  const data = payload?.data
  if (!Number.isFinite(data?.usage)) return { balanceError: '供应商未返回密钥用量' }
  if (!Number.isFinite(data.limit_remaining)) return {
    keyUsage: data.usage, balanceError: '当前密钥无独立限额，账户余额可在供应商控制台查看',
  }
  return { keyUsage: data.usage, balanceLabel: '密钥限额剩余', balance: {
    total: data.limit_remaining, unit: 'USD', available: data.limit_remaining > 0,
  } }
}

async function laneUsage(lane, force, includeBalance) {
  const provider = orderedProviders(lane)[0]
  const active = provider ? providerConfig(lane, provider) : lane
  const out = { label: lane.label, model: active.model, provider: provider?.label || provider?.id }
  if (!includeBalance || lane.enabled === false || active.balance !== true || process.env.FOUNDRY_MOCK === '1') return out
  if (lane.providers?.length && !provider) return { ...out, balanceError: '没有启用的供应商' }
  let origin
  try { origin = new URL(active.baseUrl).origin } catch { /* Invalid or missing base URL. */ }
  if (!['https://api.lmuai.ai', 'https://openrouter.ai'].includes(origin)) {
    return { ...out, balanceError: '此供应商尚未接入余额查询' }
  }
  if (!active.apiKey) return { ...out, balanceError: '未配置供应商 API 密钥' }

  const key = createHash('sha256').update(JSON.stringify([provider?.id, origin, active.apiKey])).digest('hex')
  let cache = quotaCache.get(lane)
  if (!cache || cache.key !== key || (!cache.pending && (force || Date.now() - cache.at >= CACHE_MS))) {
    cache = { key, pending: true, at: 0, result: null }
    const entry = cache
    entry.result = queryBalance(origin, active.apiKey)
      .catch(() => ({ balanceError: '暂时无法读取供应商额度' }))
      .finally(() => { entry.at = Date.now(); entry.pending = false })
    quotaCache.set(lane, entry)
  }
  return { ...out, ...(await cache.result) }
}

export async function getUsage(cfg, { force = false, includeBalance = true } = {}) {
  const lanes = await Promise.all(Object.entries(cfg.lanes || {}).map(async ([name, lane]) =>
    [name, attachContext(name, await laneUsage(lane, force, includeBalance))]))
  return { fetchedAt: new Date().toISOString(), lanes: Object.fromEntries(lanes) }
}
