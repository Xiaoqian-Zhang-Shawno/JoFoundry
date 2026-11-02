/**
 * 圆桌协议：各参与模型真的"互相看得见、互相反驳"，而不是各说各话。
 *
 * 关键机制：
 *   · 发言按顺序进行，后发言者能在提示词里看到前面所有人说过的话。
 *   · 反驳轮倒序（最后发言的人先反驳），避免顺序造成的锚定。
 *   · 审稿视角按参与线路分配（新颖性/实验/影响），互不串味。
 *   · 主持人（lead）不参与表态，只做收敛：议程 → AC 决策 → 作战计划。
 */
import { controllerLane } from './config.mjs'
import { callLane } from './lanes.mjs'
import { extractJSON, closeBrackets, salvageJSON, str, asArray } from './parse.mjs'
import {
  VENUES, briefPrompt, positionPrompt, rebuttalPrompt,
  REVIEWER_PERSONAS, reviewPrompt, planPromptPart, planRepairPrompt, reviewAggregatePrompt,
} from './playbook.mjs'
import * as store from './store.mjs'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MOCK = process.env.FOUNDRY_MOCK === '1'
const personaOrder = ['novelty', 'rigor', 'impact']

export function resolveVenue(key) {
  const k = String(key || 'generic').toLowerCase().replace(/[^a-z0-9]/g, '')
  return VENUES[k] || { ...VENUES.generic, name: key || VENUES.generic.name }
}

export async function runRoundtable({ input, cfg, onEvent = () => {}, signal }) {
  const startedAt = new Date()
  const mode = input.mode === 'ideate' ? 'ideate' : 'paper'
  const venue = resolveVenue(input.venue || cfg.venue || 'neurips')
  const runId = store.makeRunId(input.topic, startedAt)
  const runDir = store.createRunDir(cfg.vault, runId)
  RAW_DIR = join(runDir, 'raw')
  try { mkdirSync(RAW_DIR, { recursive: true }) } catch { /* ignore */ }

  const enabled = Object.entries(cfg.lanes).filter(([, v]) => v && v.enabled !== false).map(([k]) => k)
  if (enabled.length < 1) throw new Error('没有任何可用线路')

  const label = (lane) => cfg.lanes[lane]?.label || lane
  const run = {
    id: runId, mode, venue: venue.name, startedAt: startedAt.toISOString(), finishedAt: null,
    input, dir: runDir,
    lanes: Object.fromEntries(enabled.map((l) => [l, { label: label(l), model: cfg.lanes[l].model, kind: cfg.lanes[l].kind }])),
    transcript: [], brief: null, reviews: [], acDecision: null, plan: null,
    calls: [], errors: [], degraded: [], phase: 'init',
  }

  const emit = (ev) => { try { onEvent(ev) } catch { /* ignore */ } }
  const persist = () => {
    store.writeJSON(runDir, 'run.json', run)
    store.writeText(runDir, 'transcript.md', renderTranscriptMd(run))
  }
  emit({ type: 'run-created', runId, dir: runDir })

  const lead = controllerLane(cfg)

  async function ask(lane, phase, prompt, { maxTokens = 3600, temperature = 0.7, reasoning = 'low' } = {}) {
    emit({ type: 'lane-start', phase, lane, label: label(lane) })
    const t0 = Date.now()
    try {
      const res = MOCK
        ? { text: mockText(phase, lane), model: `${lane}-mock`, ms: 3, usage: null }
        : await callLane(lane, cfg, {
            system: prompt.system, user: prompt.user, maxTokens, temperature, reasoning, json: true,
          }, { signal })
      run.calls.push({ phase, lane, model: res.model, ms: res.ms, usage: res.usage, ok: true })
      emit({ type: 'lane-done', phase, lane, ms: res.ms })
      return res
    } catch (err) {
      run.calls.push({ phase, lane, ms: Date.now() - t0, ok: false, error: String(err.message || err) })
      run.errors.push({ phase, lane, error: String(err.message || err) })
      emit({ type: 'lane-error', phase, lane, error: String(err.message || err) })
      return null
    }
  }

  function record(turn) {
    const entry = { ts: new Date().toISOString(), ...turn }
    run.transcript.push(entry)
    emit({ type: 'transcript', entry })
    persist()
    return entry
  }

  /* ── P0 主持开场 ── */
  run.phase = 'brief'
  emit({ type: 'phase', phase: 'brief', message: '主持人整理问题陈述' })
  {
    const p = briefPrompt({ input, venue })
    const res = await ask(lead, 'brief', p, { maxTokens: 4200, temperature: 0.4 })
    let brief = null
    if (res) { try { brief = parseOrNull(res.text) } catch { /* 降级 */ } }
    if (!brief) { brief = { one_sentence_claim: input.topic, problem: input.topic, _fallback: true }; run.degraded.push('brief') }
    run.brief = brief
    store.writeJSON(runDir, 'brief.json', brief)
    record({ lane: lead, phase: 'brief', role: '主持人', text: renderBrief(brief) })
  }

  /* ── P1 第一轮立场（顺序发言） ── */
  run.phase = 'position'
  emit({ type: 'phase', phase: 'position', message: '第一轮：各自亮出贡献主张' })
  const positions = []
  for (const lane of enabled) {
    const others = positions.map((p) => ({ label: p.role, text: p.text }))
    const res = await ask(lane, 'position', positionPrompt({ input, venue, brief: run.brief, others, selfLabel: label(lane) }), {
      maxTokens: 1600, temperature: 0.85,
    })
    if (!res) { run.degraded.push(`position:${lane}`); continue }
    const json = parseOrNull(res.text) || { take: res.text }
    positions.push(record({ lane, phase: 'position', role: label(lane), text: renderPosition(json), json }))
  }
  if (!positions.length) throw new Error('第一轮所有线路都失败，无法继续圆桌')

  /* ── P2 反驳轮（倒序 + 总结者收尾） ── */
  run.phase = 'rebuttal'
  emit({ type: 'phase', phase: 'rebuttal', message: '第二轮：互相反驳与修正' })
  const order = [...enabled].reverse()
  for (const [i, lane] of order.entries()) {
    const isLast = i === order.length - 1
    const transcriptForPrompt = run.transcript
      .filter((t) => t.phase === 'position' || t.phase === 'rebuttal')
      .map((t) => ({ label: t.role, text: t.text }))
    const res = await ask(lane, 'rebuttal', rebuttalPrompt({
      input, venue, brief: run.brief, transcript: transcriptForPrompt, selfLabel: label(lane),
      order: isLast ? 'last' : 'normal',
    }), { maxTokens: 4200, temperature: 0.7 })
    if (!res) { run.degraded.push(`rebuttal:${lane}`); continue }
    const json = parseOrNull(res.text) || { revised_claim: res.text }
    record({ lane, phase: 'rebuttal', role: label(lane), text: renderRebuttal(json), json })
  }

  /* ── P3 三种审稿人原型（并行，各由一条线扮演） ── */
  run.phase = 'review'
  emit({ type: 'phase', phase: 'review', message: '模拟审稿：各线路按分配视角给出意见' })
  const discussion = run.transcript.map((t) => ({ label: t.role, text: t.text }))
  const reviewResults = await Promise.all(enabled.map(async (lane, i) => {
    const persona = REVIEWER_PERSONAS[personaOrder[i % personaOrder.length]]
    const res = await ask(lane, 'review', reviewPrompt({ input, venue, brief: run.brief, transcript: discussion, persona }), {
      maxTokens: 1800, temperature: 0.35,
    })
    if (!res) return null
    const json = parseOrNull(res.text) || { persona: persona.name, weaknesses: [res.text] }
    json._persona_key = personaOrder[i % personaOrder.length]
    json._lane = lane
    record({ lane, phase: 'review', role: persona.name, text: renderReview(json), json })
    return json
  }))
  run.reviews = reviewResults.filter(Boolean)
  store.writeJSON(runDir, 'reviews.json', run.reviews)

  /* ── P4 AC 合议（主持人） ── */
  run.phase = 'ac'
  emit({ type: 'phase', phase: 'ac', message: 'AC 合议：分歧点与决胜实验' })
  {
    const p = reviewAggregatePrompt({ input, venue, brief: run.brief, reviews: run.reviews })
    const res = await ask(lead, 'ac', p, { maxTokens: 3600, temperature: 0.3 })
    if (res) {
      run.acDecision = parseOrNull(res.text) || { raw: res.text }
      record({ lane: lead, phase: 'ac', role: `${label(lead)}（AC）`, text: renderAc(run.acDecision), json: run.acDecision })
    }
  }

  /* ── P5 作战计划（主持人；两段式 + 缺字段补全） ── */
  run.phase = 'plan'
  emit({ type: 'phase', phase: 'plan', message: '生成投稿作战计划（故事 + 执行）' })
  {
    const planCtx = { input, venue, brief: run.brief, transcript: discussion, reviews: run.reviews }
    const planLanes = [lead, ...enabled.filter((l) => l !== lead)]
    const { plan } = await gatherPlan(planCtx, planLanes, async (lane, prompt, tag) => {
      const res = await ask(lane, `plan-${tag}`, prompt, { maxTokens: 6000, temperature: 0.45, reasoning: 'medium' })
      return res ? parseOrNull(res.text) : null
    }, (msg) => emit({ type: 'plan-note', message: msg }))
    if (!Object.keys(plan).length) {
      run.degraded.push('plan')
      plan.title_candidates = [input.topic]
      plan._fallback = true
    }
    run.plan = plan
    store.writeJSON(runDir, 'plan.json', plan)
    store.writeText(runDir, 'plan.md', renderPlanMd(run))
  }

  run.finishedAt = new Date().toISOString()
  persist()
  store.appendIndex(cfg.vault, {
    id: runId, startedAt: run.startedAt, finishedAt: run.finishedAt, mode, venue: venue.name,
    topic: input.topic, field: input.field, seedCount: run.transcript.length,
    proposalCount: (run.plan?.contributions || []).length,
    topIdea: run.plan?.one_sentence_claim || run.plan?.title_candidates?.[0] || '',
    lanes: enabled, degraded: run.degraded, dir: runDir,
  })
  emit({ type: 'done', runId })
  return run
}

/* ───────────────────────── 解析与渲染 ───────────────────────── */

let RAW_DIR = null

function parseOrNull(text) {
  try { return extractJSON(text) } catch {
    try {
      const salvaged = salvageJSON(text)
      if (salvaged !== undefined) return salvaged
      return JSON.parse(closeBrackets(String(text).trim()))
    } catch {
      if (RAW_DIR) {
        try {
          mkdirSync(RAW_DIR, { recursive: true })
          writeFileSync(`${RAW_DIR}/${Date.now()}-unparsed.txt`, String(text))
        } catch { /* ignore */ }
      }
      return null
    }
  }
}

function renderBrief(b) {
  return [
    `**一句话主张**：${str(b.one_sentence_claim)}`,
    `**问题**：${str(b.problem)}`,
    b.minimum_publishable_unit ? `**最小可发表单元**：${str(b.minimum_publishable_unit)}` : '',
    Array.isArray(b.contribution_angles) && b.contribution_angles.length
      ? `**三个切法**：\n${b.contribution_angles.map((x) => `  - ${str(x)}`).join('\n')}` : '',
    b.reviewer_first_question ? `**审稿人第一问**：${str(b.reviewer_first_question)}` : '',
  ].filter(Boolean).join('\n')
}

function renderPosition(p) {
  return [
    `**立场**：${str(p.take)}`,
    `**贡献主张**：${str(p.contribution_claim)}（${str(p.claim_type)}）`,
    p.key_figure_or_table ? `**核心图表**：${str(p.key_figure_or_table)}` : '',
    p.decisive_experiment ? `**一锤定音实验**：${str(p.decisive_experiment)}` : '',
    `**最大风险**：${str(p.biggest_risk)}`,
    p.disagreement ? `**分歧**：${str(p.disagreement)}` : '',
  ].filter(Boolean).join('\n')
}

function renderRebuttal(r) {
  return [
    `**反驳**：${str(r.disagree_with)}`,
    `**理由**：${str(r.why_wrong)}`,
    `**让步**：${str(r.concede)}`,
    r.decisive_test ? `**裁决实验**：${str(r.decisive_test)}` : '',
    `**修正后主张**：${str(r.revised_claim)}`,
    r.if_i_am_wrong ? `**如果我错了**：${str(r.if_i_am_wrong)}` : '',
  ].filter(Boolean).join('\n')
}

function renderReview(rv) {
  const s = rv.scores || {}
  return [
    `**判断**：${str(rv.verdict)}（overall ${s.overall ?? '–'}）`,
    `**分数**：novelty ${s.novelty ?? '–'} / rigor ${s.rigor ?? '–'} / impact ${s.impact ?? '–'} / clarity ${s.clarity ?? '–'}`,
    `**复述**：${str(rv.summary)}`,
    Array.isArray(rv.weaknesses) && rv.weaknesses.length ? `**主要问题**：\n${rv.weaknesses.map((x) => `  - ${str(x)}`).join('\n')}` : '',
    Array.isArray(rv.fatal_if_unaddressed) && rv.fatal_if_unaddressed.length
      ? `**不补就拒**：\n${rv.fatal_if_unaddressed.map((x) => `  - ${str(x)}`).join('\n')}` : '',
    Array.isArray(rv.required_experiments) && rv.required_experiments.length
      ? `**补做实验**：${rv.required_experiments.map((x) => str(x)).join('；')}` : '',
  ].filter(Boolean).join('\n')
}

function renderAc(a) {
  const scores = asArray(a.scores_table).map((s) => `${s.persona}: ${s.overall} (${s.verdict})`).join(' · ')
  return [
    scores ? `**打分**：${scores}` : '',
    `**AC 判断**：${str(a.ac_decision)}`,
    Array.isArray(a.consensus_weaknesses) && a.consensus_weaknesses.length
      ? `**共识问题**：${a.consensus_weaknesses.map((x) => str(x)).join('；')}` : '',
    a.decisive_experiment ? `**决胜实验**：${str(a.decisive_experiment)}` : '',
  ].filter(Boolean).join('\n')
}

export function renderTranscriptMd(run) {
  const out = [
    `# 圆桌记录 — ${run.input?.topic || ''}`,
    '',
    `- 会议：${run.venue}`,
    `- 运行：${run.id}　开始：${run.startedAt}`,
    `- 阵容：${Object.values(run.lanes || {}).map((l) => `${l.label}(${l.model || l.kind || ''})`).join(' · ')}`,
    '',
  ]
  for (const t of run.transcript || []) {
    out.push(`## ${t.role} · ${t.phase}`, '', t.text, '')
  }
  return out.join('\n')
}


/** 模型补全的条目字段名不总是我们要求的，这里做一次宽容渲染，绝不出 undefined。 */
function itemText(o) {
  if (o == null) return ''
  if (typeof o === 'string') return o
  if (typeof o !== 'object') return String(o)
  const keys = ['id', 'name', 'figure', 'purpose', 'goal', 'proves', 'desc', 'description', 'type',
    'phase', 'week', 'period', 'time', 'deliverable', 'output', 'go_no_go', 'criterion', 'gate',
    'likely_attack', 'attack', 'risk', 'preemptive_fix', 'fix', 'rebuttal_line', 'response', 'answer']
  const parts = []
  for (const k of keys) {
    const v = o[k]
    if (v == null || String(v).trim() === '') continue
    parts.push(`${k}：${typeof v === 'object' ? JSON.stringify(v) : v}`)
  }
  if (parts.length) return parts.join(' · ')
  return Object.entries(o).map(([k, v]) => `${k}：${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')
}

export function renderPlanMd(run) {
  const p = run.plan || {}
  const lines = [
    `# 投稿作战计划 — ${run.plan?.title_candidates?.[0] || run.input?.topic || ''}`,
    '',
    `> ${p.one_sentence_claim || ''}`,
    '',
    `## 候选标题`,
    ...(p.title_candidates || []).map((t) => `- ${t}`),
    '',
    '## 故事线',
    `- **钩子**：${p.story?.hook || ''}`,
    `- **缺口**：${p.story?.gap || ''}`,
    `- **洞察**：${p.story?.insight || ''}`,
    `- **证据链**：${p.story?.evidence || ''}`,
    '',
    '## 贡献（每条对应一张图表）',
    ...(p.contributions || []).map((c, i) => `${i + 1}. ${typeof c === 'string' ? c : itemText(c)}`),
    '',
    '## 实验矩阵',
    (p.experiment_matrix?.main_table?.rows || []).length ? `- 主表行：${p.experiment_matrix.main_table.rows.join(' / ')}` : '',
    (p.experiment_matrix?.main_table?.cols || []).length ? `- 主表列：${p.experiment_matrix.main_table.cols.join(' / ')}` : '',
    (p.experiment_matrix?.main_table?.must_include || []).length ? `- 必做 baseline：${p.experiment_matrix.main_table.must_include.join(' / ')}` : '',
    (p.experiment_matrix?.datasets || []).length ? `- 数据集：${p.experiment_matrix.datasets.join(' / ')}` : '',
    (p.experiment_matrix?.metrics || []).length ? `- 指标与检验：${p.experiment_matrix.metrics.join(' / ')}` : '',
    '',
    (p.experiment_matrix?.ablations || []).length ? '### 必做消融' : '',
    ...(p.experiment_matrix?.ablations || []).map((a) => `- [ ] ${a}`),
    (p.experiment_matrix?.ablations || []).length ? '' : '',
    (p.experiment_matrix?.robustness || []).length ? '### 鲁棒性' : '',
    ...(p.experiment_matrix?.robustness || []).map((a) => `- ${a}`),
    (p.experiment_matrix?.robustness || []).length ? '' : '',
    (p.figures || []).length ? '## 图表清单' : '',
    ...(p.figures || []).map((f) => `- ${itemText(f)}`),
    (p.figures || []).length ? '' : '',
    (p.timeline || []).length ? '## 倒排时间线' : '',
    ...(p.timeline || []).map((t) => `- ${itemText(t)}`),
    (p.timeline || []).length ? '' : '',
    (p.rebuttal_ammo || []).length ? '## Rebuttal 预案' : '',
    ...(p.rebuttal_ammo || []).map((r) => `- ${itemText(r)}`),
    (p.rebuttal_ammo || []).length ? '' : '',
    (p.kill_criteria || []).length ? '## 止损条件' : '',
    ...(p.kill_criteria || []).map((k) => `- ${k}`),
    (p.kill_criteria || []).length ? '' : '',
    (p.red_lines || []).length ? '## 红线' : '',
    ...(p.red_lines || []).map((k) => `- ${k}`),
    (p.red_lines || []).length ? '' : '',
    (p.next_three_actions || []).length ? '## 接下来 72 小时' : '',
    ...(p.next_three_actions || []).map((a, i) => `${i + 1}. ${a}`),
    (p.next_three_actions || []).length ? '' : '',
  ]
  if (run.acDecision) {
    lines.push('## AC 合议摘要', '', renderAc(run.acDecision), '')
  }
  return lines.join('\n')
}

/* ───────────────────────── mock ───────────────────────── */

function mockText(phase, lane) {
  const body = {
    brief: { one_sentence_claim: `（mock）${lane} 的一句话主张`, problem: 'mock problem', contribution_angles: ['切法1', '切法2', '切法3'], minimum_publishable_unit: 'mock 最小单元', reviewer_first_question: 'mock 第一问' },
    position: { take: `mock 立场 ${lane}`, contribution_claim: 'mock 主张', claim_type: '新方法', key_figure_or_table: 'Fig.2', decisive_experiment: 'mock 实验', biggest_risk: 'mock 风险', disagreement: 'mock 分歧' },
    rebuttal: { disagree_with: 'mock 反驳对象', why_wrong: 'mock 理由', concede: 'mock 让步', decisive_test: 'mock 裁决', revised_claim: 'mock 修正主张', if_i_am_wrong: 'mock 容错' },
    review: { persona: 'mock 审稿人', summary: 'mock 复述', scores: { novelty: 5, rigor: 5, impact: 5, clarity: 6, overall: 5 }, verdict: 'borderline', weaknesses: ['mock 弱点'], fatal_if_unaddressed: ['mock 致命'], required_experiments: ['mock 实验'] },
    ac: { scores_table: [{ persona: 'A', overall: 5, verdict: 'borderline' }], ac_decision: 'mock AC', consensus_weaknesses: ['mock 共识问题'], decisive_experiment: 'mock 决胜' },
    plan: { title_candidates: ['mock 标题'], one_sentence_claim: 'mock 主张', story: { hook: 'h', gap: 'g', insight: 'i', evidence: 'e' }, contributions: ['c1', 'c2', 'c3'], experiment_matrix: { main_table: { rows: ['r'], cols: ['c'], must_include: ['b'] }, ablations: ['a1'], datasets: ['d1'], metrics: ['m1'], robustness: ['r1'] }, figures: [{ id: 'Fig.1', purpose: 'p', type: '曲线' }], timeline: [{ phase: '第1-2周', deliverable: 'd', go_no_go: 'g' }], rebuttal_ammo: [{ likely_attack: 'a', preemptive_fix: 'f', rebuttal_line: 'r' }], kill_criteria: ['k'], red_lines: ['不许编数据'], next_three_actions: ['a1', 'a2', 'a3'] },
  }[phase]
  return JSON.stringify(body || { ok: true })
}

/**
 * 只重跑「作战计划」阶段：读已落盘的 run.json（简报/全量讨论/审稿），补一次规划。
 * 用途：计划被 max_tokens 截断、或想换 lead 重写，而不必重跑整场圆桌。
 */
export async function regeneratePlan({ runDir, cfg, signal }) {
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
  const venue = resolveVenue(run.venue || cfg.venue || 'neurips')
  const enabled = Object.keys(run.lanes || {}).filter((k) => cfg.lanes?.[k]?.enabled !== false)
  const lead = controllerLane(cfg)
  const discussion = (run.transcript || []).map((t) => ({ label: t.role, text: t.text }))
  const ctx = { input: run.input, venue, brief: run.brief, transcript: discussion, reviews: run.reviews || [] }
  const lanes = [lead, ...enabled.filter((l) => l !== lead)]

  const { plan } = await gatherPlan(ctx, lanes, async (lane, prompt, tag) => {
    try {
      const res = await callLane(lane, cfg, {
        system: prompt.system, user: prompt.user, maxTokens: 6000, temperature: 0.45, reasoning: 'medium', json: true,
      }, { signal })
      return parseOrNull(res.text)
    } catch { return null }
  }, (msg) => console.log('[replan] ' + msg))

  if (!Object.keys(plan).length) throw new Error('重生成计划失败：所有主持线都未能产出计划')

  run.plan = plan
  run.dir = runDir
  store.writeJSON(runDir, 'plan.json', plan)
  store.writeText(runDir, 'plan.md', renderPlanMd(run))
  store.writeJSON(runDir, 'run.json', run)
  return plan
}

/* ───────────── 计划两段 + 缺字段补全 ───────────── */

const PLAN_REQUIRED = {
  core: ['title_candidates', 'one_sentence_claim', 'story', 'contributions'],
  ops: ['experiment_matrix', 'figures', 'timeline', 'rebuttal_ammo', 'kill_criteria', 'red_lines', 'next_three_actions'],
}

/**
 * 两段式生成计划，并校验必需字段——模型偶尔会"自行省略"若干键，这里点名补回来。
 * @param ctx   { input, venue, brief, transcript, reviews }
 * @param lanes 候选主持线（按优先级）
 * @param call  async (lane, prompt, tag) => parsed|null
 * @param log   进度回调
 */
export async function gatherPlan(ctx, lanes, call, log = () => {}) {
  const parts = {}
  for (const part of ['core', 'ops']) {
    let got = null
    let usedLane = null
    for (const lane of lanes) {
      got = await call(lane, planPromptPart(ctx, part), part)
      if (got && Object.keys(got).length) { usedLane = lane; break }
    }
    if (!got || !usedLane) { log(`${part}: 未产出`); continue }

    const missing = PLAN_REQUIRED[part].filter((k) => !(k in got))
    log(`${part}: keys=${Object.keys(got).join(',')}${missing.length ? ` 缺=${missing.join(',')}` : ''}`)
    if (missing.length) {
      const repair = await call(usedLane, planRepairPrompt(ctx, part, missing), `${part}-repair`)
      if (repair) {
        for (const k of missing) if (k in repair) got[k] = repair[k]
        log(`${part}: 补全后 keys=${Object.keys(got).join(',')}`)
      }
    }
    parts[part] = got
  }
  return { plan: { ...(parts.core || {}), ...(parts.ops || {}) }, parts }
}
