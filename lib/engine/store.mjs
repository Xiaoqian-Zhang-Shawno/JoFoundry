/**
 * 产物落盘：每次运行一个不可变目录，外加 vault 根的 index.json。
 * 全部是纯文本（json + md），你可以直接丢进 Obsidian / Zotero 旁的知识库。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function slugify(s, max = 32) {
  const cleaned = String(s || 'untitled')
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (cleaned || 'untitled').slice(0, max)
}

export function makeRunId(topic, when = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  return `${stamp}-${slugify(topic)}`
}

export function createRunDir(vault, runId) {
  const dir = join(vault, 'runs', runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

function write(dir, name, content) {
  const p = join(dir, name)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  return p
}

export const writeJSON = (dir, name, value) => write(dir, name, JSON.stringify(value, null, 2) + '\n')
export const writeText = (dir, name, value) => write(dir, name, value)

/* ───────────────────────── markdown 渲染 ───────────────────────── */

export function renderBriefMd(run) {
  const b = run.brief || {}
  const lines = [
    `# 研究简报 — ${run.input?.topic || ''}`,
    '',
    `- 运行：\`${run.id}\``,
    `- 时间：${run.startedAt}`,
    `- 三个模型：${Object.entries(run.lanes || {}).map(([k, v]) => `${v.label || k}（${v.model || ''}）`).join(' · ')}`,
    '',
    `## 科学问题`,
    b.problem || '（未生成）',
    '',
    `## 为什么难`,
    b.why_hard || '',
    '',
    `## 已知共识`,
    ...(b.known || []).map((x) => `- ${x}`),
    '',
    `## 真正的未知`,
    ...(b.unknowns || []).map((x) => `- ${x}`),
    '',
    `## 竞争性框架`,
    ...(b.competing_framings || []).map((x) => `- ${x}`),
    '',
    `## 什么样的结果算推进`,
    b.success_criteria || '',
    '',
    `## 最容易掉的坑`,
    ...(b.traps || []).map((x) => `- ${x}`),
    '',
  ]
  return lines.join('\n')
}

export function renderSeedsMd(run) {
  const out = [`# 候选想法（发散阶段，共 ${(run.seeds || []).length} 条）`, '']
  for (const s of run.seeds || []) {
    out.push(`## ${s.id} · ${s.title}`)
    out.push(`> ${s.one_liner}`)
    out.push('')
    out.push(`- **透镜**：${s.lens}　**来源**：${run.lanes?.[s.lane]?.label || s.lane}`)
    out.push(`- **缺口**：${s.gap}`)
    out.push(`- **假设**：${s.hypothesis}`)
    out.push(`- **机制**：${s.mechanism}`)
    if (s.predictions?.length) out.push(`- **可证伪预测**：${s.predictions.map((p) => `\n  - ${p}`).join('')}`)
    const e = s.minimal_experiment || {}
    out.push(`- **最小实验**：数据 ${e.data}；方法 ${e.method}；工作量 ${e.effort}；成本 ${e.cost}`)
    out.push(`- **新颖性**：${s.novelty_vs_literature}`)
    out.push(`- **为何现在**：${s.why_now}`)
    if (s.risks?.length) out.push(`- **风险**：${s.risks.join('；')}`)
    out.push(`- **止损判据**：${s.kill_criterion}`)
    out.push('')
  }
  return out.join('\n')
}

export function renderCritiquesMd(run) {
  const out = ['# 盲评结果', '', '评分 1-5；加权分 = 新颖.35 + 意义.30 + 可行.20 + 可检验.15', '']
  const byId = new Map((run.seeds || []).map((s) => [s.id, s]))
  for (const [id, agg] of Object.entries(run.scores || {})) {
    const seed = byId.get(id) || {}
    out.push(`## ${id} · ${seed.title || ''} — 综合 ${agg.weighted.toFixed(2)}`)
    out.push(`新颖 ${fmt(agg.novelty)} / 意义 ${fmt(agg.significance)} / 可行 ${fmt(agg.feasibility)} / 可检验 ${fmt(agg.testability)}　（${agg.reviewers} 位评审）`)
    out.push('')
    for (const r of agg.reviews || []) {
      out.push(`- **${run.lanes?.[r.lane]?.label || r.lane}**：${r.strongest_objection || ''}`)
      if (r.fatal_flaws?.length) out.push(`  - 致命缺陷：${r.fatal_flaws.join('；')}`)
      if (r.repair) out.push(`  - 修补：${r.repair}`)
      if (r.closest_prior_work) out.push(`  - 最近工作：${r.closest_prior_work}`)
    }
    out.push('')
  }
  return out.join('\n')
}

function fmt(v) {
  return v == null ? '–' : Number(v).toFixed(1)
}

export function renderProposalsMd(run) {
  const p = run.proposals || {}
  const out = [
    `# 最终选题建议 — ${run.input?.topic || ''}`,
    '',
    `> ${p.portfolio_rationale || ''}`,
    '',
    `**如果只做一条：** ${p.pick || ''}`,
    '',
  ]
  for (const item of p.proposals || []) {
    out.push(`## #${item.rank} ${item.title}`)
    out.push(`> ${item.pitch}`)
    out.push('')
    out.push(`- **缺口**：${item.chain?.gap || ''}`)
    out.push(`- **假设**：${item.chain?.hypothesis || ''}`)
    out.push(`- **预测**：${item.chain?.prediction || ''}`)
    out.push(`- **机制**：${item.why_it_works || ''}`)
    const pilot = item.pilot || {}
    out.push(`- **两周 pilot**：`)
    for (const st of pilot.steps || []) out.push(`  - [ ] ${st}`)
    out.push(`  - 数据：${pilot.data || ''}｜算力：${pilot.compute || ''}｜时间：${pilot.time || ''}`)
    out.push(`- **预期结果**：${item.expected_result || ''}`)
    out.push(`- **结果解读**：${item.interpretation || ''}`)
    out.push(`- **证伪条件**：${item.falsification || ''}`)
    out.push(`- **资源**：${item.resources || ''}`)
    if (item.risks?.length) out.push(`- **风险**：${item.risks.join('；')}`)
    if (item.prior_work_to_verify?.length) {
      out.push(`- **待核验文献**：`)
      for (const w of item.prior_work_to_verify) out.push(`  - [ ] ${w}`)
    }
    if (item.reviewer_objections?.length) {
      out.push(`- **预判审稿意见**：`)
      for (const o of item.reviewer_objections) out.push(`  - ${o}`)
    }
    if (item.next_steps?.length) out.push(`- **下一步**：${item.next_steps.join(' → ')}`)
    out.push('')
  }
  if (p.kill_switches?.length) {
    out.push('## 全局止损条件')
    for (const k of p.kill_switches) out.push(`- ${k}`)
    out.push('')
  }
  if (p.open_questions_for_human?.length) {
    out.push('## 需要你自己判断的问题')
    for (const q of p.open_questions_for_human) out.push(`- ${q}`)
    out.push('')
  }
  return out.join('\n')
}

/* ───────────────────────── index ───────────────────────── */

export function indexPath(vault) {
  return join(vault, 'index.json')
}

export function appendIndex(vault, entry) {
  const p = indexPath(vault)
  let list = []
  try { if (existsSync(p)) list = JSON.parse(readFileSync(p, 'utf8')) } catch { list = [] }
  if (!Array.isArray(list)) list = []
  const filtered = list.filter((e) => e.id !== entry.id)
  filtered.unshift(entry)
  writeFileSync(p, JSON.stringify(filtered, null, 2) + '\n')
  return filtered
}

export function readIndex(vault) {
  try { return JSON.parse(readFileSync(indexPath(vault), 'utf8')) } catch { return [] }
}
