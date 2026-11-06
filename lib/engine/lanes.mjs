import { orderedProviders, providerConfig } from './config.mjs'
/** Model transport adapters: Chat Completions, Anthropic Messages and Codex CLI.
 * Lane IDs and collaboration roles are independent of transport protocols.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCall } from './usage.mjs'

class LaneError extends Error {
  constructor(lane, message, { status, retryable = false } = {}) {
    super(`[${lane}] ${message}`)
    this.lane = lane
    this.status = status
    this.retryable = retryable
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

async function withRetry(lane, fn, { retries = 2 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { return await fn(attempt) } catch (err) {
      lastErr = err
      const retryable = err instanceof LaneError ? err.retryable : true
      if (!retryable || attempt === retries) break
      await sleep(1500 * 2 ** attempt)
    }
  }
  throw lastErr
}

/** Standard Chat Completions protocol, including compatible local servers. */
async function callOpenAI(lane, laneCfg, req, signal) {
  if (!laneCfg.baseUrl || !laneCfg.model) throw new LaneError(lane, '请配置 baseUrl 和 model')
  const res = await fetch(`${laneCfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(laneCfg.apiKey ? { authorization: `Bearer ${laneCfg.apiKey}` } : {}) },
    body: JSON.stringify({
      ...laneCfg.requestOptions,
      model: laneCfg.model, messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      max_tokens: req.maxTokens, temperature: req.temperature ?? 0.7,
    }), signal,
  })
  if (!res.ok) throw new LaneError(lane, `HTTP ${res.status}`, { status: res.status, retryable: retryableStatus(res.status) })
  const data = await res.json()
  return { text: data?.choices?.[0]?.message?.content || '', model: data.model || laneCfg.model,
    stopReason: data?.choices?.[0]?.finish_reason,
    usage: data.usage ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 } : null }
}

/* ─────────────────────────── DeepSeek ─────────────────────────── */

async function callDeepSeek(lane, laneCfg, req, signal) {
  const url = `${laneCfg.baseUrl.replace(/\/$/, '')}/chat/completions`
  if (!laneCfg.apiKey) throw new LaneError(lane, '缺少 DeepSeek API key')
  if (!laneCfg.model) throw new LaneError(lane, '请配置 DeepSeek model')
  // deepseek-v4-pro 是推理模型：思考 token 与回答 token 共享 max_tokens，且思考量随任务难度波动很大。
  // 实测审阅类任务思考可达 4000+ token：预算按回答长度×3 会被思考全部吃掉，返回 finish=length、content 为空。
  // 所以预算给足（至少 16K，模型上限 384K，按实际用量计费，不会多花钱）；万一仍被思考吃光，翻倍预算重试一次。
  // response_format=json_object 同样会导致空串，不开。
  const floor = laneCfg.minMaxTokens || 16000
  let budget = Math.min(Math.max(Math.round(req.maxTokens * (laneCfg.tokenMultiplier || 4)), floor), laneCfg.maxMaxTokens || 64000)
  let data
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = {
      model: laneCfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: budget,
      temperature: req.temperature ?? 0.8,
    }
    const res = await fetch(url, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${laneCfg.apiKey}` },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
        throw new LaneError(lane, `HTTP ${res.status}`, { status: res.status, retryable: retryableStatus(res.status) })
    }
    data = await res.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    const finish = data?.choices?.[0]?.finish_reason
    if (content.trim() || finish !== 'length') break
    budget = Math.min(budget * 2, 128000) // 思考吃光了预算：翻倍再来一次
  }
  const text = data?.choices?.[0]?.message?.content ?? ''
  const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens
  if (!text.trim()) {
    throw new LaneError(lane, `模型返回空文本（finish=${data?.choices?.[0]?.finish_reason}，思考 ${reasoningTokens ?? '?'} token，预算 ${budget}）`, { retryable: false })
  }
  return {
    text,
    stopReason: data?.choices?.[0]?.finish_reason,
    model: data?.model || laneCfg.model,
    usage: data?.usage
      ? { input: data.usage.prompt_tokens ?? 0, output: data.usage.completion_tokens ?? 0 }
      : null,
  }
}

// Failover is restricted to explicitly configured providers of this lane.
const providerHealth = new Map()
export function providerStatus(lane) {
  return Object.fromEntries(providerHealth.get(lane) || [])
}

async function callProviders(lane, laneCfg, req, signal) {
  const ordered = orderedProviders(laneCfg)
  const health = providerHealth.get(lane) || new Map()
  providerHealth.set(lane, health)
  let lastError
  for (const provider of ordered) {
    const kind = provider.kind || laneCfg.kind
    const cfg = providerConfig(laneCfg, provider)
    const call = kind === 'anthropic' ? callAnthropic : ['openai', 'openrouter'].includes(kind) ? callOpenAI : null
    if (!call) throw new LaneError(lane, '供应商接口类型无效')
    try {
      signal?.throwIfAborted()
      const result = await call(lane, cfg, req, signal)
      if (!result.text?.trim()) throw new LaneError(lane, '模型返回空文本')
      health.set(provider.id, { ok: true, at: new Date().toISOString() })
      return { ...result, provider: provider.id }
    } catch (error) {
      health.set(provider.id, { ok: false, at: new Date().toISOString() })
      if (signal?.aborted || !(error instanceof TypeError || error.retryable || [401, 402, 403, 404].includes(error.status))) throw error
      lastError = error
    }
  }
  throw lastError || new LaneError(lane, '没有启用的供应商')
}

/* ────────────────────── Claude (Anthropic 协议) ────────────────────── */

async function callAnthropic(lane, laneCfg, req, signal) {
  const url = `${laneCfg.baseUrl.replace(/\/$/, '')}/v1/messages`
  if (!laneCfg.apiKey) throw new LaneError(lane, '缺少 Anthropic API key', { status: 401 })
  if (!laneCfg.model) throw new LaneError(lane, '请配置 Anthropic model')
  const body = {
    model: laneCfg.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    temperature: req.temperature ?? 0.8,
  }
  const res = await fetch(url, {
    method: 'POST', redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': laneCfg.apiKey,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    throw new LaneError(lane, `HTTP ${res.status}`, { status: res.status, retryable: retryableStatus(res.status) })
  }
  const data = await res.json()
  const text = (data?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
  return {
    text,
    model: data?.model || laneCfg.model,
    usage: data?.usage
      ? { input: (data.usage.input_tokens ?? 0) + (data.usage.cache_read_input_tokens ?? 0) + (data.usage.cache_creation_input_tokens ?? 0), output: data.usage.output_tokens ?? 0 }
      : null,
    stopReason: data?.stop_reason,
  }
}

/* ──────────────────── ChatGPT（codex CLI 子进程） ──────────────────── */

function runProcess(lane, bin, args, { input, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new LaneError(lane, `codex 超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    const onAbort = () => { child.kill('SIGKILL') }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => {
      clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort)
      reject(new LaneError(lane, `无法启动 codex: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort)
      resolve({ code, stdout, stderr })
    })
    if (input) child.stdin.end(input); else child.stdin.end()
  })
}

async function callCodex(lane, laneCfg, req, signal, timeoutMs) {
  const effort = req.reasoning || laneCfg.reasoning || 'medium'
  const bin = laneCfg.bin || DEFAULT_CODEX_FALLBACK
  const dir = mkdtempSync(join(tmpdir(), 'foundry-codex-'))
  const outFile = join(dir, 'last-message.txt')
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-C', dir,
    '-o', outFile,
    '-c', `model_reasoning_effort="${effort}"`,
  ]
  if (laneCfg.model) args.push('-m', laneCfg.model)
  args.push('-')

  const prompt = `${req.system}\n\n---\n\n${req.user}`
  try {
    const { code, stdout, stderr } = await runProcess(lane, bin, args, { input: prompt, timeoutMs, signal })
    let text = ''
    try { text = readFileSync(outFile, 'utf8').trim() } catch { /* 见下 */ }
    if (!text) {
      const m = stdout.match(/\ncodex\n([\s\S]*?)\n(?:tokens used|$)/)
      text = (m ? m[1] : stdout).trim()
    }
    if (!text && code !== 0) {
      throw new LaneError(lane, `codex 退出码 ${code}`)
    }
    const used = stderr.match(/tokens used\s*\n?\s*([\d,]+)/) || stdout.match(/tokens used\s*\n?\s*([\d,]+)/)
    return {
      text,
      model: laneCfg.model || 'codex-default',
      usage: used ? { input: null, output: Number(String(used[1]).replace(/,/g, '')) } : null,
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

const DEFAULT_CODEX_FALLBACK = 'codex'

/* ─────────────────────────── 统一入口 ─────────────────────────── */

export async function callLane(lane, cfg, req, { signal } = {}) {
  const laneCfg = cfg.lanes?.[lane]
  if (!laneCfg) throw new LaneError(lane, '未配置该线路')
  if (laneCfg.enabled === false) throw new LaneError(lane, '该线路已禁用')

  const maxTokens = req.maxTokens || 3000
  const timeoutMs = req.timeoutMs || cfg.protocol?.timeoutMs || 300000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('lane timeout')), timeoutMs)
  const merged = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([ctrl.signal, signal])
    : ctrl.signal

  const started = Date.now()
  const retries = req.retries ?? cfg.protocol?.retries ?? 2
  try {
    const out = await withRetry(lane, async () => {
      if (Array.isArray(laneCfg.providers) && laneCfg.providers.length) return callProviders(lane, laneCfg, { ...req, maxTokens }, merged)
      switch (laneCfg.kind) {
        case 'openai': return callOpenAI(lane, laneCfg, { ...req, maxTokens }, merged)
        case 'deepseek': return callDeepSeek(lane, laneCfg, { ...req, maxTokens }, merged)
        case 'anthropic': return callAnthropic(lane, laneCfg, { ...req, maxTokens }, merged)
        case 'codex': return callCodex(lane, laneCfg, { ...req, maxTokens }, merged, timeoutMs)
        default: throw new LaneError(lane, `未知线路类型 ${laneCfg.kind}`)
      }
    }, { retries })
    const text = (out.text || '').trim()
    if (!text) throw new LaneError(lane, '模型返回空文本')
    recordCall(lane, {
      inputTokens: out.usage?.input ?? null, outputTokens: out.usage?.output ?? null,
      promptChars: String(req.system || '').length + String(req.user || '').length, ms: Date.now() - started,
    })
    return { ...out, text, ms: Date.now() - started, lane }
  } catch (err) {
    if (maxTokens > 20) recordCall(lane, { ok: false })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 探查所有已启用线路（真实调用，可能消耗额度）。 */
export async function probeLanes(cfg) {
  const out = {}
  await Promise.all(Object.entries(cfg.lanes).map(async ([lane, laneCfg]) => {
    if (laneCfg?.enabled === false) { out[lane] = { ok: false, error: 'disabled' }; return }
    const t0 = Date.now()
    try {
      const r = await callLane(lane, cfg, {
        system: 'You are a health probe. Reply with exactly: OK',
        user: 'Reply with exactly: OK',
        maxTokens: 12,
        temperature: 0,
        retries: 0,
        timeoutMs: 90000,
      })
      out[lane] = { ok: true, model: r.model, ms: Date.now() - t0, sample: r.text.slice(0, 40) }
    } catch (err) {
      out[lane] = { ok: false, error: String(err.message || err), ms: Date.now() - t0 }
    }
  }))
  return out
}
