/**
 * 运行时：任务注册表 + HTTP 处理（GUI 与 JSON API）。
 * 插件（lib/index.js）和独立服务（lib/server.mjs）共用这一份，避免两套逻辑漂移。
 */
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, maskConfig, CONFIG_PATH, controllerLane, workerLanes, reviewConfig } from './engine/config.mjs'
import { probeLanes } from './engine/lanes.mjs'
import { runFoundry } from './engine/protocol.mjs'
import { runRoundtable, resolveVenue } from './engine/roundtable.mjs'
import { VENUES } from './engine/playbook.mjs'
import { randomUUID } from 'node:crypto'
import { readIndex, writeJSON } from './engine/store.mjs'
import {
  sessions, persist, loadSessions, listSessions, publicSession, createSession, sendMessage, cancelSession,
  TASK_TEMPLATES,
  setAutopilot, startManualOral, statusSnapshot, askStatus, resumeInterrupted,
  getMission, setGlobalMission, setSessionMission, DEFAULT_MISSION, consolidateMemory, replaceDirectives, queueMessage,
} from './engine/command.mjs'
import { digestStatus, getDigest } from './engine/knowledge.mjs'
import { getUsage } from './engine/usage.mjs'
import { providerStatus } from './engine/lanes.mjs'
import { startDraft, addComment, startResolve, publicPaper } from './engine/paper.mjs'

let cmdReady = null
/** 总控模式初始化：载入历史会话，并恢复被服务重启打断、开着自动续航的会话。 */
export function initCommand(pluginConfig) {
  if (!cmdReady) {
    cmdReady = getConfig(pluginConfig).then((cfg) => {
      loadSessions(cfg.vault)
      resumeInterrupted(cfg)
      return cfg
    })
  }
  return cmdReady
}

function listProjects(vault) {
  try { return JSON.parse(readFileSync(join(vault, 'projects.json'), 'utf8')) }
  catch (err) { if (err.code === 'ENOENT') return []; throw err }
}

const HERE = dirname(fileURLToPath(import.meta.url))
export const GUI_DIR = join(HERE, 'gui')
export const ROUTE = '/.research-foundry'

export const jobs = new Map()
let seq = 0
let cfgPromise = null

export function getConfig(pluginConfig) {
  if (!cfgPromise) cfgPromise = resolveConfig(pluginConfig || {})
  return cfgPromise
}

function newJob(input) {
  const job = {
    id: `R${(seq += 1)}-${Date.now().toString(36)}`,
    status: 'running',
    createdAt: new Date().toISOString(),
    endedAt: null,
    input,
    mode: input.mode || 'paper',
    venue: input.venue || '',
    phase: 'queued',
    events: [],
    transcript: [],
    brief: null,
    reviews: [],
    acDecision: null,
    plan: null,
    runId: null,
    dir: null,
    error: null,
    degraded: [],
    controller: new AbortController(),
  }
  jobs.set(job.id, job)
  return job
}

function pushEvent(job, line) {
  job.events.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (job.events.length > 300) job.events.splice(0, job.events.length - 300)
}

export function startRun(input, pluginConfig) {
  const job = newJob(input)
  void (async () => {
    try {
      const base = await getConfig(pluginConfig)
      const cfg = input.lead ? { ...base, protocol: { ...base.protocol, controller: input.lead } } : base
      const onEvent = (ev) => {
        if (ev.type === 'phase') { job.phase = ev.phase; pushEvent(job, `▸ ${ev.phase}: ${ev.message}`) }
        else if (ev.type === 'lane-start') pushEvent(job, `→ ${ev.phase}/${ev.lane} ${ev.label || ''}`)
        else if (ev.type === 'lane-done') pushEvent(job, `✓ ${ev.phase}/${ev.lane}${ev.ms ? ` ${Math.round(ev.ms / 1000)}s` : ''}`)
        else if (ev.type === 'lane-error') pushEvent(job, `✗ ${ev.phase}/${ev.lane}: ${ev.error}`)
        else if (ev.type === 'transcript') job.transcript = [...job.transcript, ev.entry]
        else if (ev.type === 'run-created') { job.runId = ev.runId; job.dir = ev.dir }
        else if (ev.type === 'done') { job.runId = ev.runId || job.runId }
        else if (ev.type === 'stage') { job.phase = ev.stage; pushEvent(job, `▸ ${ev.stage}: ${ev.message}`) }
        else if (ev.type === 'stage-degraded') pushEvent(job, `⚠ ${ev.message}`)
      }

      const run = job.mode === 'ideate'
        ? await runFoundry({ input, cfg, onEvent, signal: job.controller.signal })
        : await runRoundtable({ input, cfg, onEvent, signal: job.controller.signal })

      job.status = 'done'
      job.endedAt = new Date().toISOString()
      job.runId = run.id
      job.dir = run.dir
      job.phase = 'done'
      job.brief = run.brief || null
      job.reviews = run.reviews || []
      job.acDecision = run.acDecision || null
      job.plan = run.plan || run.proposals || null
      job.degraded = run.degraded || []
      if (job.mode === 'ideate' && run.seeds) {
        job.transcript = run.seeds.map((s) => ({ phase: 'seed', role: s.title, text: s.one_liner, lane: s.lane }))
      }
      pushEvent(job, '✓ 完成')
    } catch (err) {
      if (job.controller.signal.aborted) {
        job.status = 'cancelled'
        pushEvent(job, '■ 已取消')
      } else {
        job.status = 'failed'
        job.error = String(err?.message || err)
        pushEvent(job, `✗ 失败: ${job.error}`)
      }
      job.endedAt = new Date().toISOString()
    }
  })()
  return job
}

export function publicJob(job) {
  const { controller, ...rest } = job
  return rest
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return false
  job.controller.abort(new Error('cancelled by user'))
  return true
}

/* ───────────────── ─── HTTP ─────────────────────────── */

function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

function serveStatic(res, file, type) {
  try {
    const p = join(GUI_DIR, file)
    if (!existsSync(p)) { res.writeHead(404); res.end('not found'); return }
    const buf = readFileSync(p)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(buf)
  } catch {
    res.writeHead(500); res.end('error')
  }
}

export async function handle(req, res, pluginConfig) {
  const url = new URL(req.url || '/', 'http://localhost')
  // 容忍尾斜杠：/.research-foundry/api/state/ 等价于不带斜杠
  let path = url.pathname
  if (path.length > 1) path = path.replace(/\/+$/, '')

  if (path === '/favicon.ico') { res.writeHead(204); return res.end() }

  if (path === ROUTE || path === `${ROUTE}/` || path === `${ROUTE}/index.html`) {
    return serveStatic(res, 'index.html', 'text/html; charset=utf-8')
  }
  if (path === `${ROUTE}/app.js`) return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8')
  if (path === `${ROUTE}/app.css`) return serveStatic(res, 'app.css', 'text/css; charset=utf-8')
  if (path === `${ROUTE}/command` || path === `${ROUTE}/command.html`) return serveStatic(res, 'command.html', 'text/html; charset=utf-8')
  if (path === `${ROUTE}/command.js`) return serveStatic(res, 'command.js', 'text/javascript; charset=utf-8')
  if (path === `${ROUTE}/command.css`) return serveStatic(res, 'command.css', 'text/css; charset=utf-8')
  if (path === `${ROUTE}/review` || path === `${ROUTE}/review.html`) return serveStatic(res, 'review.html', 'text/html; charset=utf-8')
  if (path === `${ROUTE}/review.js`) return serveStatic(res, 'review.js', 'text/javascript; charset=utf-8')

  /* ── 总控协作模式（可配置总控与执行者） ── */
  if (path.startsWith(`${ROUTE}/api/cmd/`)) {
    const cfg = await initCommand(pluginConfig)
    loadSessions(cfg.vault)
    const sub = path.slice(`${ROUTE}/api/cmd/`.length)

    if (sub === 'meta' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        templates: Object.fromEntries(Object.entries(TASK_TEMPLATES).map(([k, v]) => [k, v.name])),
        controller: controllerLane(cfg),
        workers: Object.fromEntries(workerLanes(cfg).map(k => [k, cfg.lanes[k].strengths || '通用分析'])),
        lanes: Object.fromEntries(Object.entries(cfg.lanes).map(([k, v]) => [k, {
          label: v.label, model: v.model, kind: v.kind, enabled: v.enabled !== false,
          hasKey: ['codex', 'openai'].includes(v.kind) || Boolean(v.apiKey || v.providers?.length),
        }])),
        venues: Object.fromEntries(Object.entries(VENUES).map(([k, v]) => [k, v.name])),
        projects: listProjects(cfg.vault),
        sessions: listSessions(),
        oral: reviewConfig(cfg),
        knowledge: (({ text, ...rest }) => rest)(digestStatus(cfg)),
      })
    }
    if (sub === 'projects' && req.method === 'POST') {
      const body = await readBody(req)
      const name = String(body.name || '').trim().slice(0, 80)
      if (!name) return json(res, 400, { ok: false, error: '请输入项目名称' })
      const projects = listProjects(cfg.vault)
      if (projects.some((p) => p.name === name)) return json(res, 409, { ok: false, error: '已有同名项目' })
      const project = { id: randomUUID(), name }
      mkdirSync(cfg.vault, { recursive: true })
      writeJSON(cfg.vault, '.projects.json.tmp', [...projects, project])
      renameSync(join(cfg.vault, '.projects.json.tmp'), join(cfg.vault, 'projects.json'))
      return json(res, 200, { ok: true, project })
    }
    if (sub === 'session/project' && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: '会话不存在' })
      if (body.projectId && !listProjects(cfg.vault).some((p) => p.id === body.projectId)) {
        return json(res, 400, { ok: false, error: '项目不存在' })
      }
      if ((s.projectId || null) !== (body.projectId || null)
        && (s.status === 'running' || s.status === 'interrupted' || s.pending
          || s.oralRunning || s.memoryBusy || Object.values(s.busy || {}).some((calls) => calls.length))) {
        return json(res, 409, { ok: false, error: '会话仍在处理任务，完成后可变更项目' })
      }
      s.projectId = body.projectId || null
      persist(s)
      return json(res, 200, { ok: true })
    }
    if (sub === 'session' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.workflow !== undefined && !['standard', 'evidence'].includes(body.workflow)) {
        return json(res, 400, { ok: false, error: '未知的协作流程' })
      }
      if (body.projectId && !listProjects(cfg.vault).some((p) => p.id === body.projectId)) {
        return json(res, 400, { ok: false, error: '项目不存在' })
      }
      const s = createSession({
        vault: cfg.vault, projectId: body.projectId || null, workflow: body.workflow,
        title: String(body.title || '').trim() || String(body.message || '').trim().slice(0, 40) || '未命名会话',
        context: {
          venue: String(body.venue || cfg.venue || 'generic'), field: String(body.field || ''),
          constraints: String(body.constraints || ''), deadline: String(body.deadline || ''),
          background: String(body.background || ''),
        },
        materialPaths: String(body.materials || '').split('\n').map((x) => x.trim()).filter(Boolean),
        mission: body.mission ? String(body.mission) : '',
      })
      return json(res, 200, { ok: true, session: publicSession(s) })
    }
    if (sub === 'session' && req.method === 'GET') {
      const s = sessions.get(url.searchParams.get('id') || '')
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      return json(res, 200, { ok: true, session: publicSession(s) })
    }
    if (sub === 'message' && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      if (Object.hasOwn(body, 'projectId') && (s.projectId || null) !== body.projectId) {
        return json(res, 409, { ok: false, error: '会话所属项目不匹配' })
      }
      const text = String(body.message || '').trim()
      if (!text) return json(res, 400, { ok: false, error: '消息不能为空' })
      try {
        const turn = sendMessage(s, text, cfg, {
          template: String(body.template || 'free'),
          maxSteps: Number(body.maxSteps) || 3,
          maxRevise: body.maxRevise !== undefined ? Number(body.maxRevise) : 1,
          cross: body.cross !== false,
          oral: body.oral !== false,
          debate: body.debate !== false,
          autopilot: body.autopilot !== undefined ? Boolean(body.autopilot) : undefined,
          workers: Array.isArray(body.workers) ? body.workers.map(String) : undefined,
        })
        return json(res, 200, { ok: true, turnId: turn.id })
      } catch (err) {
        return json(res, 409, { ok: false, error: String(err.message || err) })
      }
    }
    if (sub === 'autopilot' && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      return json(res, 200, { ok: true, autopilot: setAutopilot(s, { enabled: body.enabled, objective: String(body.objective || '') }, cfg) })
    }
    if (sub === 'oral' && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      const text = String(body.contribution || '').trim()
      if (text.length < 20) return json(res, 400, { ok: false, error: '贡献描述太短' })
      try { startManualOral(s, cfg, text, String(body.title || '')); return json(res, 200, { ok: true }) } catch (err) {
        return json(res, 409, { ok: false, error: String(err.message || err) })
      }
    }
    if (sub === 'status' && req.method === 'GET') {
      return json(res, 200, { ok: true, now: new Date().toISOString(), sessions: statusSnapshot({ sessionId: url.searchParams.get('id') || undefined }) })
    }
    if (sub === 'ask' && (req.method === 'POST' || req.method === 'GET')) {
      const body = req.method === 'POST' ? await readBody(req) : {}
      const q = String(body.question || url.searchParams.get('q') || '').trim() || '现在各会话进展如何？'
      const sid = String(body.id || url.searchParams.get('id') || '') || undefined
      try { return json(res, 200, { ok: true, ...(await askStatus(cfg, q, { sessionId: sid })) }) } catch (err) {
        return json(res, 502, { ok: false, error: String(err.message || err), snapshot: statusSnapshot({ sessionId: sid }) })
      }
    }
    if (sub === 'memory' && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      if (!s.turns.some((t) => t.final)) return json(res, 400, { ok: false, error: '还没有完成的回合可整理' })
      void consolidateMemory(s, cfg, '手动保存')
      return json(res, 200, { ok: true })
    }
    if (sub === 'mission' && req.method === 'GET') {
      const s = sessions.get(url.searchParams.get('id') || '')
      return json(res, 200, { ok: true, global: getMission(null), session: s?.mission || '', effective: getMission(s), default: DEFAULT_MISSION })
    }
    if (sub === 'mission' && req.method === 'POST') {
      const body = await readBody(req)
      if (body.scope === 'session') {
        const s = sessions.get(String(body.id || ''))
        if (!s) return json(res, 404, { ok: false, error: 'no such session' })
        return json(res, 200, { ok: true, effective: setSessionMission(s, body.text) })
      }
      return json(res, 200, { ok: true, effective: setGlobalMission(body.text) })
    }
    if (sub === 'usage' && req.method === 'GET') {
      try { return json(res, 200, { ok: true, ...(await getUsage(cfg, { force: url.searchParams.get('refresh') === '1' })) }) } catch (err) {
        return json(res, 502, { ok: false, error: String(err.message || err) })
      }
    }
    if (sub === 'knowledge' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...digestStatus(cfg) })
    }
    if (sub === 'knowledge' && req.method === 'POST') {
      const st = digestStatus(cfg)
      if (st.building) return json(res, 200, { ok: true, building: true })
      void getDigest(cfg, { force: true }).catch(() => {})
      return json(res, 200, { ok: true, building: true })
    }
    if (sub === 'providers' && ['GET', 'POST'].includes(req.method)) {
      const lane = controllerLane(cfg)
      const c = cfg.lanes[lane]
      const providers = (c.providers || []).filter(p => p.enabled !== false)
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (!providers.some(p => p.id === body.active)) return json(res, 400, { ok: false, error: '未知供应商' })
        c.active = body.active
      }
      return json(res, 200, { ok: true, active: c.active || null,
        providers: providers.map(({ id, label, kind, model }) => ({ id, label, kind, model })),
        health: providerStatus(lane) })
    }
    if (sub === 'paper' && req.method === 'GET') {
      const s = sessions.get(url.searchParams.get('id') || '')
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      return json(res, 200, { ok: true, paper: publicPaper(s) })
    }
    if (sub.startsWith('paper/') && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      try {
        if (sub === 'paper/draft') startDraft(s, cfg)
        else if (sub === 'paper/comment') addComment(s, { sectionId: body.sectionId, quote: body.quote, text: body.text })
        else if (sub === 'paper/resolve') startResolve(s, cfg)
        else return json(res, 404, { ok: false, error: 'unknown paper action' })
        return json(res, 200, { ok: true, paper: publicPaper(s) })
      } catch (err) { return json(res, 409, { ok: false, error: String(err.message || err) }) }
    }
    if (sub === 'directives' && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      return json(res, 200, { ok: true, board: replaceDirectives(s, body.directives, String(body.note || '')) })
    }
    if (sub === 'queue' && req.method === 'POST') {
      const body = await readBody(req)
      const s = sessions.get(String(body.id || ''))
      if (!s) return json(res, 404, { ok: false, error: 'no such session' })
      if (Object.hasOwn(body, 'projectId') && (s.projectId || null) !== body.projectId) {
        return json(res, 409, { ok: false, error: '会话所属项目不匹配' })
      }
      if (body.idleOnly === true && (s.status !== 'idle' || s.pending
        || s.oralRunning || s.memoryBusy || Object.values(s.busy || {}).some((calls) => calls.length))) {
        return json(res, 409, { ok: false, error: '会话尚未空闲，指令未提交' })
      }
      const message = String(body.message || '').trim()
      if (!message) return json(res, 400, { ok: false, error: '消息不能为空' })
      try {
        const opts = { ...(body.opts || {}) }
        if (body.autopilot !== undefined) opts.autopilot = Boolean(body.autopilot)
        const queued = queueMessage(s, message, cfg, opts)
        return json(res, 200, { ok: true, ...queued })
      } catch (err) { return json(res, 409, { ok: false, error: String(err.message || err) }) }
    }
    if (sub === 'cancel' && req.method === 'POST') {
      const body = await readBody(req)
      return json(res, 200, { ok: cancelSession(sessions.get(String(body.id || ''))) })
    }
    return json(res, 404, { ok: false, error: 'unknown cmd route', path })
  }

  if (path === `${ROUTE}/api/state` && req.method === 'GET') {
    const cfg = await getConfig(pluginConfig)
    return json(res, 200, {
      ok: true,
      configPath: CONFIG_PATH,
      vault: cfg.vault,
      venue: cfg.venue || '',
      lanes: Object.fromEntries(Object.entries(cfg.lanes).map(([k, v]) => [k, {
        label: v.label, model: v.model, kind: v.kind, enabled: v.enabled !== false, lens: v.lens,
        hasKey: ['codex', 'openai'].includes(v.kind) || Boolean(v.apiKey || v.providers?.length),
      }])),
      jobs: [...jobs.values()].reverse().slice(0, 20).map((j) => ({
        id: j.id, status: j.status, mode: j.mode, topic: j.input?.topic, venue: j.venue,
        phase: j.phase, createdAt: j.createdAt, runId: j.runId,
      })),
      runs: readIndex(cfg.vault).slice(0, 30),
    })
  }

  if (path === `${ROUTE}/api/run` && req.method === 'POST') {
    const body = await readBody(req)
    const topic = String(body.topic || '').trim()
    if (!topic) return json(res, 400, { ok: false, error: '需要 topic' })
    const venue = body.venue ? resolveVenue(body.venue).name : ''
    const job = startRun({
      topic,
      field: body.field ? String(body.field) : '',
      constraints: body.constraints ? String(body.constraints) : '',
      goal: body.goal ? String(body.goal) : '',
      anchors: body.anchors ? String(body.anchors) : '',
      deadline: body.deadline ? String(body.deadline) : '',
      venue,
      mode: body.mode === 'ideate' ? 'ideate' : 'paper',
      lead: body.lead ? String(body.lead) : '',
    }, pluginConfig)
    return json(res, 200, { ok: true, jobId: job.id })
  }

  if (path === `${ROUTE}/api/run` && req.method === 'GET') {
    const id = url.searchParams.get('jobId') || ''
    const job = jobs.get(id)
    if (!job) return json(res, 404, { ok: false, error: 'no such job' })
    return json(res, 200, { ok: true, job: publicJob(job) })
  }

  if (path === `${ROUTE}/api/cancel` && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, { ok: cancelJob(String(body.jobId || '')) })
  }

  if (path === `${ROUTE}/api/file` && req.method === 'GET') {
    const cfg = await getConfig(pluginConfig)
    const runId = url.searchParams.get('runId') || ''
    const file = url.searchParams.get('file') || 'plan.md'
    const safe = (v) => v.length > 0 && !v.includes('..') && !/[/\\\0]/.test(v)
    if (!safe(file) || !safe(runId)) return json(res, 400, { ok: false, error: 'bad name' })
    const p = join(cfg.vault, 'runs', runId, file)
    if (!existsSync(p)) return json(res, 404, { ok: false, error: 'not found', path: p })
    return json(res, 200, { ok: true, content: readFileSync(p, 'utf8') })
  }

  if (path === `${ROUTE}/api/probe` && (req.method === 'POST' || req.method === 'GET')) {
    const cfg = await getConfig(pluginConfig)
    const result = await probeLanes(cfg)
    return json(res, 200, { ok: true, result, lanes: maskConfig(cfg).lanes })
  }

  // 兜底：GET 下任何未命中路径都回看板（避免用户在地址栏乱敲看到 JSON 错误）
  if (req.method === 'GET' && (path === '/' || path.startsWith(ROUTE))) {
    return serveStatic(res, 'index.html', 'text/html; charset=utf-8')
  }
  return json(res, 404, { ok: false, error: 'unknown route', path })
}

export function wrapHandler(pluginConfig) {
  return async (req, res) => {
    try { await handle(req, res, pluginConfig) } catch (err) {
      try { json(res, 500, { ok: false, error: String(err?.message || err) }) } catch { /* ignore */ }
    }
  }
}
