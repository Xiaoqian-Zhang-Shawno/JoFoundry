/** Local call statistics; no account/login/session-log discovery. */
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

export async function getUsage(cfg) {
  const lanes = Object.fromEntries(Object.entries(cfg.lanes || {}).map(([name, lane]) => [name,
    attachContext(name, { label: lane.label, model: lane.model, balanceError: '公开版仅统计本服务调用；不读取其他应用登录态或日志' })
  ]))
  return { fetchedAt: new Date().toISOString(), lanes }
}
