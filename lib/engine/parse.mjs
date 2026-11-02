/** 从模型输出里稳健地抠出 JSON —— 各参与模型的"只输出 JSON"承诺都不可靠。 */

export function extractJSON(text) {
  if (!text || typeof text !== 'string') throw new Error('空输出')
  const s = text.trim()

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(s)

  for (const raw of candidates) {
    const direct = tryParse(raw)
    if (direct !== undefined) return direct
    const sliced = sliceBalanced(raw)
    if (sliced) {
      const parsed = tryParse(sliced)
      if (parsed !== undefined) return parsed
      const repaired = tryParse(repair(sliced))
      if (repaired !== undefined) return repaired
    }
  }
  throw new Error('无法解析 JSON：' + s.slice(0, 200))
}

function tryParse(s) {
  try { return JSON.parse(s) } catch { return undefined }
}

/** 扫描第一个平衡的 {…} / […] 片段，跳过字符串内部的括号。 */
function sliceBalanced(s) {
  const start = s.search(/[{[]/)
  if (start < 0) return ''
  const open = s[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s.slice(start) // 截断的 JSON，交给 repair
}

function repair(s) {
  return s
    .replace(/,\s*([}\]])/g, '$1')          // 尾逗号
    .replace(/[“”]/g, '"')                   // 中文引号
    .replace(/[‘’]/g, "'")
    .replace(/,\s*$/, '') // 截断
}

/** 截断的数组/对象尽量补齐括号（大模型 max_tokens 撞线时很常见）。 */
export function closeBrackets(s) {
  let depth = { '{': 0, '[': 0 }
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth[ch] += 1
    else if (ch === '}' || ch === ']') depth[ch === '}' ? '{' : '['] -= 1
  }
  let out = s
  if (inStr) out += '"'
  if (depth['['] > 0) out += ']'.repeat(depth['['])
  if (depth['{'] > 0) out += '}'.repeat(depth['{'])
  return out
}

export function asArray(v) {
  if (Array.isArray(v)) return v
  if (v == null) return []
  return [v]
}

export function str(v, fallback = '') {
  if (v == null) return fallback
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).join('；')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 把模型给的想法整形成固定字段，缺字段不炸，保留原文。 */
export function normalizeIdea(raw, { lane, lens }) {
  const exp = raw?.minimal_experiment || raw?.experiment || {}
  return {
    id: '',
    lane,
    lens,
    title: str(raw?.title, '（无标题）'),
    one_liner: str(raw?.one_liner ?? raw?.oneLiner ?? raw?.summary),
    gap: str(raw?.gap ?? raw?.problem),
    hypothesis: str(raw?.hypothesis),
    mechanism: str(raw?.mechanism),
    predictions: asArray(raw?.predictions).map((x) => str(x)).filter(Boolean),
    minimal_experiment: {
      data: str(exp?.data),
      method: str(exp?.method),
      effort: str(exp?.effort),
      cost: str(exp?.cost),
    },
    novelty_vs_literature: str(raw?.novelty_vs_literature ?? raw?.novelty),
    why_now: str(raw?.why_now),
    risks: asArray(raw?.risks).map((x) => str(x)).filter(Boolean),
    kill_criterion: str(raw?.kill_criterion),
    raw,
  }
}

export function normalizeReview(raw) {
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : null
  }
  return {
    id: str(raw?.id),
    novelty: num(raw?.novelty),
    significance: num(raw?.significance),
    feasibility: num(raw?.feasibility),
    testability: num(raw?.testability),
    fatal_flaws: asArray(raw?.fatal_flaws).map((x) => str(x)).filter(Boolean),
    strongest_objection: str(raw?.strongest_objection),
    closest_prior_work: str(raw?.closest_prior_work),
    repair: str(raw?.repair),
  }
}

/**
 * 截断抢救：max_tokens 撞线时，JSON 往往在某个值中间被切断。
 * 策略：从尾部逐段退到上一个"字符串外"的逗号，补齐引号/括号后重试。
 * 拿到的是"部分字段"的合法 JSON——比整轮作废好得多。
 */
export function salvageJSON(text) {
  const s = String(text || '').trim()
  const start = s.search(/[{[]/)
  if (start < 0) return undefined
  let body = s.slice(start)

  const tryOnce = (candidate) => {
    const fixed = closeBrackets(candidate.replace(/,\s*$/, ''))
    try { return JSON.parse(fixed) } catch { return undefined }
  }

  const direct = tryOnce(body)
  if (direct !== undefined) return direct

  for (let guard = 0; guard < 40; guard += 1) {
    const cut = lastTopLevelComma(body)
    if (cut < 0) break
    body = body.slice(0, cut)
    const got = tryOnce(body)
    if (got !== undefined) return got
  }
  return undefined
}

/** 找到字符串外的最后一个逗号位置。 */
function lastTopLevelComma(s) {
  let inStr = false
  let esc = false
  let last = -1
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === ',') last = i
  }
  return last
}
