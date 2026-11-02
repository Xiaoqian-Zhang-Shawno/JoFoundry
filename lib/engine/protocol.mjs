/**
 * 协议层：简报 → 发散 → 盲评 → 综合 → 落盘。
 *
 * 关键设计（这是「各参与模型」相对「一个模型问三遍」的真正增量）：
 *   · 发散阶段三线用不同**认知透镜**，异构性来自视角而不是模型权重。
 *   · 盲评阶段隐去作者、按哈希打乱编号，压制自我偏袒。
 *   · 综合阶段由指定 lead 承担，必须逐条回应最强反对意见。
 *   · 任何一条线挂了都降级继续，不整体失败。
 */
import { controllerLane } from './config.mjs'
import { callLane } from './lanes.mjs'
import { extractJSON, closeBrackets, normalizeIdea, normalizeReview, asArray, str } from './parse.mjs'
import { briefPrompt, divergePrompt, critiquePrompt, synthesisPrompt, LENS_MAP } from './prompt.mjs'
import * as store from './store.mjs'

const MOCK = process.env.FOUNDRY_MOCK === '1'

export async function runFoundry({ input, cfg, onEvent = () => {}, signal }) {
  const startedAt = new Date()
  const runId = store.makeRunId(input.topic, startedAt)
  const runDir = store.createRunDir(cfg.vault, runId)

  const enabled = Object.entries(cfg.lanes).filter(([, v]) => v && v.enabled !== false)
  if (!enabled.length) throw new Error('没有任何可用线路')

  const run = {
    id: runId,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    input,
    lanes: Object.fromEntries(enabled.map(([k, v]) => [k, { label: v.label, model: v.model, kind: v.kind, lens: v.lens }])),
    brief: null,
    seeds: [],
    critiques: [],
    scores: {},
    proposals: null,
    calls: [],
    errors: [],
    degraded: [],
    dir: runDir,
  }

  const emit = (ev) => { try { onEvent(ev) } catch { /* UI 出错不影响运行 */ } }
  emit({ type: 'run-created', runId, dir: runDir })
  const usedLanes = enabled.map(([k]) => k)
  const leadLane = controllerLane(cfg)

  /** 一次带记账的模型调用；失败只登记，不抛出（由调用方决定是否致命）。 */
  async function ask(lane, stage, prompt, { maxTokens, temperature = 0.8 } = {}) {
    emit({ type: 'lane-start', stage, lane })
    const t0 = Date.now()
    try {
      const res = MOCK
        ? { text: mockText(stage, lane, { input, ids: mockIds }), model: `${lane}-mock`, ms: 5, usage: null }
        : await callLane(lane, cfg, {
            system: prompt.system,
            user: prompt.user,
            maxTokens,
            temperature,
            json: true,
          }, { signal })
      run.calls.push({ stage, lane, model: res.model, ms: res.ms, usage: res.usage, ok: true })
      emit({ type: 'lane-done', stage, lane, ms: Date.now() - t0 })
      return res
    } catch (err) {
      run.calls.push({ stage, lane, ms: Date.now() - t0, ok: false, error: String(err.message || err) })
      run.errors.push({ stage, lane, error: String(err.message || err) })
      emit({ type: 'lane-error', stage, lane, error: String(err.message || err) })
      return null
    }
  }

  let mockIds = []

  /* ── 1. 简报 ── */
  emit({ type: 'stage', stage: 'brief', message: '生成研究简报' })
  let brief = null
  {
    const prompt = briefPrompt(cfg, input)
    const res = await ask(leadLane, 'brief', prompt, { maxTokens: 1600, temperature: 0.4 })
    if (res) {
      try { brief = extractJSONSafe(res.text) } catch (err) {
        run.errors.push({ stage: 'brief', lane: leadLane, error: 'JSON 解析失败: ' + err.message })
      }
    }
    if (!brief) {
      brief = heuristicBrief(input)
      run.degraded.push('brief:fallback')
      emit({ type: 'stage-degraded', stage: 'brief', message: '简报降级为启发式构造' })
    }
    run.brief = brief
    store.writeJSON(runDir, 'brief.json', brief)
    store.writeText(runDir, 'brief.md', store.renderBriefMd(run))
  }

  /* ── 2. 发散 ── */
  emit({ type: 'stage', stage: 'diverge', message: '各线路并行发散' })
  const seedResults = await Promise.all(usedLanes.map(async (lane) => {
    const lensKey = cfg.lanes[lane]?.lens || 'mechanism'
    const prompt = divergePrompt(cfg, brief, lane, lensKey, cfg.protocol.seedsPerLane || 3)
    const res = await ask(lane, 'diverge', prompt, { maxTokens: cfg.protocol.maxTokensDiverge || 3200, temperature: 0.95 })
    if (!res) return []
    try {
      const parsed = extractJSONSafe(res.text)
      const list = asArray(parsed?.ideas ?? parsed?.ideas_list ?? parsed)
      return list
        .filter((x) => x && (x.title || x.hypothesis))
        .map((x) => normalizeIdea(x, { lane, lens: LENS_MAP[lensKey]?.name || lensKey }))
    } catch (err) {
      run.errors.push({ stage: 'diverge', lane, error: 'JSON 解析失败: ' + err.message })
      return []
    }
  }))

  run.seeds = seedResults.flat()
  if (!run.seeds.length) throw new Error('发散阶段没有产出任何想法（全部线路失败或输出不可解析）')

  // 稳定洗牌后统一编号，盲评只看到 S1..Sn
  const seedList = stableShuffle(run.seeds, runId)
  seedList.forEach((s, i) => { s.id = `S${i + 1}` })
  run.seeds = seedList
  mockIds = seedList.map((s) => s.id)
  store.writeJSON(runDir, 'seeds.json', run.seeds)
  store.writeText(runDir, 'seeds.md', store.renderSeedsMd(run))

  /* ── 3. 盲评 ── */
  emit({ type: 'stage', stage: 'critique', message: `盲评 ${run.seeds.length} 条想法` })
  const blinded = run.seeds.map((s) => ({
    id: s.id,
    title: s.title,
    one_liner: s.one_liner,
    gap: s.gap,
    hypothesis: s.hypothesis,
    mechanism: s.mechanism,
    predictions: s.predictions,
    minimal_experiment: s.minimal_experiment,
    novelty_vs_literature: s.novelty_vs_literature,
    kill_criterion: s.kill_criterion,
  }))

  const critiqueResults = await Promise.all(usedLanes.map(async (lane) => {
    const prompt = critiquePrompt(cfg, brief, blinded)
    const res = await ask(lane, 'critique', prompt, { maxTokens: cfg.protocol.maxTokensCritique || 2400, temperature: 0.2 })
    if (!res) return []
    try {
      const parsed = extractJSONSafe(res.text)
      return asArray(parsed?.reviews ?? parsed).map((r) => ({ ...normalizeReview(r), lane }))
    } catch (err) {
      run.errors.push({ stage: 'critique', lane, error: 'JSON 解析失败: ' + err.message })
      return []
    }
  }))

  run.critiques = critiqueResults.flat()
  run.scores = aggregateScores(run.seeds, run.critiques, cfg.weights)
  store.writeJSON(runDir, 'critiques.json', run.critiques)
  store.writeJSON(runDir, 'scores.json', run.scores)
  store.writeText(runDir, 'critiques.md', store.renderCritiquesMd(run))

  if (!run.critiques.length) {
    run.degraded.push('critique:none')
    emit({ type: 'stage-degraded', stage: 'critique', message: '盲评全部失败，按发散顺序加权' })
  }

  /* ── 4. 综合 ── */
  emit({ type: 'stage', stage: 'synthesize', message: '综合成最终选题' })
  const ranked = [...run.seeds].sort((a, b) => (run.scores[b.id]?.weighted ?? 0) - (run.scores[a.id]?.weighted ?? 0))
  const keep = ranked.slice(0, cfg.protocol.keepTopSeeds || 6)
  const topCritiques = run.critiques.filter((c) => keep.some((s) => s.id === c.id))

  let proposals = null
  for (const lane of [leadLane, ...usedLanes.filter((l) => l !== leadLane)]) {
    const prompt = synthesisPrompt(cfg, brief, keep, topCritiques, pickScores(run.scores, keep))
    const res = await ask(lane, 'synthesize', prompt, { maxTokens: cfg.protocol.maxTokensSynthesis || 5000, temperature: 0.5 })
    if (!res) continue
    try {
      proposals = extractJSONSafe(res.text)
      if (proposals && (proposals.proposals || []).length) break
    } catch (err) {
      run.errors.push({ stage: 'synthesize', lane, error: 'JSON 解析失败: ' + err.message })
    }
  }
  if (!proposals) {
    run.degraded.push('synthesize:none')
    proposals = {
      portfolio_rationale: '综合阶段失败，仅给出按盲评分排序的候选想法。',
      proposals: keep.slice(0, 3).map((s, i) => ({
        rank: i + 1,
        title: s.title,
        pitch: s.one_liner,
        chain: { gap: s.gap, hypothesis: s.hypothesis, prediction: (s.predictions || []).join('；') },
        why_it_works: s.mechanism,
        pilot: { steps: ['（综合失败，需人工补 pilot 设计）'], data: s.minimal_experiment?.data, compute: s.minimal_experiment?.cost, time: s.minimal_experiment?.effort },
        expected_result: '', interpretation: '', falsification: s.kill_criterion, resources: '',
        risks: s.risks, prior_work_to_verify: [s.novelty_vs_literature].filter(Boolean),
        reviewer_objections: [], next_steps: [],
      })),
      pick: keep[0]?.title || '',
      kill_switches: [],
      open_questions_for_human: ['本次综合阶段失败，建议重跑或人工整合。'],
    }
  }
  run.proposals = proposals
  run.finishedAt = new Date().toISOString()

  store.writeJSON(runDir, 'proposals.json', proposals)
  store.writeText(runDir, 'proposals.md', store.renderProposalsMd(run))
  store.writeJSON(runDir, 'run.json', publicRun(run))
  store.appendIndex(cfg.vault, indexEntry(run))

  emit({ type: 'done', stage: 'done', message: '完成', runId })
  return publicRun(run)
}

/* ───────────────────────── helpers ───────────────────────── */

function extractJSONSafe(text) {
  try { return extractJSON(text) } catch (first) {
    // max_tokens 撞线时补括号再试一次
    const repaired = closeBrackets(text.trim())
    try { return JSON.parse(repaired) } catch { throw first }
  }
}

function heuristicBrief(input) {
  return {
    problem: input.topic,
    why_hard: '（启发式：未能模型生成）',
    known: [],
    unknowns: [],
    competing_framings: [],
    success_criteria: input.goal || '',
    traps: [],
    _fallback: true,
  }
}

function stableShuffle(list, salt) {
  const arr = [...list]
  let h = 2166136261
  for (const ch of String(salt)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  for (let i = arr.length - 1; i > 0; i -= 1) {
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    const j = Math.abs(h) % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export function aggregateScores(seeds, reviews, weights) {
  const w = weights || { novelty: 0.35, significance: 0.3, feasibility: 0.2, testability: 0.15 }
  const out = {}
  for (const seed of seeds) {
    const rs = reviews.filter((r) => r.id === seed.id)
    const mean = (key) => {
      const vals = rs.map((r) => r[key]).filter((v) => typeof v === 'number')
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    }
    const novelty = mean('novelty')
    const significance = mean('significance')
    const feasibility = mean('feasibility')
    const testability = mean('testability')
    const parts = [
      [novelty, w.novelty], [significance, w.significance], [feasibility, w.feasibility], [testability, w.testability],
    ].filter(([v]) => v != null)
    const totalW = parts.reduce((a, [, ww]) => a + ww, 0) || 1
    const weighted = parts.reduce((a, [v, ww]) => a + v * ww, 0) / totalW
    out[seed.id] = {
      id: seed.id,
      title: seed.title,
      novelty, significance, feasibility, testability,
      weighted: Number.isFinite(weighted) ? weighted : 0,
      reviewers: rs.length,
      reviews: rs.map((r) => ({
        lane: r.lane,
        strongest_objection: r.strongest_objection,
        fatal_flaws: r.fatal_flaws,
        repair: r.repair,
        closest_prior_work: r.closest_prior_work,
      })),
    }
  }
  return out
}

function pickScores(scores, seeds) {
  const out = {}
  for (const s of seeds) if (scores[s.id]) out[s.id] = scores[s.id]
  return out
}

export function publicRun(run) {
  const { ...rest } = run
  return rest
}

function indexEntry(run) {
  const s = run.scores || {}
  const best = Object.values(s).sort((a, b) => b.weighted - a.weighted)[0]
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    topic: run.input?.topic,
    field: run.input?.field,
    seedCount: (run.seeds || []).length,
    proposalCount: (run.proposals?.proposals || []).length,
    topIdea: best?.title || run.seeds?.[0]?.title || '',
    lanes: Object.keys(run.lanes || {}),
    degraded: run.degraded || [],
    dir: run.dir,
  }
}

/* ───────────────────────── mock（离线自测用） ───────────────────────── */

function mockText(stage, lane, ctx) {
  if (stage === 'brief') {
    return JSON.stringify({
      problem: `（mock）${ctx.input.topic} 中的关键因果缺口`,
      why_hard: 'mock',
      known: ['mock 共识 A', 'mock 共识 B'],
      unknowns: ['mock 未知 1'],
      competing_framings: ['框架甲', '框架乙'],
      success_criteria: 'mock 成功标准',
      traps: ['mock 坑'],
    })
  }
  if (stage === 'diverge') {
    return JSON.stringify({
      ideas: [1, 2].map((i) => ({
        title: `${lane} 的 mock 想法 ${i}`,
        one_liner: `mock one-liner ${lane}-${i}`,
        gap: 'mock gap',
        hypothesis: `若 X 则 Y（${lane}-${i}）`,
        mechanism: 'mock mechanism',
        predictions: ['p1', 'p2'],
        minimal_experiment: { data: 'mock data', method: 'mock method', effort: '3 人月', cost: '低' },
        novelty_vs_literature: 'mock novelty【需核验】',
        why_now: 'mock why now',
        risks: ['r1'],
        kill_criterion: 'mock kill',
      })),
    })
  }
  if (stage === 'critique') {
    return JSON.stringify({
      reviews: (ctx.ids || []).map((id, i) => ({
        id,
        novelty: 3 + (i % 3),
        significance: 2 + (i % 3),
        feasibility: 4 - (i % 2),
        testability: 3,
        fatal_flaws: ['mock flaw'],
        strongest_objection: `mock 反对意见（${lane}）`,
        closest_prior_work: 'mock prior work【需核验】',
        repair: 'mock repair',
      })),
    })
  }
  return JSON.stringify({
    portfolio_rationale: 'mock 组合理由',
    proposals: [1, 2, 3].map((i) => ({
      rank: i,
      title: `mock 提案 ${i}`,
      pitch: 'mock pitch',
      chain: { gap: 'g', hypothesis: 'h', prediction: 'p' },
      why_it_works: 'w',
      pilot: { steps: ['step1', 'step2'], data: 'd', compute: 'c', time: '2 周' },
      expected_result: 'e', interpretation: 'i', falsification: 'f', resources: 'r',
      risks: ['risk'], prior_work_to_verify: ['paper【需核验】'], reviewer_objections: ['obj'], next_steps: ['n1'],
    })),
    pick: 'mock 提案 1',
    kill_switches: ['mock kill switch'],
    open_questions_for_human: ['mock question'],
  })
}
