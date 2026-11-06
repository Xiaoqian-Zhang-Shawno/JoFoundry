/**
 * 总控协作模式：总控 当总控（派活 → 逐份裁决 → 续派/打回 → 综合 → 贡献评审 → 自动续航），
 * 可配置线路当执行者。
 *
 * 一个回合（一条用户消息或一次自动续航）：
 *   knowledge  总控先读经验手册（显式授权的知识源 / skill 库，见 knowledge.mjs）
 *   plan       总控给每个执行者派 1-2 个子任务（含交付物、验收标准、建议 skill）+ 常设指令
 *   pipeline   流水线执行，不等齐：
 *                · 执行者各自从队列取任务，做完立即上交，马上取下一个
 *                · 总控每收到汇报就裁决：打分、采纳/驳回、打回或续派下一步任务
 *                · 执行者没有任务时，去互审对方尚未互审过的汇报（空闲时间不浪费）
 *                · 某执行者连续失败，它的任务自动转给另一位（不中断）
 *   final      总控综合答复
 *   oral       总控抽出本回合的贡献主张 → 各参与模型各自独立做 10 轮 oral-paper-skill 整体评审，
 *              票数与合格门槛按评审配置计算；同一版本不重抽
 *   autopilot  （可选）总控根据结论与评审决定下一步，自动开启下一回合，直到达标/上限/用户停止
 *
 * 公告板：总控的常设指令与历次裁决写在 session.board，所有 Agent 的提示词都带上它。
 */
import { callLane } from './lanes.mjs'
import { extractJSON, salvageJSON, str, asArray } from './parse.mjs'
import { VENUES } from './playbook.mjs'
import * as store from './store.mjs'
import { getDigest, skillIndexText, loadSkillBodies, oralRubric } from './knowledge.mjs'
import { getUsage, laneWindow } from './usage.mjs'
import { FOUNDRY_HOME, controllerLane, workerLanes, enabledLanes, reviewConfig } from './config.mjs'
import { mkdirSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const MOCK = process.env.FOUNDRY_MOCK === '1'

export const HARD_LINES = `铁律：不虚构数据、实验结果、引用或 baseline 数字；不确定的文献/事实标【需核验】；
不建议任何学术不端（编数据、选择性报告、不公平对照、调测试集、一稿多投、抄袭）。"灌水技巧"一律按合规的录用工程理解。`

/** 每轮评审都是整体评审；额外重点轮换，减少十轮之间的同质化。 */
const ORAL_LENSES = [
  '问题是否值得解决', '最近邻与真实增量', '机制依据', '监督/数据假设是否合法', '决定性比较能否裁决主张',
  '适用范围与失效边界', '可否证性', '证据与主张是否匹配', '故事是否一句话说得清、对审稿人有说服力', '整体（不设额外重点）',
]

/** 技巧模板：前端一键选择，也给总控一个「这类任务该怎么拆」的提示。 */
export const TASK_TEMPLATES = {
  free: { name: '自由提问', hint: '' },
  topic: {
    name: '选题找坑',
    hint: '目标：找到 1 个"一句话能说清、审稿人第一问有数据可答"的切口。分工建议：一人从机制/理论找未解释现象，一人从近两年顶会趋势与跨域迁移找空白；各给 2-3 个候选并自评可行性。',
  },
  related: {
    name: '最近邻文献与新颖性',
    hint: '目标：列出最可能被审稿人拿来比较的最近邻工作，逐条说明差异是否真实。所有文献必须标【需核验】直到用户确认；禁止编造标题/作者/年份。',
  },
  experiment: {
    name: '实验设计与消融',
    hint: '目标：主表、必做 baseline、每个被声称机制对应的消融、显著性与多 seed、预算估计、止损判据。一人偏严谨性（公平对照、泄漏），一人偏性价比（最小可发表实验集）。必须遵守实验训练准则。',
  },
  writing: {
    name: '故事线与写作',
    hint: '目标：Hook/Gap/Insight/Evidence/Boundary 五段式；摘要初稿；贡献 C1 主线 + C2 机制 + C3 外溢，每条对应一张图表。一人写，一人以审稿人身份挑刺。',
  },
  review: {
    name: '模拟审稿与 Rebuttal',
    hint: '目标：两人分别扮演严厉审稿人（新颖性警察 / 实验严厉派）打分并列致命问题；总控汇总成 AC 意见与 rebuttal 预案、需补实验优先级。',
  },
  aiResearch: {
    name: 'AI 辅助科研方法',
    hint: '目标：针对用户当前项目，给出可落地的 AI 辅助科研工作流（文献、代码、实验管理、写作、审稿模拟），说明每一步人必须把关的地方与常见翻车点。',
  },
  multiAgent: {
    name: '多 Agent 协作技巧',
    hint: '目标：分析本次协作本身——分工是否合理、哪个模型在哪类任务上更可靠、如何设计提示与验收标准减少幻觉与附和，给出改进后的协作协议。',
  },
}

export function resolveVenueName(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return (VENUES[k] || VENUES.generic).name
}

export const laneName = (lane) => lane

/* ───────────────────────── 材料导入 ───────────────────────── */

const MATERIAL_MAX_FILE = 24_000
const MATERIAL_MAX_TOTAL = 60_000

/** 读取用户指定的本地文本文件（只允许家目录内、只读、截断），用作讨论材料。 */
export function loadMaterials(paths) {
  const home = homedir()
  const out = []
  let total = 0
  for (const raw of asArray(paths)) {
    const p = resolve(String(raw || '').trim().replace(/^~(?=\/|$)/, home))
    if (!p || p === home) continue
    if (!p.startsWith(home + '/')) { out.push({ path: p, error: '只允许读取家目录内的文件' }); continue }
    try {
      if (!existsSync(p) || !statSync(p).isFile()) { out.push({ path: p, error: '文件不存在' }); continue }
      let text = readFileSync(p, 'utf8')
      if (text.includes('\u0000')) { out.push({ path: p, error: '看起来不是文本文件' }); continue }
      const budget = Math.min(MATERIAL_MAX_FILE, MATERIAL_MAX_TOTAL - total)
      if (budget <= 0) { out.push({ path: p, error: '材料总量已达上限，跳过' }); continue }
      const truncated = text.length > budget
      if (truncated) text = text.slice(0, budget)
      total += text.length
      out.push({ path: p, chars: text.length, truncated, text })
    } catch (err) {
      out.push({ path: p, error: String(err.message || err) })
    }
  }
  return out
}

function materialsBlock(materials) {
  const ok = (materials || []).filter((m) => m.text)
  if (!ok.length) return ''
  return `【用户提供的材料】\n${ok.map((m) => `--- ${m.path}${m.truncated ? '（已截断）' : ''} ---\n${m.text}`).join('\n\n')}`
}

/* ───────────────────────── 科研目标 · 核心要义 ───────────────────────── */

const MISSION_FILE = join(FOUNDRY_HOME, 'mission.md')

/** 用户可在界面里改；全局保存在 ~/.dsh/research-foundry/mission.md，会话可单独覆盖。 */
export const DEFAULT_MISSION = `围绕用户明确的研究问题，形成可检验的假设、可追溯的证据和可执行的下一步。
区分已验证事实、模型建议与尚待核验的推断。不得虚构实验、数据或引用。
主张必须与证据匹配，保留负结果与适用边界。模型互审是辅助检查，不能替代真实实验与独立同行评审。`

export function getMission(session) {
  const own = String(session?.mission || '').trim()
  if (own) return own
  try { const t = readFileSync(MISSION_FILE, 'utf8').trim(); if (t) return t } catch { /* 用默认 */ }
  return DEFAULT_MISSION
}

export function setGlobalMission(text) {
  mkdirSync(FOUNDRY_HOME, { recursive: true })
  const t = String(text || '').trim()
  writeFileSync(MISSION_FILE, (t || DEFAULT_MISSION) + '\n')
  return getMission(null)
}

export function setSessionMission(session, text) {
  session.mission = String(text || '').trim()
  persist(session)
  return getMission(session)
}

export function missionBlock(session) {
  return `【科研目标 · 核心要义（用户设定）】\n${getMission(session)}${session?.autopilot?.enabled && session.autopilot.objective ? `\n\n【本会话当前续航目标】\n${session.autopilot.objective}` : ''}`
}

/* ───────────────────────── 长期记忆（Obsidian）与阶段反馈 ───────────────────────── */

/**
 * 每次调用都是无状态的：模型"记得"什么，完全取决于提示词里放了什么。提示词只保留最近几回合原文，
 * 更早的内容会被挤出去 —— 这就是遗忘。所以：
 *   · 触发条件 A：某条线路本会话的提示词逼近上下文预算（窗口 × triggerRatio，且不超过 softTokens）
 *   · 触发条件 B：有回合即将滑出提示词里保留的原文历史
 * 任一满足，回合结束时 总控 把关键信息整理成「关键记忆」，写进 Obsidian，并注入之后所有 Agent 的提示词。
 * 阶段反馈（每个任务完成了什么、遗留什么）每回合都追加写入 Obsidian。
 * 只写入单独的「多Agent协作记忆」文件夹，不碰研究主线等主记录。
 */
const HISTORY_KEEP = 3

function memoryCfg(cfg) {
  const m = cfg?.memory || {}
  const vault = m.obsidianVault || ''
  return {
    root: m.obsidianDir || (vault && existsSync(vault) ? join(vault, '多Agent协作记忆') : join(FOUNDRY_HOME, 'memory')),
    triggerRatio: Number(m.triggerRatio) || 0.7,
    softTokens: Number(m.softTokens) || 200_000,
  }
}

const safeName = (s) => String(s || 'session').replace(/[\\/:*?"<>|\n\r]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60)

export function memoryDir(session, cfg) {
  return join(memoryCfg(cfg).root, `${safeName(session.title)}（${session.id.slice(-4)}）`)
}

export function memoryBlock(session) {
  const m = session.memory
  if (!m?.text) return ''
  return `【长期记忆（第 ${m.version} 版，已存 Obsidian：${m.file || ''}）——之前回合的关键信息，所有 Agent 必须据此保持连贯，不得遗忘或推翻已确认结论】
${m.text.slice(0, 12_000)}`
}

/** 上一回合（或当前回合已裁决部分）的阶段反馈与遗留事项。 */
function stageBlock(session, turn, { current = false } = {}) {
  const src = current ? turn : [...session.turns].reverse().find((t) => t.id !== turn?.id && t.finishedAt)
  if (!src) return ''
  const items = asArray(src.ledger)
  const carry = asArray(src.carryOver)
  if (!items.length && !carry.length) return ''
  return `【${current ? '本回合' : `上一回合 ${src.id}`}阶段反馈${current ? '' : '（下一步判断必须基于它，遗留事项优先处理）'}】
${items.map((x) => `- ${x.taskId} ${laneName(x.worker)}｜${x.status}${x.score != null ? `｜${x.score}/10` : ''}｜${str(x.task).slice(0, 80)}
  反馈：${str(x.stage).replace(/\s+/g, ' ').slice(0, 500) || '（无）'}`).join('\n')}
${carry.length ? `遗留事项：\n${carry.map((c, i) => `${i + 1}. ${str(c)}`).join('\n')}` : ''}`
}

/* ───────────────────────── 决断原则（用户设定，长期有效） ───────────────────────── */

/* ───────────────────────── 论文写作规范（用户设定，长期有效） ───────────────────────── */

/** 写作要求与辅导 skill：凡是起草或修改论文正文（中文或英文）时都适用。 */
export const WRITING_SKILLS = ['paper-writer', 'scientific-writing', 'paper-spine', 'oral-paper-skill']
export const WRITING_STYLE = `【论文写作规范（适用于论文起草与修改）】
- 语言朴素：不用华丽辞藻、夸张修饰和营销式表达，例如"革命性""前所未有""显著突破""开创性"。陈述事实，让结果自己说话。
- 用词准确：每个术语和定量表述都要准确对应实际做了什么、测了什么。限定条件不丢（随机种子数、数据划分、评价口径）。
- 用词丰富：避免同一个词和同一种句式反复出现。在准确的前提下选用最贴切的词，而不是最响亮的词。
- 中英双份时，两版内容和数字完全一致；英文按目标会议的学术英语习惯写，不逐字硬译。
- 初稿以清楚、准确为先；润色是单独的后续步骤，起草时不要为了"漂亮"牺牲准确。
- 写作时参照以下 CCF-A 级写作 skill 的方法：${WRITING_SKILLS.join('、')}。`

const WRITING_TASK = /初稿|草稿|成稿|撰写|起草|润色|段落|章节|section|abstract|摘要|引言|introduction|related[- ]work|方法节|实验节|局限|limitation|合稿|全文|正文|paper|manuscript|写作/i

/* ───────────────────────── 主线把控（主持人） ───────────────────────── */

/**
 * 不用回合数阈值防止无休止循环，而是把主线方向交给主持人 主观把控：
 * 每回合结束，主持人对照「论文完整度地图」判断本回合实际推进了故事的哪一环、是否在原地打转，
 * 然后决定 继续 / 收敛 / 完成 / 需要用户。地图与主线方向注入所有 Agent 的提示词。
 */
export const STORY_ELEMENTS = [
  '一句话主张', '研究张力与动机', '最近邻与真实增量', '方法与机制', '主实验与决定性比较',
  '消融与机制证据', '失效边界与局限', '图表与证据链顺序', '论文初稿各节', 'Rebuttal 预案',
]
const STAGES = { explore: '探索', converge: '收敛', write: '成稿', done: '完成' }
const EVIDENCE_STAGES = ['define', 'minimal_check', 'iterate', 'validate', 'audit']
const EVIDENCE_DISPOSITIONS = ['advance', 'revise', 'reject_candidate', 'wait']
const ELEMENT_STATES = ['缺失', '讨论中', '有方案', '有证据', '已定稿']

/** 环节状态对应的参考分值：只作为主持人估计 CCF-A 进度时的锚点，进度本身由主持人判断。 */
const ELEMENT_WEIGHT = { 缺失: 0, 讨论中: 0.2, 有方案: 0.45, 有证据: 0.8, 已定稿: 1 }
export function mapCompletion(map) {
  const xs = asArray(map)
  if (!xs.length) return 0
  return Math.round((xs.reduce((a, x) => a + (ELEMENT_WEIGHT[x.status] ?? 0), 0) / xs.length) * 100)
}

function ensureMainline(s) {
  s.mainline ||= { direction: '', stage: 'explore', map: [], decisions: [] }
  s.mainline.progress ||= { percent: 0, reason: '', blocker: '', history: [] }
  const have = new Set(s.mainline.map.map((x) => x.element))
  for (const e of STORY_ELEMENTS) if (!have.has(e)) s.mainline.map.push({ element: e, status: '缺失', note: '' })
  return s.mainline
}

export function mainlineBlock(session) {
  const m = session.mainline
  if (!m || (!m.direction && !m.decisions.length)) return ''
  const last = m.decisions[m.decisions.length - 1]
  return `【主线（主持人 把控，所有 Agent 的工作必须服务于它，不得偏离或扩散）】
方向：${m.direction || '（待定）'}
阶段：${STAGES[m.stage] || m.stage}
CCF-A 进度（主持人评估）：${m.progress?.percent ?? 0}%${m.progress?.blocker ? `｜最大卡点：${m.progress.blocker}` : ''}
论文完整度：${m.map.map((x) => `${x.element}=${x.status}`).join('；')}
${last ? `主持人最近判断（${last.turn}）：${last.decision}｜${str(last.reason).slice(0, 200)}` : ''}
${last?.evidenceReview ? `证据阶段：${last.evidenceReview.stage}｜${last.evidenceReview.disposition}｜下一触发：${last.evidenceReview.nextTrigger}` : ''}`
}

/* ───────────────────────── 公告板与上下文 ───────────────────────── */

let handbook = { text: '', builtAt: null }

export function handbookBlock() {
  if (!handbook.text) return ''
  return `【总控《执行判断手册》——总控读取显式授权知识源后整理；所有 Agent 必须遵守】
${handbook.text.slice(0, 9000)}`
}

/** 总控常设指令 + 最近裁决：所有 Agent 都读。 */
export function boardBlock(session, { rulings = 6 } = {}) {
  const b = session.board || {}
  const dir = asArray(b.directives).map((d, i) => `${i + 1}. ${str(d)}`).join('\n')
  const recent = asArray(b.rulings).slice(-rulings).map((r) =>
    `- [${r.turn}·${laneName(r.worker)}·${r.taskId}] ${r.score ?? '–'}/10 ${r.verdict === 'revise' ? '打回' : '通过'}：${str(r.note || asArray(r.accepted).slice(0, 2).map(str).join('；')).slice(0, 160)}${asArray(r.rejected).length ? `｜驳回：${asArray(r.rejected).slice(0, 2).map((x) => str(x?.point ?? x)).join('；').slice(0, 120)}` : ''}`).join('\n')
  return [
    dir ? `【总控常设指令（第 ${b.version || 1} 版，所有 Agent 必须执行）】\n${dir}` : '',
    recent ? `【总控最近裁决（公告板）】\n${recent}` : '',
  ].filter(Boolean).join('\n')
}

export function contextBlock(session, turn) {
  const ctx = session.context || {}
  const covered = session.memory?.coveredTurns || 0
  const finished = (session.turns || []).filter((t) => t.id !== turn?.id && t.final)
  const history = finished
    .filter((t, i) => i >= covered || i === finished.length - 1)
    .slice(-HISTORY_KEEP)
    .map((t) => `[${t.id}] 用户：${t.user.slice(0, 400)}\n总控结论：${t.final.slice(0, 1200)}`)
    .join('\n\n')
  const template = TASK_TEMPLATES[turn?.template] || TASK_TEMPLATES.free
  return [
    missionBlock(session),
    mainlineBlock(session),
    memoryBlock(session),
    `【目标会议】${resolveVenueName(ctx.venue)}`,
    ctx.field ? `【领域】${ctx.field}` : '',
    ctx.constraints ? `【资源约束】${ctx.constraints}` : '',
    ctx.deadline ? `【截止】${ctx.deadline}` : '',
    ctx.background ? `【研究背景】${String(ctx.background).slice(0, 4000)}` : '',
    history ? `【之前的回合】\n${history}` : '',
    stageBlock(session, turn),
    template.hint ? `【任务类型：${template.name}】${template.hint}` : '',
    materialsBlock(session.materials),
  ].filter(Boolean).join('\n')
}

/* ───────────────────────── 提示词 ───────────────────────── */

function planPrompt(session, turn, workers, maxInitial, cfg) {
  const system = `你是总控，本次多 Agent 科研协作的总控与最终裁判。执行者：
${workers.map((w) => `- ${w}：擅长${cfg.lanes[w].strengths || '通用分析'}`).join('\n')}
你的职责：理解用户真实意图，把问题拆成互补而非重复的子任务，写清交付物与验收标准；你自己不在这一步回答问题。
若上下文里有上一回合的阶段反馈与遗留事项，先把遗留事项派出去，再安排新任务。
凡是需要实验才能判断的问题（包括分歧裁决、方案取舍），直接给 chatgpt 派实验任务拿证据，不要留给用户决定。
派写作任务时，在 skills 里优先选 ${WRITING_SKILLS.join(' / ')}；写作必须遵守论文写作规范（语言朴素、用词准确丰富）。
你是主持人，主线方向由你把控：所有任务都必须推进「论文完整度」里尚未完成的环节；与主线无关的支线一律不派。
处于「收敛/成稿」阶段时，不再开新方向，只补证据、定稿和写作。
执行流水线不等齐：每个执行者做完一个任务就立刻取下一个，所以可以给每人预排 1-${maxInitial} 个有先后顺序的任务，让他们不空闲。
你可以为每个任务从 skill 库挑 0-2 个最相关的 skill（只能用清单里的名字），系统会把 skill 原文交给执行者。
你还要写「常设指令」：所有 Agent 在本会话中都必须遵守的判断规则（来自手册与本问题的特殊要求）。
按用户的核心要义，故事优先：派活时至少有一个任务直接服务于论文故事（一句话主张、研究张力、贡献切片、证据链顺序、审稿人预判），
技术任务的验收标准里也要写明它支撑故事的哪一环。
${HARD_LINES}
只输出一个 JSON 对象，无 markdown 围栏。`
  const user = `${handbookBlock()}

${boardBlock(session)}

${contextBlock(session, turn)}

【skill 库清单】
${skillIndexText(70)}

【用户本轮消息】
${turn.user}

输出：
{
  "understanding": "你对用户真实需求的理解（≤150 字，指出隐含前提或可能问错的地方）",
  "strategy": "为什么这样分工（≤80 字）",
  "directives": ["本会话常设指令，3-8 条，具体可执行（保留已有仍有效的指令）"],
  "tasks": {
${workers.map((w) => `    "${w}": [ { "task": "具体子任务", "deliverable": "交付物形态", "acceptance": "验收标准", "skills": ["可选 skill 名"] } ]`).join(',\n')}
  },
  "watch_out": ["执行者最容易犯的 1-3 个错误"]
}`
  return { system, user }
}

function workerPrompt(session, turn, task, peersDoing) {
  const lane = task.worker
  const writing = WRITING_TASK.test(`${task.task} ${task.deliverable}`)
  const skills = loadSkillBodies(writing ? [...new Set([...asArray(task.skills), ...WRITING_SKILLS])].slice(0, 3) : task.skills)
  const system = `你是 ${laneName(lane)}，多 Agent 科研协作中的执行者，向总控 汇报。
总控会逐条核查并可能驳回或打回你的结论，所以：给具体可检验的内容，不要泛泛而谈；不知道就说不知道；
不要为了显得有用而编造文献、数字或实验结果。总控公告板上的常设指令与裁决对你有约束力，必须执行。${HARD_LINES}`
  const user = `${handbookBlock()}

${boardBlock(session)}

${contextBlock(session, turn)}

【用户本轮消息】
${turn.user}


${writing ? WRITING_STYLE : ''}

${skills.length ? `【总控为本任务指定的 skill（照其方法执行）】\n${skills.map((s) => `--- ${s.name} ---\n${s.text}`).join('\n\n')}\n` : ''}
【总控派给你的任务 ${task.id}${task.attempt > 1 ? `（第 ${task.attempt} 版，打回重做）` : ''}】
任务：${str(task.task, turn.user)}
交付物：${str(task.deliverable, '结构化分析')}
验收标准：${str(task.acceptance, '具体、可检验、无编造')}
${task.feedback ? `\n【总控打回意见——必须逐条回应】\n${task.feedback}\n\n【你上一版汇报】\n${String(task.previous || '').slice(0, 5000)}` : ''}
${peersDoing ? `\n【其他执行者正在做】${peersDoing}（避免重复，必要时互相衔接）` : ''}

必须把任务完整执行完；若篇幅不够，优先保证「结论」「阶段反馈」完整。
请用 markdown 按以下小节汇报（总长 ≤ 1800 字）：
## 结论
（3 句以内，直接回答任务）
## 交付内容
## 依据与置信度
（每个关键判断后标 [高/中/低]；文献一律标【需核验】）
## 风险与反例
## 对故事的贡献
（这份结果支撑论文故事的哪一环：主张 / 张力 / 贡献切片 / 证据链 / 审稿人预判；若会削弱故事，直说）
## 阶段反馈
- 已完成：（逐条对照任务与验收标准）
- 未完成及原因：（没做完的必须写，不许省略）
- 阻塞与所需资源：
- 建议下一步：
## 需要总控决定的问题
（若无写"无"）`
  return { system, user }
}

function crossPrompt(session, lane, target) {
  const system = `你是 ${laneName(lane)}，利用空闲时间审阅另一位执行者的汇报。目标是帮总控发现错误，不是客气。
逐条指出：事实/逻辑错误、可疑或可能编造的文献与数字、违反总控常设指令或实验准则之处、遗漏的关键点、你同意且能补强的点；
并从"故事"角度挑刺：主张是否一句话说得清、是否讲成了功能堆砌、是否有为了故事而夸大的地方。
若对方汇报是论文正文，还要按写作规范挑刺：是否用了华丽或夸张的措辞、是否丢了限定条件、用词是否单调重复。${HARD_LINES}`
  const mission = missionBlock(session)
  const user = `${mission}

${boardBlock(session)}

【${laneName(target.worker)} 的任务 ${target.id}】${str(target.task)}
【其汇报】
${String(target.report).slice(0, 6000)}

用 markdown 输出（≤ 600 字）：
## 错误或可疑之处
## 违反指令/准则
## 遗漏
## 故事角度
## 同意并补强
## 一句话评价`
  return { system, user }
}

function judgePrompt(session, turn, plan, batch, lateCrosses, budget) {
  const system = `你是总控，现在是裁判。逐份核查刚上交的汇报：采纳有依据的、驳回错误或无依据的，对照验收标准打分。
按用户的核心要义"故事优先"评判：同等严谨的前提下，更能让论文故事清晰、可信、一句话说得清的结果得分更高；
堆功能、跑题、与故事无关的工作要指出并收敛。但为了故事而夸大结果、隐藏反例、编造动机的内容一律驳回。
可疑文献/数字一律不采纳为事实，只能列入"需核验"。互审意见只是线索，需你自己判断。
你的裁决会写进公告板，所有 Agent 都会读到并执行，所以要具体。
决断不交给用户：执行者汇报里"需要用户决定/确认"的问题，凡是科研判断或需要实验的，由你按"哪个更能写好故事、更容易发文"裁决，
证据不足就在 next_task 里派 chatgpt 做实验。
写作类汇报额外按论文写作规范打分：华丽或夸张的措辞、丢失限定条件、用词单调重复，都要在 rejected 里指出，并在打回指令里给出具体改法。
分歧处理：执行者之间、或执行者与你之间，若存在影响主线/故事且能用证据裁决的实质分歧，把 debate 设为 true 并写明双方立场，
系统会让双方带证据相互说服、由你核查后终裁（每回合最多 2 个）；措辞差异、无关紧要或纯偏好的分歧不要开辩。
每份汇报都有「阶段反馈」小节：核对它声称已完成的是否真的完成；未完成或遗留的写进 carry_over，系统会带到下一回合。
流水线原则：执行者不应空闲——若该执行者还有步数预算、而任务仍有值得推进的部分，给出 next_task（建立在你的裁决之上，不重复已完成内容）；
不达标且重做能显著提升时给 verdict=revise 和具体打回指令（每个任务最多打回 ${budget.maxRevise} 次）；任务已充分完成就不要硬派。
${HARD_LINES}
只输出一个 JSON 对象，无 markdown 围栏。`
  const user = `${missionBlock(session)}

${handbookBlock()}

${boardBlock(session, { rulings: 10 })}

【用户本轮消息】${turn.user}
【你的理解】${str(plan?.understanding)}
【执行者预算】${Object.entries(budget.left).map(([w, n]) => `${w} 还可续派 ${n} 个新任务`).join('；')}
【执行者当前状态】${budget.status}
${batch.map((t) => `
【待裁决：${t.id}（${t.worker}，第 ${t.attempt} 版，已打回 ${t.attempt - 1} 次）】
任务：${str(t.task)}｜验收：${str(t.acceptance)}
汇报：
${String(t.report).slice(0, 6000)}
${Object.entries(t.crosses || {}).map(([w, c]) => `（${w} 的互审）\n${String(c).slice(0, 2000)}`).join('\n')}`).join('\n')}
${lateCrosses.length ? `\n【对已裁决汇报的迟到互审（可用于修正常设指令或后续任务）】\n${lateCrosses.map((c) => `- ${c.by} 审 ${c.taskId}：${String(c.text).slice(0, 1200)}`).join('\n')}` : ''}

输出：
{
  "rulings": [
${batch.map((t) => `    { "task_id": "${t.id}", "score": 1-10, "story_score": 1-10, "accepted": ["采纳的要点"], "rejected": [ { "point": "驳回的要点", "reason": "理由" } ], "verdict": "accept 或 revise", "revise_instruction": "打回指令（accept 则空）", "next_task": { "task": "...", "deliverable": "...", "acceptance": "...", "skills": [] } 或 null, "carry_over": ["本任务遗留、下一回合需继续的事项（无则空数组）"], "note": "一句话评语" }`).join(',\n')}
  ],
  "directives": ["更新后的完整常设指令清单（3-10 条；无变化就原样返回）"],
  "conflicts": [ { "issue": "分歧点", "ruling": "你的初步裁决", "why": "理由", "debate": true 或 false, "sides": { "参与方线路 ID（与派工列表一致）": "该方立场（一句话）" } } ]
}`
  return { system, user }
}

function finalPrompt(session, turn, plan, tasks) {
  const system = `你是总控，给用户写最终答复。以你的裁决为准，明确说明采纳了谁的什么、驳回了什么。
语气像一位负责任的合作导师：直接、具体、可执行。遵守《执行判断手册》与常设指令。
按用户的核心要义，先讲故事：答复第一节就是当前最好的论文故事版本，后面的内容都围绕它展开。${HARD_LINES}`
  const latest = tasks.filter((t) => t.report && !t.superseded)
  const user = `${handbookBlock()}

${boardBlock(session, { rulings: 12 })}

${contextBlock(session, turn)}

【用户本轮消息】
${turn.user}

【你的理解】${str(plan?.understanding)}
${stageBlock(session, turn, { current: true })}
${asArray(turn.disputes).filter((d) => d.verdict).map((d) => `【分歧说服 ${d.id} 终裁】${d.issue}：${str(d.verdict.ruling)}（${str(d.verdict.why)}）`).join('\n')}
${latest.map((t) => `
【${t.id}（${t.worker}）${str(t.task).slice(0, 120)}】得分 ${t.ruling?.score ?? '–'}/10
${String(t.report).slice(0, 3500)}
${Object.entries(t.crosses || {}).map(([w, c]) => `（${w} 互审）${String(c).slice(0, 800)}`).join('\n')}`).join('\n')}

用 markdown 输出（≤ 2200 字）：
## 故事线（当前最好版本）
- 一句话主张：
- 研究张力（开场钩子）：
- 关键洞察：
- 贡献切片：C1 主线 / C2 机制证据 / C3 外溢（各对应哪张图表）
- 证据链：按论证顺序列出图表
- 失效边界（主动写给审稿人看）：
- 故事最薄弱的一环：
## 结论
## 依据（采纳了谁的什么）
## 分歧与裁决
## 需要核验
（文献、数字、未经实验验证的判断）
## 阶段反馈汇总
（各执行者完成了什么、没完成什么；遗留到下一回合的事项）
## 下一步
（按优先级 1-3 条，能在 72 小时内开始的）`
  return { system, user }
}

function extractPrompt(session, turn) {
  const system = `你是总控。判断本回合是否形成了一个可以送审的、具体的研究贡献主张（问题+增量+证据计划）。
泛泛的建议、流程讨论、工具使用技巧不算。若有，按固定字段把它写成一个可评审的贡献版本，不添油加醋、不夸大。
只输出一个 JSON 对象，无 markdown 围栏。`
  const user = `${contextBlock(session, turn)}

【用户本轮消息】${turn.user}
【本回合结论】
${String(turn.final).slice(0, 6000)}

输出：
{
  "has_contribution": true 或 false,
  "why_not": "若 false，原因",
  "title": "贡献版本名（≤30 字）",
  "contribution_type": "新问题 / 新方法 / 新发现 / 新系统 / 资源 / 理论",
  "problem": "要解决的问题与研究张力",
  "nearest_neighbors": "最近邻工作及其局限（文献标【需核验】）",
  "delta": "具体增量：相对最近邻到底改变了什么",
  "mechanism": "为什么会有效的机制依据",
  "supervision": "监督/数据假设，是否合法",
  "decisive_comparison": "能裁决主张的决定性比较",
  "scope": "适用范围与失效边界",
  "falsifiable_by": "什么结果会否证它",
  "evidence_status": "目前已有证据 vs 仍是计划",
  "story": "一句话主张 + 研究张力 + 关键洞察 + 证据链（按论证顺序）"
}`
  return { system, user }
}

function contributionText(c) {
  return [
    `贡献版本：${str(c.title)}（${str(c.contribution_type)}）`,
    `问题：${str(c.problem)}`,
    `最近邻：${str(c.nearest_neighbors)}`,
    `具体增量：${str(c.delta)}`,
    `机制依据：${str(c.mechanism)}`,
    `监督假设：${str(c.supervision)}`,
    `决定性比较：${str(c.decisive_comparison)}`,
    `适用范围：${str(c.scope)}`,
    `可否证性：${str(c.falsifiable_by)}`,
    `证据状态：${str(c.evidence_status)}`,
    `故事线：${str(c.story)}`,
  ].join('\n')
}

function oralVotePrompt(session, cfg, contribution, round, lens) {
  const { rounds } = reviewConfig(cfg)
  const system = `你在做第 ${round}/${rounds} 轮 CCF-A 贡献价值整体评审。本轮是一次独立调用：你看不到其他轮或其他模型的意见。
评审依据是下面 oral-paper-skill 原文与用户的贡献审核规则。审核对象是论文贡献本身：问题、最近邻、具体增量、机制依据、
监督假设、决定性比较、适用范围和可否证性。工程能跑、成本有限、文档齐全与谨慎边界是条件，不是新颖性证据；
不能把标准降成"值得小试"。判断不确定时选"保留"，保留不计积极。不要编造文献；不确定的最近邻标【需核验】。
只输出一个 JSON 对象，无 markdown 围栏。`
  const ctx = session.context || {}
  const user = `${oralRubric(cfg)}

【目标会议】${resolveVenueName(ctx.venue)}${ctx.field ? `｜领域：${ctx.field}` : ''}
${ctx.background ? `【研究背景】${String(ctx.background).slice(0, 2500)}` : ''}

【待评审贡献】
${contribution}

【本轮额外重点】${lens}（仍须给出整体判断）

输出：
{
  "verdict": "积极 / 保留 / 消极（整体是否达到 CCF-A 可认可的贡献）",
  "score": 1-10,
  "strongest_point": "最强的一点",
  "fatal_issue": "最致命的问题（没有写无）",
  "nearest_neighbor_risk": "最可能撞车的最近邻及差异是否真实",
  "decisive_evidence_needed": "要让你转为积极/保持积极，必须看到的证据",
  "reason": "≤120 字理由"
}`
  return { system, user }
}

function nextPrompt(session, turn, oral) {
  const m = session.mainline
  const evidenceWorkflow = session.workflow === 'evidence'
  const system = `你是主持人，用户让你协助把控当前研究项目的主线方向。目标是讲好一个完整的故事、把论文完成，
而不是无休止地开回合。没有回合数上限——是否继续完全由你判断，所以你必须对每一次判断负责：

1. 先更新「论文完整度地图」：逐项判断每个故事环节现在的状态（${ELEMENT_STATES.join(' / ')}），只按真实证据定状态。
2. 说清本回合实际推进了哪几个环节（引用阶段反馈里的具体产出）；如果什么都没推进，就是原地打转。
3. 自查循环：对照之前的判断记录，如果连续在同一个环节上讨论却没有新产出、或在反复改写同一主张、或不断开新支线，
   就必须换做法（换切入点、收窄主张、转入写作）或停下来问用户，不许再用同样的方式继续。
4. 决定阶段与动作：
   - continue：故事还有明确缺口，且下一回合能具体推进它
   - converge：故事主干已够，停止探索新方向，只补证据和定稿。需给出下一步可交付工作。
   ${evidenceWorkflow ? '- wait：缺少决定所需证据。写清证据、负责人或来源及触发条件，保留目标并等下一条输入。' : '当前回合可以推进时，下一步优先选择不依赖在途实验的工作。'}
   - finish：故事完整、各环节至少"有证据"、可以进入投稿收尾；停止自动续航，交给用户
   - need_user：只限于需要用户本人才有的东西（未公开资料、账号、署名、投稿提交、付费）或不可逆的对外动作。
5. 给出「CCF-A 进度」百分比：这篇论文离"故事完整、可以投稿"还有多远，由你主观判断，但必须与完整度地图对齐
   （地图参考值见上方「当前 CCF-A 进度」：环节状态 缺失 0 / 讨论中 0.2 / 有方案 0.45 / 有证据 0.8 / 已定稿 1 取平均）。
   偏离参考值超过 10 个百分点时必须说明理由（例如核心主张仍未立住，所以进度低于地图）。只有故事真正推进时进度才上升；
   发现之前高估、主张被推翻时要如实下调。finish 意味着进度接近 100%。
6. 故事优先：不为追求更大的突破而扩散选题；同一贡献版本不重复送审，必须先改进贡献本身。
7. ${evidenceWorkflow
    ? '先核问题、最小验证、独立复核、完整验证和成果审计所需证据。区分已收件、实测和验收。拒绝候选不等于结束研究。无有效新证据且无可交付下一步时选择 wait，不开空转回合。不得从论文进度反推实验完成。'
    : '在途实验要等，就在 next_message 写明并行工作和降级方案。不需要每回合都重新核对同一份原件。'}
8. 决断原则：方向和方案由各模型讨论、相互说服、拿证据后由你决断，出发点是"能写出更好的故事、更容易发文章"；
只输出一个 JSON 对象，无 markdown 围栏。`
  const user = `${boardBlock(session, { rulings: 8 })}

${contextBlock(session, turn)}

【当前 CCF-A 进度】${m?.progress?.percent ?? 0}%（地图参考值 ${mapCompletion(m?.map)}%）
${!evidenceWorkflow && stallCount(session) >= 3 ? `【空转警报】最近连续 ${stallCount(session)} 次判断都"推进：无"。本回合不能再用同样的方式继续：必须换一种做法——
转入写作（把已有证据写成正文段落和图表）、收窄主张到已有证据、换切入点，或给出明确的降级方案并立即执行其中一项。
next_message 必须派出具体任务，不能是等待。\n` : ''}【主持人此前的判断记录】
${asArray(m?.decisions).slice(-6).map((d) => `- ${d.turn}｜${d.decision}｜进度 ${d.progress ?? '–'}%｜推进：${asArray(d.advanced).join('、') || '无'}｜${str(d.reason).slice(0, 160)}`).join('\n') || '（第一次判断）'}

【本回合用户消息】${turn.user}
【本回合结论】
${String(turn.final).slice(0, 4000)}
${stageBlock(session, turn, { current: true })}
${oral ? `【贡献评审】${oral.title}：积极 ${oral.positives}/${oral.planned}，${oral.passed ? '合格' : '未达标'}；主要致命问题：${(oral.topIssues || []).join('；')}` : '【贡献评审】本回合未形成可评审贡献'}
${session.autopilot?.enabled && session.autopilot.objective ? `【当前续航目标】${session.autopilot.objective}
始终推进同一个目标。只有在实际交付和可核验证据满足目标的验收条件时才选择 finish，并在 reason 列出完成依据。need_user 必须给出具体阻塞和所需输入。` : ''}
【已自动续航】${session.autopilot?.cycles || 0} 回合（无上限，由你判断）

输出：
{
  "direction": "主线方向（一两句话，故事的核心主张与切入点；无变化就原样写）",
  "stage": "explore / converge / write / done",
  "map": [ ${STORY_ELEMENTS.map((e) => `{ "element": "${e}", "status": "${ELEMENT_STATES.join('|')}", "note": "≤40 字依据" }`).join(', ')} ],
  "advanced": ["本回合实际推进的环节名"],
  "loop_check": "是否在原地打转、依据是什么、若是你打算怎么换做法",
  "progress": 0-100,
  "progress_reason": "≤80 字：为什么是这个进度（与地图参考值的关系）",
  "blocker": "当前离 CCF-A 最大的卡点（≤40 字）",
  "decision": "continue / converge / finish / need_user${evidenceWorkflow ? ' / wait' : ''}",
  "reason": "≤120 字",
  "next_message": "下一回合给团队的具体指令（continue/converge 时必填，写清要推进哪个环节、交付什么）",
  "template": "${Object.keys(TASK_TEMPLATES).join(' / ')}",
  "needs_user": "need_user 时写清需要用户提供什么"${evidenceWorkflow ? `,
  "evidence_review": {
    "stage": "${EVIDENCE_STAGES.join(' / ')}",
    "disposition": "${EVIDENCE_DISPOSITIONS.join(' / ')}",
    "evidence": ["引用当前会话的产物、任务编号或独立复核。缺件时留空"],
    "next_trigger": "下一步或等待的具体触发，注明由谁提供什么证据"
  }` : ''}
}`
  return { system, user }
}

/* ───────────────────────── 会话存储 ───────────────────────── */

export const sessions = new Map()
let VAULT = null

function sessionsDir(vault) {
  const d = join(vault, 'sessions')
  mkdirSync(d, { recursive: true })
  return d
}

export function persist(session) {
  const dir = join(session.vault, 'sessions', session.id)
  mkdirSync(dir, { recursive: true })
  const { controller, oralController, vault, wake, memoryBusy, ...rest } = session
  store.writeJSON(dir, '.session.json.tmp', { ...rest, materials: (rest.materials || []).map(({ text, ...m }) => m) })
  renameSync(join(dir, '.session.json.tmp'), join(dir, 'session.json'))
  store.writeText(dir, 'transcript.md', renderSessionMd(session))
}

export function ensureShape(s) {
  s.board ||= { version: 0, directives: [], rulings: [] }
  s.autopilot ||= { enabled: false, cycles: 0, failures: 0, note: '' }
  delete s.autopilot.maxCycles
  s.autopilot.state ||= s.autopilot.enabled ? 'active' : 'paused'
  s.autopilot.objective ||= s.autopilot.enabled
    ? s.mission || s.turns?.find((t) => !t.auto)?.user || ''
    : ''
  s.oral ||= []
  ensureMainline(s)
  s.busy ||= {}
  s.pressure ||= {}
  s.events ||= []
  s.turns ||= []
  return s
}

/** 从磁盘恢复历史会话（服务重启后仍能继续追问；材料按路径重新读取）。 */
export function loadSessions(vault) {
  VAULT = vault
  let names = []
  try { names = readdirSync(sessionsDir(vault)) } catch { return }
  for (const name of names) {
    if (sessions.has(name)) continue
    try {
      const s = ensureShape(JSON.parse(readFileSync(join(vault, 'sessions', name, 'session.json'), 'utf8')))
      s.vault = vault
      if (s.status === 'running') s.status = 'interrupted'
      s.busy = {}
      s.oralRunning = false
      s.memoryBusy = false
      s.materials = loadMaterials((s.materials || []).map((m) => m.path))
      sessions.set(s.id, s)
    } catch { /* 损坏的会话跳过 */ }
  }
}

const continuationTimers = new WeakMap()

function clearContinuation(s) {
  clearTimeout(continuationTimers.get(s))
  continuationTimers.delete(s)
  delete s.autopilot.retryAt
}

function scheduleContinuation(s, cfg, delay = 0) {
  clearContinuation(s)
  const ap = s.autopilot
  ap.retryAt = new Date(Date.now() + delay).toISOString()
  persist(s)
  const timer = setTimeout(async () => {
    if (continuationTimers.get(s) !== timer) return
    continuationTimers.delete(s)
    if (s.status === 'running') return
    const turn = s.turns.at(-1)
    if (s.status === 'interrupted' && turn && !turn.finishedAt) {
      s.status = 'idle'
      try {
        event(s, `↻ 恢复中断的 ${turn.id}，保留已落盘的任务和交付`)
        sendMessage(s, turn.user, cfg, { ...s.lastOpts, template: turn.template, auto: true, resumeTurn: turn })
      } catch (err) {
        s.status = 'interrupted'
        retryContinuation(s, cfg, err.message)
      }
      return
    }
    if (s.status === 'interrupted') s.status = 'idle'
    if (!ap.enabled && !s.pending && s.phase !== 'next' && s.phase !== 'memory') return
    if (!turn || ap.startGoal) {
      if (!ap.objective) {
        ap.state = 'waiting'
        ap.note = '等待首条消息或续航目标'
        clearContinuation(s)
        persist(s)
        return
      }
      try { sendMessage(s, ap.objective, cfg, { ...s.lastOpts, auto: true }) }
      catch (err) { retryContinuation(s, cfg, err.message) }
      return
    }
    await finishTurn(s, cfg, turn)
  }, delay)
  continuationTimers.set(s, timer)
}

export function resumeInterrupted(cfg) {
  let delay = 0
  for (const s of sessions.values()) {
    if (s.autopilot.state === 'blocked' && !s.autopilot.enabled && !s.pending) continue
    if (s.workflow === 'evidence' && s.status === 'idle' && s.autopilot.state === 'waiting' && !s.pending) continue
    if (s.status !== 'interrupted' && !s.autopilot.enabled && !s.pending && !['memory', 'next'].includes(s.phase)) continue
    const due = Date.parse(s.autopilot.retryAt || '')
    scheduleContinuation(s, cfg, Math.max(delay += 300, Number.isFinite(due) ? due - Date.now() : 0))
  }
}

export function listSessions() {
  return [...sessions.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((s) => ({
      id: s.id, title: s.title, projectId: s.projectId || null, status: s.status, updatedAt: s.updatedAt,
      turns: (s.turns || []).length, venue: resolveVenueName(s.context?.venue),
      autopilot: Boolean(s.autopilot?.enabled), goalState: s.autopilot?.state, oralRunning: Boolean(s.oralRunning),
      progress: s.mainline?.progress?.percent ?? 0, stage: STAGES[s.mainline?.stage] || '',
    }))
}

export function publicSession(s) {
  const { controller, oralController, vault, wake, memoryBusy, ...rest } = s
  return { ...rest, materials: (rest.materials || []).map(({ text, ...m }) => m), handbook: { builtAt: handbook.builtAt } }
}

export function createSession({ vault, title, context, materialPaths, mission, projectId = null, workflow = 'standard' }) {
  VAULT = vault
  const now = new Date()
  const id = `S-${store.makeRunId('', now).slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`
  const session = ensureShape({
    id, projectId, workflow, title: String(title || '未命名会话').slice(0, 80), createdAt: now.toISOString(), updatedAt: now.toISOString(),
    status: 'idle', phase: 'idle', context: context || {}, materials: loadMaterials(materialPaths || []),
    turns: [], events: [], vault, controller: null,
    mission: String(mission || '').trim(),
  })
  sessions.set(id, session)
  persist(session)
  return session
}

export function event(session, line) {
  session.events.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (session.events.length > 500) session.events.splice(0, session.events.length - 500)
}

/* ───────────────────────── 调用封装 ───────────────────────── */

export function makeAsk(session, cfg, signal, turn, mockCtx = () => ({})) {
  return async function ask(lane, tag, prompt, { maxTokens = 3000, temperature = 0.5, reasoning = 'low', quiet = false, raw = false } = {}) {
    if (signal?.aborted) throw new Error('cancelled')
    if (!quiet) event(session, `→ ${tag}/${lane}`)
    session.busy[lane] = [...(session.busy[lane] || []), tag]
    const t0 = Date.now()
    try {
      const res = MOCK
        ? { text: mockText(tag, lane, { controller: controllerLane(cfg), workers: enabledLanes(cfg).filter(k => k !== controllerLane(cfg)), evidenceWorkflow: session.workflow === 'evidence', ...mockCtx() }), model: `${lane}-mock`, ms: 2, usage: process.env.FOUNDRY_MOCK_BIG ? { input: 250_000, output: 10 } : null, stopReason: tag.startsWith('task') && !tag.includes('续写') && !tag.includes('补写') ? 'max_tokens' : 'end_turn' }
        : await callLane(lane, cfg, { system: prompt.system, user: prompt.user, maxTokens, temperature, reasoning }, { signal })
      turn?.calls.push({ tag, lane, model: res.model, ms: res.ms, usage: res.usage, ok: true, stopReason: res.stopReason })
      if (!quiet) event(session, `✓ ${tag}/${lane} ${Math.round((res.ms || 0) / 1000)}s`)
      trackPressure(session, cfg, lane, res, prompt)
      return raw ? res : res.text
    } catch (err) {
      const msg = String(err?.message || err)
      turn?.calls.push({ tag, lane, ms: Date.now() - t0, ok: false, error: msg })
      event(session, `✗ ${tag}/${lane}: ${msg}`)
      if (signal?.aborted) throw err
      return null
    } finally {
      const list = session.busy[lane] || []
      const i = list.indexOf(tag)
      if (i >= 0) list.splice(i, 1)
      if (!list.length) delete session.busy[lane]
    }
  }
}

/** 记录本会话每条线路的提示词规模，逼近预算时标记需要整理记忆。 */
function trackPressure(session, cfg, lane, res, prompt) {
  const tokens = res.usage?.input || Math.round((String(prompt.system || '').length + String(prompt.user || '').length) / 1.6)
  const window = laneWindow(lane)
  const { triggerRatio, softTokens } = memoryCfg(cfg)
  const budget = Math.min(window * triggerRatio, softTokens)
  session.pressure ||= {}
  session.pressure[lane] = { tokens, window, budget, ratio: Math.round((tokens / budget) * 1000) / 1000, estimated: !res.usage?.input, at: new Date().toISOString() }
  if (tokens >= budget && !session.memoryDue) {
    session.memoryDue = `${laneName(lane)} 提示词 ${Math.round(tokens / 1000)}K，达到记忆预算 ${Math.round(budget / 1000)}K`
    event(session, `⚠ ${session.memoryDue}，本回合结束后整理记忆到 Obsidian`)
  }
}

const TRUNCATED = new Set(['max_tokens', 'length'])
const REQUIRED_SECTIONS = ['结论', '交付内容', '阶段反馈']
const missingSections = (text) => REQUIRED_SECTIONS.filter((h) => !new RegExp(`^#{1,3}\\s*${h}`, 'm').test(String(text)))

/** 执行者的完整执行：输出被截断就续写（≤2 次），缺必需小节就补写，保证汇报完整、带阶段反馈。 */
async function askComplete(session, ask, lane, tag, prompt, opts) {
  let res = await ask(lane, tag, prompt, { ...opts, raw: true })

  if (!res) return null
  let text = res.text
  for (let i = 1; i <= 2 && TRUNCATED.has(res.stopReason); i += 1) {
    event(session, `… ${tag}/${lane} 输出被截断，续写第 ${i} 次`)
    res = await ask(lane, `${tag} 续写${i}`, {
      system: prompt.system,
      user: `${prompt.user}\n\n【你上一条输出在下面这里被截断了。从断点直接接着写，不要重复已写内容，写完所有小节】\n……${text.slice(-3000)}`,
    }, { ...opts, raw: true })
    if (!res) break
    text += res.text
  }
  const miss = missingSections(text)
  if (miss.length) {
    event(session, `… ${tag}/${lane} 缺少小节：${miss.join('、')}，要求补写`)
    const fix = await ask(lane, `${tag} 补写`, {
      system: prompt.system,
      user: `${prompt.user}\n\n【你已经提交的汇报】\n${text.slice(-6000)}\n\n【缺少以下必需小节，只补写这些小节（用 ## 标题），基于你已完成的工作如实填写】\n${miss.map((m) => `## ${m}`).join('\n')}`,
    }, { ...opts, maxTokens: 1500, raw: true })
    if (fix?.text) text += `\n\n${fix.text}`
  }
  return text
}

function sectionOf(text, name) {
  const m = String(text).match(new RegExp(`^#{1,3}\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, 'm'))
  return m ? m[1].trim() : ''
}

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k) }
  }))
  return out
}

/* ───────────────────────── 主流程 ───────────────────────── */

/** A valid task map is an explicit assignment, including empty/omitted lanes.
 * Only a missing or malformed map retains the original user-task fallback. */
export function initialPlanDispatch(plan, workers, user, limit) {
  const taskMap = plan?.tasks
  const explicit = taskMap !== null && typeof taskMap === 'object' && !Array.isArray(taskMap)
    && Object.values(taskMap).every(Array.isArray)
  const assignments = workers.flatMap(worker => {
    const specs = explicit ? (taskMap[worker] || []) : [{ task: user }]
    return specs.slice(0, limit).map(spec => ({ worker, spec }))
  })
  const explicitEmpty = explicit && Object.values(taskMap).every(specs => specs.length === 0)
  return { assignments, explicitEmpty }
}

/**
 * 在会话里追加一条消息并跑完一个回合（异步，不阻塞调用方）。
 * opts: { template, maxSteps, maxRevise, cross, workers, oral, autopilot, auto }
 */
export function sendMessage(session, text, cfg, opts = {}) {
  ensureShape(session)
  if (session.status === 'running') throw new Error('上一个回合还在进行中')
  const commander = controllerLane(cfg)
  const workers = workerLanes(cfg, opts.workers)

  const maxSteps = Math.max(1, Math.min(6, Number(opts.maxSteps ?? opts.maxRounds) || 3))
  const maxRevise = Math.max(0, Math.min(2, Number(opts.maxRevise ?? 1)))
  const doCross = opts.cross !== false && workers.length > 1
  const doOral = opts.oral !== false
  session.lastOpts = { template: opts.template, maxSteps, maxRevise, cross: doCross, workers, oral: doOral, debate: opts.debate }
  const ap = session.autopilot
  clearContinuation(session)
  delete ap.startGoal
  if (opts.autopilot !== undefined) ap.enabled = Boolean(opts.autopilot)
  if (ap.enabled) {
    ap.objective ||= session.mission || String(text)
    ap.state = 'active'
    if (!opts.auto || opts.advanceGoal) ap.failures = 0
    if (opts.advanceGoal) ap.cycles += 1
  } else if (ap.state === 'waiting') ap.state = 'paused'

  const turn = opts.resumeTurn || {
    id: `T${(session.turns.length + 1)}`, user: String(text), template: opts.template || 'free', auto: Boolean(opts.auto),
    startedAt: new Date().toISOString(), finishedAt: null,
    plan: null, tasks: [], final: '', contribution: null, oralId: null, next: null, error: null, entries: [], calls: [],
    ledger: [], carryOver: [], disputes: [],
  }

  if (!opts.resumeTurn) session.turns.push(turn)
  else for (const task of turn.tasks) {
    if (task.status === 'running') task.status = 'queued'
    if (task.status === 'judging') task.status = 'reported'
    task.crossing = []
  }
  session.status = 'running'
  session.updatedAt = new Date().toISOString()
  session.controller = new AbortController()
  const signal = session.controller.signal
  persist(session)

  const label = (lane) => cfg.lanes?.[lane]?.label || lane
  const entry = (e) => {
    turn.entries.push({ ts: new Date().toISOString(), ...e })
    session.updatedAt = new Date().toISOString()
    persist(session)
  }
  const phase = (p, msg) => { session.phase = p; event(session, `▸ ${p}: ${msg}`) }
  const ask = makeAsk(session, cfg, signal, turn, () => ({ workers, tasks: turn.tasks }))

  let taskSeq = turn.tasks.length
  const newTask = (worker, spec, extra = {}) => {
    const t = {
      id: `${turn.id}.${(taskSeq += 1)}`, worker, task: str(spec?.task, turn.user), deliverable: str(spec?.deliverable),
      acceptance: str(spec?.acceptance), skills: asArray(spec?.skills).map(String).slice(0, 2),
      attempt: 1, status: 'queued', report: '', crosses: {}, ruling: null, createdAt: new Date().toISOString(), ...extra,
    }
    turn.tasks.push(t)
    return t
  }

  // 事件驱动：任何状态变化都唤醒等待中的循环
  let waiters = []
  const notify = () => { const w = waiters; waiters = []; for (const r of w) r() }
  const wait = () => new Promise((r) => waiters.push(r))
  signal.addEventListener('abort', notify, { once: true })
  session.wake = notify

  void (async () => {
    let cancelled = false
    let oralResult = null
    try {
      if (syncMemoryFromObsidian(session)) event(session, '· 检测到你在 Obsidian 里改过关键记忆，已按 Obsidian 版本更新')
      /* 0. 经验手册 */
      phase('knowledge', '总控读取经验手册')
      try {
        const d = await getDigest(cfg, { signal, onProgress: (m) => event(session, `  📖 ${m}`) })
        handbook = { text: d.text, builtAt: d.builtAt }
        if (d.justBuilt) entry({ lane: commander, role: `${label(commander)} · 读完经验库`, kind: 'knowledge', round: 0, text: `已处理显式授权知识源与 ${d.skills} 个 skill（精读 ${asArray(d.deepSkills).length} 个），整理为《执行判断手册》，所有 Agent 共享。\n\n${d.text}` })
      } catch (err) {
        if (signal.aborted) throw err
        event(session, `⚠ 经验手册不可用：${err.message}（继续，不中断）`)
      }

      /* 1. 派活 */
      let plan = turn.plan
      if (!plan) {
        phase('plan', '总控理解问题并派活')
        const planText = await ask(commander, 'plan', planPrompt(session, turn, workers, Math.min(2, maxSteps), cfg), { maxTokens: 3000, temperature: 0.3 })
        plan = parseJSON(planText) || {
          understanding: '（总控派活失败，执行者直接处理原问题）',
          tasks: Object.fromEntries(workers.map((w) => [w, [{ task: turn.user }]])),
          _fallback: true,
        }
        turn.plan = plan
        if (asArray(plan.directives).length) setDirectives(session, plan.directives)
        const dispatch = initialPlanDispatch(plan, workers, turn.user, Math.min(2, maxSteps))
        for (const { worker, spec } of dispatch.assignments) newTask(worker, spec)
        if (dispatch.explicitEmpty) {
          turn.noWorkerTasks = true
          event(session, '· 主持人明确空任务：不派执行者、不重试旧任务，仅记录本回合与主线判断；不改变其他会话或后台任务')
        }
        entry({ lane: commander, role: `${label(commander)} · 总控派活`, kind: 'plan', round: 0, text: renderPlan(plan, turn.tasks, session.board) })
      }
      const explicitEmpty = Boolean(turn.noWorkerTasks)

      /* 2. 流水线：执行者循环 + 总控裁决循环 */
      phase('pipeline', '执行者流水线作业，总控随到随裁')
      let pipelineDone = Boolean(turn.final)
      const failures = Object.fromEntries(workers.map((w) => [w, 0]))
      const dead = new Set()
      const steps = (w) => turn.tasks.filter((t) => t.worker === w && t.attempt === 1).length
      const alive = () => workers.filter((w) => !dead.has(w))
      const doing = (w) => turn.tasks.filter((t) => t.worker !== w && t.status === 'running').map((t) => `${t.worker}：${t.task.slice(0, 60)}`).join('；')

      async function workerLoop(w) {
        while (!pipelineDone && !signal.aborted && !dead.has(w)) {
          const task = turn.tasks.find((t) => t.worker === w && t.status === 'queued')
          if (task) {
            task.status = 'running'
            task.startedAt = new Date().toISOString()
            persist(session)
            notify()
            const text = await askComplete(session, ask, w, `task ${task.id}`, workerPrompt(session, turn, task, doing(w)), { maxTokens: 4000, temperature: 0.6, reasoning: 'medium' })
            if (text) {
              failures[w] = 0
              task.status = 'reported'
              task.report = text
              task.stage = sectionOf(text, '阶段反馈')
              task.reportedAt = new Date().toISOString()
              entry({ lane: w, role: `${label(w)} · 汇报 ${task.id}${task.attempt > 1 ? `（第${task.attempt}版）` : ''}`, kind: 'report', round: task.attempt, taskId: task.id, text })
            } else {
              task.status = 'failed'
              failures[w] += 1
              const other = alive().find((x) => x !== w)
              if (failures[w] >= 2) { dead.add(w); event(session, `⚠ ${w} 连续失败，暂停其本回合任务`) }
              if (other && !task.failedOver) {
                const moved = newTask(other, task, { attempt: task.attempt, feedback: task.feedback, previous: task.previous, failedOver: true })
                event(session, `↪ ${task.id} 转交 ${other}（新编号 ${moved.id}）`)
              } else if (!dead.has(w)) {
                task.status = 'queued' // 同一执行者再试一次
                task.failedOver = true
              }
              if (dead.has(w)) {
                for (const t of turn.tasks.filter((x) => x.worker === w && x.status === 'queued')) {
                  t.status = 'failed'
                  if (other) newTask(other, t, { attempt: t.attempt, feedback: t.feedback, previous: t.previous, failedOver: true })
                }
              }
            }
            notify()
            continue
          }
          // 空闲：互审对方最新且未互审过的汇报
          const target = doCross && turn.tasks.find((t) => t.worker !== w && t.report && !t.superseded && !(w in t.crosses) && !t.crossing?.includes(w))
          if (target) {
            target.crossing = [...(target.crossing || []), w]
            const text = await ask(w, `cross ${target.id}`, crossPrompt(session, w, target), { maxTokens: 1400, temperature: 0.4 })
            target.crosses[w] = text || '（互审失败）'
            if (text) {
              entry({ lane: w, role: `${label(w)} · 空闲互审 ${target.id}`, kind: 'cross', round: target.attempt, taskId: target.id, text })
              if (target.status === 'judged') target.lateCross = [...(target.lateCross || []), w]
            }
            notify()
            continue
          }
          await wait()
        }
      }

      async function commanderLoop() {
        while (!pipelineDone && !signal.aborted) {
          const batch = turn.tasks.filter((t) => t.status === 'reported')
          if (batch.length) {
            for (const t of batch) t.status = 'judging'
            const late = turn.tasks.flatMap((t) => (t.lateCross || []).map((by) => ({ by, taskId: t.id, text: t.crosses[by] })))
            for (const t of turn.tasks) t.lateCross = []
            const budget = {
              maxRevise,
              left: Object.fromEntries(alive().map((w) => [w, Math.max(0, maxSteps - steps(w))])),
              status: workers.map((w) => `${w}：${dead.has(w) ? '已停' : turn.tasks.filter((t) => t.worker === w && ['queued', 'running'].includes(t.status)).map((t) => `${t.id}${t.status === 'running' ? '进行中' : '排队'}`).join(',') || '空闲'}`).join('；'),
            }
            let judged = parseJSON(await ask(commander, `judge ${batch.map((t) => t.id).join(',')}`, judgePrompt(session, turn, plan, batch, late, budget), { maxTokens: 3200, temperature: 0.2 }))
            if (!judged && !signal.aborted) {
              event(session, '⚠ 裁决失败，10 秒后重试一次')
              await new Promise((r) => setTimeout(r, MOCK ? 10 : 10_000))
              judged = parseJSON(await ask(commander, `judge-retry ${batch.map((t) => t.id).join(',')}`, judgePrompt(session, turn, plan, batch, late, budget), { maxTokens: 3200, temperature: 0.2 }))
            }
            if (asArray(judged?.directives).length) setDirectives(session, judged.directives)
            const conflicts = asArray(judged?.conflicts)
            for (const c of conflicts) {
              if (c?.debate !== true || !c.sides || typeof c.sides !== 'object') continue
              const sides = Object.fromEntries(Object.entries(c.sides).map(([k, v]) => [String(k), str(v)]).filter(([k]) => [commander, ...workers].includes(k)))
              if (Object.keys(sides).length >= 2 && turn.disputes.length < DEBATE_MAX_PER_TURN) turn.disputes.push({ issue: str(c.issue), ruling: str(c.ruling), why: str(c.why), sides })
            }
            for (const t of batch) {
              const r = asArray(judged?.rulings).find((x) => str(x?.task_id) === t.id) || { verdict: 'accept', note: judged ? '（总控未单独裁决此任务）' : '（裁决失败，默认通过，不中断）' }
              t.ruling = r
              t.status = 'judged'
              session.board.rulings.push({
                turn: turn.id, taskId: t.id, worker: t.worker, score: r.score, storyScore: r.story_score ?? null, verdict: r.verdict,
                accepted: asArray(r.accepted), rejected: asArray(r.rejected), note: str(r.note), ts: new Date().toISOString(),
              })
              if (session.board.rulings.length > 60) session.board.rulings.splice(0, session.board.rulings.length - 60)
              turn.ledger.push({ taskId: t.id, worker: t.worker, task: t.task, status: r.verdict === 'revise' ? '打回' : '已完成', score: r.score ?? null, stage: t.stage || '', carry: asArray(r.carry_over).map(str) })
              for (const c of asArray(r.carry_over)) if (str(c).trim()) turn.carryOver.push(`[${t.id}] ${str(c)}`)
              const w = alive().includes(t.worker) ? t.worker : alive()[0]
              if (r.verdict === 'revise' && t.attempt <= maxRevise && w) {
                t.superseded = true
                newTask(w, t, { attempt: t.attempt + 1, feedback: str(r.revise_instruction, '按裁决补强'), previous: t.report, parent: t.id })
              } else if (r.next_task && w && steps(w) < maxSteps) {
                newTask(w, r.next_task, { parent: t.id })
              }
            }
            entry({ lane: commander, role: `${label(commander)} · 裁决 ${batch.map((t) => t.id).join(' ')}`, kind: 'judge', round: 0, text: renderJudge(batch, conflicts, session.board, turn.tasks), json: judged })
            notify()
            continue
          }
          const active = turn.tasks.some((t) => ['queued', 'running', 'judging'].includes(t.status))
          if (!active) break
          await wait()
        }
      }

      const loops = workers.map((w) => workerLoop(w))
      await commanderLoop()
      pipelineDone = true
      notify()
      await Promise.all(loops)
      if (signal.aborted) throw new Error('cancelled')
      for (const t of turn.tasks.filter((x) => x.status === 'failed' && !turn.ledger.some((item) => item.taskId === x.id) && !turn.tasks.some((y) => y.failedOver && y.task === x.task && y.report))) {
        turn.ledger.push({ taskId: t.id, worker: t.worker, task: t.task, status: '执行失败', score: null, stage: '', carry: [] })
        turn.carryOver.push(`[${t.id}] 执行失败未完成：${t.task.slice(0, 120)}`)
      }
      if (!explicitEmpty && !turn.tasks.some((t) => t.report)) throw new Error('所有执行者都失败了，无法继续')

      /* 2.5 分歧说服 */
      if (!turn.final && !turn.debateFinished && turn.disputes.length && opts.debate !== false) {
        phase('debate', `分歧说服（${turn.disputes.length} 个）`)
        await runDebates(session, cfg, turn, ask, entry, label, workers, Math.max(1, Math.min(3, Number(opts.debateRounds) || 2)))
        turn.debateFinished = true
        persist(session)
        if (signal.aborted) throw new Error('cancelled')
      }

      /* 3. 综合答复 */
      if (!turn.final) {
        phase('final', '总控撰写综合答复')
        const finalText = await ask(commander, 'final', finalPrompt(session, turn, plan, turn.tasks), { maxTokens: 4000, temperature: 0.4 })
        turn.final = finalText || (explicitEmpty
          ? `## 结论\n主持人明确未分配执行任务，本回合没有执行者调用。综合答复未返回，未作新的科研裁决。\n\n${str(plan.understanding)}`
          : fallbackFinal(turn.tasks))
        entry({ lane: commander, role: `${label(commander)} · 综合答复`, kind: 'final', round: 0, text: turn.final })
      }

      /* 4. 贡献评审（配置的模型与轮数） */
      if (doOral && !explicitEmpty && !turn.oralId) {
        phase('oral', '抽取贡献并按配置进行模型评审')
        const c = turn.contribution || parseJSON(await ask(commander, 'extract', extractPrompt(session, turn), { maxTokens: 2000, temperature: 0.2 }))
        if (c?.has_contribution) {
          turn.contribution = c
          oralResult = session.oral.find((o) => o.turnId === turn.id && o.finishedAt) || await runOralPanel(session, cfg, contributionText(c), { title: str(c.title), turnId: turn.id, signal })
          turn.oralId = oralResult.id
          entry({ lane: commander, role: '贡献评审', kind: 'oral', round: 0, text: renderOral(oralResult) })
        } else {
          event(session, `· 本回合没有形成可评审贡献：${str(c?.why_not, '—')}`)
        }
      }

      event(session, '✓ 回合交付已记录')
    } catch (err) {
      if (signal.aborted) { cancelled = true; turn.error = '已停止'; event(session, '■ 已停止') } else {
        turn.error = String(err?.message || err)
        event(session, `✗ 失败: ${turn.error}`)
      }
    } finally {
      turn.finishedAt = new Date().toISOString()
      session.phase = cancelled ? 'idle' : 'next'
      session.wake = null
      session.updatedAt = new Date().toISOString()
      persist(session)
    }
    await finishTurn(session, cfg, turn, { cancelled, signal, oralResult })
  })()
  return turn
}

async function finishTurn(session, cfg, turn, { cancelled = false, signal, oralResult } = {}) {
  session.status = 'running'
  if (!session.controller) session.controller = new AbortController()
  signal ||= session.controller.signal
  let rec = turn.next
  let failure
  try {
    if (!cancelled && !turn.error && !rec) {
      if (!turn.stageFeedbackSaved) {
        try { writeStageFeedback(session, cfg, turn) }
        catch (err) { event(session, `⚠ 阶段反馈写入失败：${err.message}`) }
        turn.stageFeedbackSaved = true
      }
      const finished = session.turns.filter((t) => t.final).length
      if (session.memoryDue || finished - (session.memory?.coveredTurns || 0) > HISTORY_KEEP - 1) {
        await consolidateMemory(session, cfg, session.memoryDue || `有回合即将滑出提示词历史（已完成 ${finished} 回合）`, signal)
      }
      if (!signal.aborted) rec = await reviewMainline(session, cfg, turn,
        oralResult || session.oral?.find((o) => o.id === turn.oralId) || null, signal)
    }
  } catch (err) {
    if (!signal.aborted) failure = err.message
  } finally {
    session.status = 'idle'
    session.phase = 'idle'
    session.controller = null
    session.updatedAt = new Date().toISOString()
    persist(session)
  }
  if (session.pending) {
    const p = session.pending
    delete session.pending
    try { sendMessage(session, p.text, cfg, { ...session.lastOpts, ...p.opts }); return }
    catch (err) {
      session.pending = p
      if (session.autopilot.enabled) retryContinuation(session, cfg, err.message)
      else { event(session, `✗ 排队指令发送失败：${err.message}`); persist(session) }
      return
    }
  }
  if (cancelled || signal.aborted || !session.autopilot.enabled) return
  if (failure) retryContinuation(session, cfg, failure)
  else await autopilotNext(session, cfg, turn, rec)
}

function normalizeEvidenceReview(review, decision) {
  const evidence = asArray(review?.evidence).filter((x) => typeof x === 'string')
    .map((x) => x.trim().slice(0, 500)).filter(Boolean).slice(0, 8)
  const nextTrigger = str(review?.next_trigger).trim().slice(0, 1000)
  const stage = EVIDENCE_STAGES.includes(review?.stage) ? review.stage : null
  const disposition = EVIDENCE_DISPOSITIONS.includes(review?.disposition) ? review.disposition : 'wait'
  if (!stage || !nextTrigger || (!evidence.length && disposition !== 'wait')) {
    return { stage, disposition: 'wait', evidence, nextTrigger: '等待带有证据及下一步的可核验阶段判断。' }
  }
  return { stage, disposition: decision === 'wait' ? 'wait' : disposition, evidence, nextTrigger }
}

/** 主持人主线判断：每回合结束都做（不论是否开启自动续航），更新完整度地图与主线方向。 */
async function reviewMainline(session, cfg, turn, oral, signal) {
  const m = ensureMainline(session)
  session.phase = 'next'
  persist(session)
  const ask = makeAsk(session, cfg, signal, turn)
  let d = parseJSON(await ask(controllerLane(cfg), 'mainline', nextPrompt(session, turn, oral), { maxTokens: 3000, temperature: 0.3 }))
  if (!d) d = parseJSON(await ask(controllerLane(cfg), 'mainline-retry', nextPrompt(session, turn, oral), { maxTokens: 3000, temperature: 0.3 }))
  const evidenceWorkflow = session.workflow === 'evidence'
  const decisions = ['continue', 'converge', 'finish', 'need_user', ...(evidenceWorkflow ? ['wait'] : [])]
  if (!decisions.includes(d?.decision)) d = null
  if (!d) { event(session, '⚠ 主持人主线判断失败'); persist(session); return null }
  if (str(d.direction).trim()) m.direction = str(d.direction).trim()
  if (STAGES[d.stage]) m.stage = d.stage
  for (const x of asArray(d.map)) {
    const item = m.map.find((y) => y.element === str(x?.element))
    if (item && ELEMENT_STATES.includes(str(x.status))) { item.status = str(x.status); item.note = str(x.note).slice(0, 120) }
  }
  const evidenceReview = evidenceWorkflow ? normalizeEvidenceReview(d.evidence_review, d.decision) : null
  let decision = d.decision
  if (evidenceReview?.disposition === 'wait' && decision !== 'need_user') decision = 'wait'
  if (evidenceReview?.disposition === 'reject_candidate' && decision === 'finish') decision = 'wait'
  const ref = mapCompletion(m.map)
  const pct = Number.isFinite(Number(d.progress)) ? Math.max(0, Math.min(100, Math.round(Number(d.progress)))) : ref
  const prevPct = m.progress.percent
  m.progress = {
    percent: pct, mapRef: ref, reason: str(d.progress_reason), blocker: str(d.blocker), at: new Date().toISOString(),
    history: [...asArray(m.progress.history), { turn: turn.id, percent: pct, mapRef: ref, reason: str(d.progress_reason || d.reason), blocker: str(d.blocker), at: new Date().toISOString() }].slice(-100),
  }
  if (decision === 'finish' && !session.autopilot.objective) m.stage = 'done'
  if (decision === 'converge' && m.stage === 'explore') m.stage = 'converge'
  const rec = {
    turn: turn.id, at: new Date().toISOString(), decision, stage: m.stage, advanced: asArray(d.advanced).map(str),
    progress: pct, progressDelta: pct - (prevPct || 0), mapRef: ref, progressReason: str(d.progress_reason), blocker: str(d.blocker),
    loopCheck: str(d.loop_check), reason: str(d.reason), next: str(d.next_message), needsUser: str(d.needs_user),
    template: TASK_TEMPLATES[d.template] ? d.template : 'free',
    ...(evidenceReview ? { evidenceReview } : {}),
  }
  m.decisions.push(rec)
  if (m.decisions.length > 100) m.decisions.splice(0, m.decisions.length - 100)
  turn.next = rec
  const label = { continue: '继续', converge: '收敛', finish: '完成', need_user: '需要你', wait: '等待证据' }[decision]
  event(session, `◆ 主持人：${label}｜CCF-A 进度 ${pct}%（${rec.progressDelta >= 0 ? '+' : ''}${rec.progressDelta}）｜推进 ${rec.advanced.join('、') || '无'}｜${rec.reason.slice(0, 80)}`)
  persist(session)
  return rec
}

/** 空转检测：最近连续多少次主线判断都"推进：无"。 */
export function stallCount(session) {
  let n = 0
  for (const d of [...asArray(session.mainline?.decisions)].reverse()) {
    if (asArray(d.advanced).length) break
    n += 1
  }
  return n
}

function retryContinuation(session, cfg, reason) {
  const ap = session.autopilot
  ap.failures = (ap.failures || 0) + 1
  if (ap.failures >= 4) {
    ap.state = 'blocked'
    ap.enabled = false
    ap.note = `重试后仍未恢复：${reason}`
    clearContinuation(session)
    event(session, `■ ${ap.note}`)
    persist(session)
    return
  }
  const delay = MOCK ? 30 : 30_000 * 2 ** (ap.failures - 1)
  ap.state = 'retrying'
  ap.note = `${reason}。将在 ${new Date(Date.now() + delay).toLocaleString('zh-CN')} 重试（${ap.failures}/3）`
  event(session, `↻ ${ap.note}`)
  scheduleContinuation(session, cfg, delay)
}

async function autopilotNext(session, cfg, turn, rec) {
  const ap = session.autopilot
  if (turn.error) {
    if (ap.state !== 'retrying') { retryContinuation(session, cfg, turn.error); return }
    try { sendMessage(session, turn.user, cfg, { ...session.lastOpts, template: turn.template, auto: true }) }
    catch (err) { retryContinuation(session, cfg, err.message) }
    return
  }
  if (!rec || (rec.decision === 'finish' && !rec.reason.trim())) {
    if (rec) turn.next = null
    retryContinuation(session, cfg, '主持人未返回可用的主线判断')
    return
  }
  if (session.workflow === 'evidence' &&
    (rec.decision === 'wait' || (['continue', 'converge'].includes(rec.decision) && !rec.next.trim()))) {
    ap.state = 'waiting'
    ap.note = rec.evidenceReview?.nextTrigger || '等待下一条可核验证据。'
    clearContinuation(session)
    event(session, `■ 等待证据：${ap.note}`)
    persist(session)
    return
  }
  // 继续/收敛却没写下一步：不停摆，按完整度地图里最弱的环节自动补一条下一回合指令
  if (['continue', 'converge'].includes(rec.decision) && !rec.next.trim()) {
    const weak = asArray(session.mainline?.map).filter((x) => !['有证据', '已定稿'].includes(x.status)).map((x) => x.element)
    rec.next = `接续上一回合（主持人判断为${rec.decision === 'converge' ? '收敛' : '继续'}但未写下一步）：读上一回合阶段反馈与遗留事项，优先推进${weak.length ? `尚未完成的环节：${weak.slice(0, 3).join('、')}` : '遗留事项'}；需要证据时，列出可核验的实验建议。`
    event(session, '· 主持人未写下一步，已按完整度地图自动补全')
  }
  const WAIT_ONLY = /WAIT_FOR_REAL_EVIDENCE|tasks\s*=\s*\{\s*\}|不派执行者|不开回合|不起轮|只在.{0,20}触发器.{0,20}(到达|开|起)/i
  if (session.workflow !== 'evidence' && ['continue', 'converge'].includes(rec.decision) && WAIT_ONLY.test(rec.next) && stallCount(session) >= 2) {
    const weak = asArray(session.mainline?.map).filter((x) => !['有证据', '已定稿'].includes(x.status)).map((x) => x.element)
    event(session, `⟳ 空转 ${stallCount(session)} 回合且主持人仍要求纯等待，已改为并行推进不依赖在途实验的工作`)
    rec.next = `【空转打断｜系统按用户"禁止纯等待"规则改写本回合】在途实验照常运行、照常等待，但本回合必须并行推进不依赖它的工作：
1. 把已经有证据的内容写成论文正文（中英双份，遵守写作规范），交给总控合稿；优先处理：${weak.slice(0, 3).join('、') || '论文初稿各节'}。
2. 为在途实验的结果预先写好两版结果段与图表（结果支持 / 结果不支持），实验一出数就能直接填入。
3. 写明截止前仍拿不到结果时的降级主张，以及它在论文里的写法。
原来等待的触发条件保留在常设指令里，到达后照常处理。`
    rec.decision = 'converge'
  }
  if (rec.decision === 'need_user' && !rec.needsUser.trim() && !rec.reason.trim()) {
    rec.decision = 'converge'
    const weak = asArray(session.mainline?.map).filter((x) => !['有证据', '已定稿'].includes(x.status)).map((x) => x.element)
    rec.next = rec.next.trim() || `接续上一回合：主持人未说明需要用户什么，按完整度地图推进尚未完成的环节：${weak.slice(0, 3).join('、') || '遗留事项'}。`
    event(session, '· 主持人给出空的"需要你"，已改为自行推进')
  }
  if (rec.decision === 'finish' || rec.decision === 'need_user' || !rec.next.trim()) {
    ap.enabled = false
    ap.state = rec.decision === 'finish' ? 'complete' : 'blocked'
    clearContinuation(session)
    ap.note = rec.decision === 'finish'
      ? `主持人判断目标已完成：${rec.reason}`
      : `主持人暂停：${rec.reason}${rec.needsUser ? `｜需要你：${rec.needsUser}` : ''}`
    event(session, `■ ${ap.note}`)
    persist(session)
    return
  }
  ap.note = `第 ${ap.cycles + 1} 次续航（${rec.decision === 'converge' ? '收敛' : '继续'}）：${rec.reason}`
  event(session, `↻ ${ap.note}`)
  if (!ap.enabled) return
  try {
    sendMessage(session, `[自动] ${rec.next}`, cfg, { ...(session.lastOpts || {}), template: rec.template, auto: true, advanceGoal: true })
  } catch (err) { retryContinuation(session, cfg, err.message) }
}

export function setDirectives(session, list) {
  // 指令膨胀治理：每条 ≤ 260 字、最多 8 条
  let next = asArray(list).map((x) => str(x).trim()).filter(Boolean)
  const long = next.filter((x) => x.length > 260).length
  next = next.slice(0, 8).map((x) => (x.length > 260 ? `${x.slice(0, 257)}…` : x))
  if (long) event(session, `✂ 常设指令有 ${long} 条超过 260 字，已截断（指令应是规则，不是流程记录）`)
  if (!next.length) return
  if (JSON.stringify(next) === JSON.stringify(session.board.directives)) return
  session.board.directives = next
  session.board.version = (session.board.version || 0) + 1
}

export function cancelSession(session) {
  if (!session) return false
  setAutopilot(session, { enabled: false })
  if (session.status === 'interrupted') { session.status = 'idle'; session.phase = 'idle'; persist(session) }
  if (session.controller) {
    delete session.pending
    session.controller.abort(new Error('cancelled by user'))
    persist(session)
    return true
  }
  if (session.oralController) { session.oralController.abort(new Error('cancelled by user')); return true }
  persist(session)
  return true
}

/** 运维动作：直接替换常设指令（会话进行中也可，下一次调用生效）。 */
export function replaceDirectives(session, list, note = '') {
  ensureShape(session)
  const next = asArray(list).map((x) => str(x).trim()).filter(Boolean).slice(0, 12)
  session.board.directives = next
  session.board.version = (session.board.version || 0) + 1
  if (note) event(session, `✎ 常设指令重置为第 ${session.board.version} 版：${note}`)
  persist(session)
  return session.board
}

/** 运维动作：会话空闲就立刻发；正在跑就排队，本回合结束后作为下一回合（优先于自动续航）。 */
export function queueMessage(session, text, cfg, opts = {}) {
  ensureShape(session)
  if (session.status !== 'running') return { started: true, turn: sendMessage(session, text, cfg, { ...(session.lastOpts || {}), ...opts }) }
  if (session.pending) throw new Error('该会话已有一条排队指令')
  session.pending = { text, opts, at: new Date().toISOString() }
  event(session, `⏳ 已排队一条指令，本回合结束后作为下一回合执行`)
  persist(session)
  return { queued: true }
}

export function setAutopilot(session, { enabled, objective }, cfg) {
  ensureShape(session)
  const ap = session.autopilot
  const wasEnabled = ap.enabled
  if (enabled && wasEnabled && (!objective || objective.trim() === ap.objective)) return ap
  clearContinuation(session)
  ap.enabled = Boolean(enabled)
  ap.state = enabled ? 'active' : 'paused'
  ap.note = enabled ? '已开启目标续航' : '已暂停'
  if (enabled) {
    const explicit = String(objective || '').trim().slice(0, 4000)
    if (explicit && explicit !== ap.objective) {
      ap.objective = explicit
      ap.cycles = 0
      ap.startGoal = session.status !== 'running'
    }
    ap.objective ||= session.mission || session.turns.at(-1)?.user || ''
    ap.failures = 0
    if (cfg && session.status !== 'running') scheduleContinuation(session, cfg)
  }
  persist(session)
  return ap
}

/* ───────────────────────── 分歧说服 ───────────────────────── */

/**
 * 分歧不直接拍板：双方各自带证据说服对方，读到对方论证后可以坚持、部分让步或被说服；主持人 核查证据后终裁。
 * 证据必须可查证：
 *   quote       引用本会话汇报/材料/记忆原文 —— 系统逐字核对（找不到记为"原文未找到"，按编造处理）
 *   file        本地文件路径 —— 系统核对文件存在（给了片段则核对片段）
 *   calc        可重算的计算 —— 主持人复算
 *   literature  文献 —— 一律【需核验】，不能作为决定性证据
 *   reasoning   纯推理 —— 写清前提，主持人判断是否成立
 */
const DEBATE_MAX_PER_TURN = 2
export const EVIDENCE_TYPES = ['quote', 'file', 'calc', 'literature', 'reasoning']
export const VERIFY_LABEL = { verified: '✓ 已核对', not_found: '✗ 原文未找到', missing: '✗ 文件不存在', outside: '✗ 不可访问', needs_check: '∑ 待主持人复算', unverified: '⚠ 需核验', reasoning: '· 推理' }

const norm = (s) => String(s || '').replace(/[\s\u3000*_`>#「」“”"'‘’（）()，,。.：:；;、\-—|]+/g, '').toLowerCase()

/** 可引用的原文库：本会话所有汇报、互审、综合答复、材料、关键记忆。 */
export function citableTexts(session) {
  const map = new Map()
  for (const t of session.turns || []) {
    for (const k of t.tasks || []) {
      if (k.report) map.set(k.id, k.report)
      for (const [w, c] of Object.entries(k.crosses || {})) map.set(`${k.id}/${w}互审`, c)
    }
    if (t.final) map.set(`${t.id}综合`, t.final)
  }
  for (const m of session.materials || []) if (m.text) map.set(m.path, m.text)
  if (session.memory?.text) map.set('关键记忆', session.memory.text)
  return map
}

export function verifyEvidence(ev, session, texts) {
  const type = EVIDENCE_TYPES.includes(ev?.type) ? ev.type : 'reasoning'
  const content = str(ev?.content)
  const source = str(ev?.source).trim()
  if (type === 'quote') {
    const needle = norm(content)
    if (needle.length < 4) return 'not_found'
    const pool = texts.get(source) ? [texts.get(source)] : [...texts.values()]
    return pool.some((t) => norm(t).includes(needle)) ? 'verified' : 'not_found'
  }
  if (type === 'file') {
    const p = resolve(source.replace(/^~(?=\/|$)/, homedir()))
    if (!p.startsWith(homedir() + '/')) return 'outside'
    try {
      if (!existsSync(p)) return 'missing'
      if (content && norm(content).length >= 4 && statSync(p).isFile() && statSync(p).size < 3_000_000) {
        return norm(readFileSync(p, 'utf8')).includes(norm(content)) ? 'verified' : 'not_found'
      }
      return 'verified'
    } catch { return 'missing' }
  }
  if (type === 'calc') return 'needs_check'
  if (type === 'literature') return 'unverified'
  return 'reasoning'
}

function persuadePrompt(session, turn, d, lane, round, history) {
  const me = d.sides[lane]
  const others = Object.entries(d.sides).filter(([l]) => l !== lane)
  const system = `你是 ${laneName(lane)}，正在一场分歧说服中。目标是用证据说服对方和主持人，而不是赢——如果对方证据更强，就明确让步，被说服不是失败。
规则（违反即判负并记入公告板）：
- 每条论据必须给出可查证的证据，并标注类型：
  quote：引用本会话的汇报/互审/综合答复/材料/关键记忆原文，source 写编号（如 T3.2、T3.2/执行者互审、T2综合、关键记忆、文件路径），content 必须逐字摘录——系统会逐字核对；
  file：本地文件路径（系统核对是否存在，content 可附一段原文供核对）；
  calc：写出可重算的算式与数字来源；
  literature：文献——一律视为【需核验】，不能单独作为决定性证据；
  reasoning：纯推理，写清前提。
- 不得编造数据、实验结果、引用、文件或文献；不确定就说不确定。
- 第 ${round} 轮${round > 1 ? '：先逐条回应对方上一轮的论据（接受哪条、质疑哪条及原因，尤其指出对方无法查证的证据），再表态' : '：陈述立场与最强的 2-4 条论据'}。
${HARD_LINES}
只输出一个 JSON 对象，无 markdown 围栏。`
  const user = `${missionBlock(session)}

${mainlineBlock(session)}

【分歧】${d.issue}
【你的立场】${me}
${others.map(([l, s]) => `【${laneName(l)} 的立场】${s}`).join('\n')}
【主持人初步裁决（仅供参考，可被说服推翻）】${d.ruling || '无'}

【可引用的原文编号】${[...citableTexts(session).keys()].slice(-40).join('、')}

${history.length ? `【之前的说服记录】\n${history.map((h) => `--- ${laneName(h.lane)} 第 ${h.round} 轮（${h.position || '陈述'}）---\n${renderArgs(h)}`).join('\n')}` : ''}

【相关汇报原文（供引用）】
${(turn.tasks || []).filter((t) => t.report && !t.superseded).slice(-6).map((t) => `--- ${t.id}（${t.worker}）---\n${String(t.report).slice(0, 2500)}`).join('\n')}

输出：
{
  "arguments": [ { "claim": "论点", "evidence": [ { "type": "${EVIDENCE_TYPES.join('|')}", "source": "编号或路径（reasoning 可空）", "content": "逐字原文 / 算式 / 文献 / 推理前提" } ] } ],
  ${round > 1 ? `"responses": [ { "to": "对方的哪条论点", "verdict": "接受|质疑", "why": "原因（指出无法查证或逻辑漏洞）" } ],
  "position": "maintain|partial|persuaded",` : ''}
  "revised_stance": "你现在的立场（一句话）"
}`
  return { system, user }
}

function moderatePrompt(session, d, history, commander) {
  const system = `你是主持人，负责终裁这场分歧说服。${d.sides[commander] ? '注意：你本人也是一方，必须同样受证据约束，证据不利于你时要认输。' : ''}
先看系统的机械核对结果：「原文未找到」「文件不存在」的证据视为编造或误引，不予采信并记名；「需核验」的文献不能作为决定性证据；
「待复算」的计算由你复算。然后判断：谁被谁说服、哪些论点成立、最终裁决是什么。只依据可查证的证据，不依据语气或篇幅。
只输出一个 JSON 对象，无 markdown 围栏。`
  const user = `${mainlineBlock(session)}

【分歧】${d.issue}
【初始立场】${Object.entries(d.sides).map(([l, s]) => `${laneName(l)}：${s}`).join('；')}
【你的初步裁决】${d.ruling || '无'}

【说服记录（含系统核对结果）】
${history.map((h) => `--- ${laneName(h.lane)} 第 ${h.round} 轮（${h.position || '陈述'}）---\n${renderArgs(h)}`).join('\n')}

输出：
{
  "outcome": "consensus（达成共识）| side_won（一方胜出）| unresolved（证据不足，暂不裁决）",
  "winner": "胜出方模型名（consensus/unresolved 可空）",
  "persuaded": ["被说服的模型名"],
  "ruling": "最终裁决（一两句话，写进公告板，所有 Agent 执行）",
  "why": "依据哪些已核对证据（≤150 字）",
  "struck": [ { "by": "模型名", "evidence": "被剔除的证据", "reason": "原文未找到/无法查证/计算错误/逻辑不成立" } ],
  "calc_checks": [ { "calc": "算式", "ok": true 或 false, "note": "复算结果" } ],
  "to_verify": ["需要后续任务查证的文献/事实"],
  "experiment": "若证据不足以裁决：一个能裁决此分歧的最小实验（写清对照、读出、判定标准）；否则空",
  "directive": "若需要，新增一条常设指令（否则空）"
}`
  return { system, user }
}

function renderArgs(h) {
  const lines = []
  for (const r of asArray(h.responses)) lines.push(`  ↳ 回应「${str(r.to).slice(0, 60)}」：${str(r.verdict)}——${str(r.why)}`)
  for (const a of asArray(h.arguments)) {
    lines.push(`- **${str(a.claim)}**`)
    for (const e of asArray(a.evidence)) lines.push(`  - [${e.type}${e.source ? `·${str(e.source)}` : ''}] ${str(e.content).slice(0, 300)}　${VERIFY_LABEL[e.check] || ''}`)
  }
  if (h.revised) lines.push(`立场：${h.revised}`)
  return lines.join('\n')
}

/** 跑完本回合被标记的分歧：双方多轮相互说服 → 机械核对证据 → 主持人终裁 → 写公告板。 */
async function runDebates(session, cfg, turn, ask, entry, label, workers, rounds = 2) {
  const commander = controllerLane(cfg)
  const allowed = new Set([...workers, commander])
  const queue = asArray(turn.disputes).filter((d) => !d.done).slice(0, DEBATE_MAX_PER_TURN)
  for (const [i, d] of queue.entries()) {
    const lanes = Object.keys(d.sides).filter((l) => allowed.has(l))
    if (lanes.length < 2) { d.done = true; d.skipped = '有效参与方不足两方'; continue }
    d.sides = Object.fromEntries(lanes.map((l) => [l, d.sides[l]]))
    d.id = `${turn.id}.D${i + 1}`
    session.phase = 'debate'
    event(session, `▸ 分歧说服 ${d.id}：${d.issue.slice(0, 60)}（${lanes.join(' vs ')}）`)
    entry({ lane: commander, role: `${label(commander)} · 开启分歧说服 ${d.id}`, kind: 'debate-open', round: 0, text: `**分歧**：${d.issue}\n${lanes.map((l) => `- **${laneName(l)}**：${d.sides[l]}`).join('\n')}\n\n**规则**：带可查证证据相互说服（汇报原文系统逐字核对、文件核对存在、文献一律需核验），最多 ${rounds} 轮，主持人核查后终裁。` })
    const history = []
    const texts = () => citableTexts(session)
    for (let round = 1; round <= rounds; round += 1) {
      const got = await Promise.all(lanes.map(async (l) => {
        const raw = await ask(l, `debate ${d.id} r${round}`, persuadePrompt(session, turn, d, l, round, history), { maxTokens: 2400, temperature: 0.4, reasoning: 'medium' })
        const j = parseJSON(raw)
        if (!j) return null
        const tx = texts()
        for (const a of asArray(j.arguments)) for (const e of asArray(a.evidence)) e.check = verifyEvidence(e, session, tx)
        return { lane: l, round, arguments: asArray(j.arguments), responses: asArray(j.responses), position: str(j.position) || null, revised: str(j.revised_stance) }
      }))
      for (const h of got.filter(Boolean)) {
        history.push(h)
        const bad = asArray(h.arguments).flatMap((a) => asArray(a.evidence)).filter((e) => ['not_found', 'missing', 'outside'].includes(e.check)).length
        entry({ lane: h.lane, role: `${label(h.lane)} · 说服 ${d.id} 第${round}轮${h.position ? `（${({ maintain: '坚持', partial: '部分让步', persuaded: '被说服' })[h.position] || h.position}）` : ''}${bad ? ` · ${bad} 条证据核对失败` : ''}`, kind: 'debate', round, text: renderArgs(h) })
      }
      const latest = lanes.map((l) => history.filter((h) => h.lane === l).pop()).filter(Boolean)
      if (round > 1 && latest.length && latest.some((h) => h.position === 'persuaded')) break // 有人被说服即可终裁
    }
    if (!history.length) { d.done = true; d.skipped = '说服调用均失败'; event(session, `⚠ ${d.id} 说服调用均失败，保留初步裁决`); continue }
    const v = parseJSON(await ask(controllerLane(cfg), `moderate ${d.id}`, moderatePrompt(session, d, history, controllerLane(cfg)), { maxTokens: 2400, temperature: 0.2 }))
    d.history = history
    d.verdict = v || { outcome: 'unresolved', ruling: d.ruling, why: '主持人终裁失败，保留初步裁决' }
    d.done = true
    const out = d.verdict
    session.board.rulings.push({
      turn: turn.id, taskId: d.id, worker: out.winner || 'consensus', score: null, verdict: 'dispute', kind: 'dispute',
      note: `分歧「${d.issue.slice(0, 40)}」→ ${str(out.ruling)}`, accepted: [str(out.why)], rejected: asArray(out.struck).map((x) => ({ point: `${x.by}：${str(x.evidence).slice(0, 60)}`, reason: str(x.reason) })),
      ts: new Date().toISOString(),
    })
    if (str(out.directive).trim()) setDirectives(session, [...asArray(session.board.directives), str(out.directive)])
    for (const x of asArray(out.to_verify)) if (str(x).trim()) turn.carryOver.push(`[${d.id} 需核验] ${str(x)}`)
    const OUT = { consensus: '达成共识', side_won: `${laneName(out.winner)} 胜出`, unresolved: '证据不足，暂不裁决' }
    entry({ lane: commander, role: `${label(commander)} · 终裁 ${d.id}`, kind: 'judge', round: 0, text: [
      `**结果**：${OUT[out.outcome] || out.outcome}${asArray(out.persuaded).length ? `｜被说服：${asArray(out.persuaded).map(laneName).join('、')}` : ''}`,
      `**裁决**：${str(out.ruling)}`,
      `**依据**：${str(out.why)}`,
      ...asArray(out.calc_checks).map((c) => `  - 复算 ${str(c.calc)}：${c.ok ? '✓' : '✗'} ${str(c.note)}`),
      ...asArray(out.struck).map((x) => `  - ✗ 剔除 ${laneName(x.by)} 的证据「${str(x.evidence).slice(0, 80)}」：${str(x.reason)}`),
      asArray(out.to_verify).length ? `**需核验**：${asArray(out.to_verify).map(str).join('；')}` : '',
    ].filter(Boolean).join('\n'), json: out })
    event(session, `◆ ${d.id} 终裁：${OUT[out.outcome] || out.outcome}`)
  }
}

/* ───────────────────────── 记忆整理与 Obsidian ───────────────────────── */

function writeStageFeedback(session, cfg, turn) {
  if (!turn.ledger.length && !turn.carryOver.length) return
  const dir = memoryDir(session, cfg)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '阶段反馈.md')
  const exists = existsSync(file)
  if (exists && readFileSync(file, 'utf8').split('\n').some((line) =>
    line.startsWith(`## ${turn.id} · `) || line.startsWith(`## ${turn.id}（自动） · `))) {
    session.memory ||= {}
    session.memory.stageFile = file
    return
  }
  const head = exists ? '' : `---\nsession: ${session.id}\ntitle: ${session.title}\n---\n\n# 阶段反馈 — ${session.title}\n\n> 由多 Agent 协作自动追加，每回合一节。\n`
  const body = [
    `\n## ${turn.id}${turn.auto ? '（自动）' : ''} · ${new Date().toLocaleString('zh-CN')}`,
    `> ${turn.user.replace(/\n/g, ' ').slice(0, 300)}`,
    '',
    ...turn.ledger.map((x) => `- **${x.taskId} ${laneName(x.worker)}**（${x.status}${x.score != null ? `，${x.score}/10` : ''}）${str(x.task).slice(0, 120)}\n  ${str(x.stage).replace(/\n+/g, '\n  ').slice(0, 1200)}`),
    turn.carryOver.length ? `\n**遗留事项**\n${turn.carryOver.map((c) => `- [ ] ${c}`).join('\n')}` : '',
  ].join('\n')
  writeFileSync(file, head + body + '\n', { flag: 'a' })
  session.memory ||= {}
  session.memory.stageFile = file
}

function memoryPrompt(session, reason, turns) {
  const system = `你是总控，多 Agent 科研协作的总控。各参与模型的提示词即将放不下全部历史，你要把关键信息整理成「关键记忆」，
之后所有 Agent 只靠它记住更早的内容。要求：只保留会影响后续判断的信息；已确认结论要带证据来源；被驳回/否决的方向要写理由（防止重蹈覆辙）；
保留具体数字、文件路径、版本号、贡献评审票数；不编造，不确定的标【需核验】。用 markdown，≤ 3500 字。`
  const user = `${missionBlock(session)}

【整理原因】${reason}

【旧版关键记忆】
${session.memory?.text || '（无）'}

【常设指令】
${asArray(session.board?.directives).map((d, i) => `${i + 1}. ${d}`).join('\n')}

【需要并入的回合】
${turns.map((t) => `### ${t.id}${t.auto ? '（自动）' : ''}
用户：${t.user.slice(0, 800)}
结论：
${String(t.final).slice(0, 5000)}
阶段反馈：
${asArray(t.ledger).map((x) => `- ${x.taskId} ${x.worker} ${x.status} ${x.score ?? ''}：${str(x.stage).slice(0, 600)}`).join('\n')}
遗留：${asArray(t.carryOver).join('；') || '无'}`).join('\n\n')}

【贡献评审记录】
${asArray(session.oral).slice(-5).map((o) => `- ${o.title}（${o.versionHash}）：积极 ${o.positives}/${o.planned}，${o.passed ? '合格' : '未达标'}；致命问题：${asArray(o.topIssues).join('；')}`).join('\n') || '无'}

按以下小节输出：
## 目标与故事线现状
## 已确认结论（附证据来源）
## 已否决 / 被驳回的方向（附理由）
## 当前贡献版本与评审结果
## 关键数字、文件与版本
## 未完成与遗留事项
## 下一步计划`
  return { system, user }
}

/** 总控 整理关键记忆 → 写 Obsidian → 之后所有 Agent 的提示词都带上它。 */
export async function consolidateMemory(session, cfg, reason = '手动保存', signal) {
  ensureShape(session)
  if (session.memoryBusy) return session.memory
  session.memoryBusy = true
  const prevPhase = session.phase
  session.phase = 'memory'
  event(session, `▸ 整理关键记忆：${reason}`)
  try {
    const finished = session.turns.filter((t) => t.final)
    const from = Math.min(session.memory?.coveredTurns || 0, finished.length)
    const turns = finished.slice(from).length ? finished.slice(from) : finished.slice(-1)
    const ask = makeAsk(session, cfg, signal, null)
    const text = MOCK ? `## 目标与故事线现状\nmock 记忆（${turns.length} 回合）` : await ask(controllerLane(cfg), 'memory', memoryPrompt(session, reason, turns), { maxTokens: 6000, temperature: 0.2 })
    if (!text) throw new Error('总控 整理失败')
    const m = session.memory || {}
    const version = (m.version || 0) + 1
    const dir = memoryDir(session, cfg)
    mkdirSync(join(dir, '历史版本'), { recursive: true })
    const file = join(dir, '关键记忆.md')
    const doc = `---\nsession: ${session.id}\ntitle: ${session.title}\nversion: ${version}\nupdated: ${new Date().toISOString()}\nreason: ${reason.replace(/\n/g, ' ')}\ncovered_turns: ${finished.length}\n---\n\n# 关键记忆 — ${session.title}\n\n> 多 Agent 协作自动整理（第 ${version} 版）。所有 Agent 的提示词都带着这份记忆；手动修改会在下次整理时作为旧版并入。\n\n${text}\n`
    if (existsSync(file)) writeFileSync(join(dir, '历史版本', `关键记忆_v${m.version || 0}.md`), readFileSync(file, 'utf8'))
    writeFileSync(file, doc)
    session.memory = { ...m, text, version, savedAt: new Date().toISOString(), file, dir, coveredTurns: finished.length, reason }
    session.memoryDue = null
    event(session, `✓ 关键记忆 v${version} 已保存到 Obsidian：${file}`)
  } catch (err) {
    event(session, `✗ 记忆整理失败：${err.message}（下回合结束再试）`)
  } finally {
    session.memoryBusy = false
    session.phase = session.status === 'running' ? prevPhase : 'idle'
    persist(session)
  }
  return session.memory
}

/** 用户在 Obsidian 里改过「关键记忆.md」时，把正文读回来（以 Obsidian 为准）。 */
export function syncMemoryFromObsidian(session) {
  const f = session.memory?.file
  if (!f || !existsSync(f)) return false
  const raw = readFileSync(f, 'utf8')
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').replace(/^# 关键记忆[^\n]*\n+(>[^\n]*\n+)?/, '').trim()
  if (body && body !== session.memory.text) {
    session.memory.text = body
    session.memory.editedInObsidian = new Date().toISOString()
    persist(session)
    return true
  }
  return false
}

/* ───────────────────────── 贡献评审 ───────────────────────── */

function oralDir() {
  const d = join(VAULT || '.', 'oral')
  mkdirSync(d, { recursive: true })
  return d
}

const versionHash = (text) => createHash('sha1').update(String(text).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12)

function isPositive(v) {
  const s = String(v || '')
  return /积极|positive/i.test(s) && !/消极|不积极|negative/i.test(s)
}

/**
 * 各参与模型各自独立做 配置轮数 轮整体评审（每轮一次独立调用，看不到其他轮/其他模型）。
 * 积极 ≥ 配置门槛（按实际配置票数计）才合格。同一贡献版本（文本哈希相同）不重抽，直接返回已有结果。
 */
export async function runOralPanel(session, cfg, contribution, { title = '', turnId = null, signal } = {}) {
  ensureShape(session)
  const { lanes, rounds, planned, threshold } = reviewConfig(cfg)
  const panel = lanes.map(id => ({ id, kind: cfg.lanes[id].kind, model: cfg.lanes[id].model || '', baseUrl: cfg.lanes[id].baseUrl || '', bin: cfg.lanes[id].bin || '' }))
  const hash = versionHash(JSON.stringify({ contribution, panel, rounds, threshold, rubric: oralRubric(cfg) }))
  const cacheFile = join(oralDir(), `${hash}.json`)
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (cached.complete) {
        const reused = { ...cached, reused: true, turnId }
        session.oral.push(reused)
        event(session, `· 贡献版本 ${hash} 已评过（${cached.positives}/${cached.planned}），按规则不重抽`)
        persist(session)
        return reused
      }
    } catch { /* 重新评 */ }
  }
  const resumed = turnId && session.oral.find((o) => o.turnId === turnId && o.versionHash === hash && !o.finishedAt)
  const result = resumed || {
    id: `O-${hash}-${Date.now().toString(36)}`, versionHash: hash, title: title || contribution.split('\n')[0].slice(0, 40),
    contribution, turnId, startedAt: new Date().toISOString(), finishedAt: null,
    rounds, threshold, planned,
    lanes, votes: [], positives: 0, passed: false, complete: false, perLane: {}, topIssues: [],
  }
  if (!resumed) session.oral.push(result)
  session.oralRunning = true
  persist(session)
  event(session, `▸ 贡献评审开始：${result.title}（${lanes.join('/')} × ${rounds}）`)
  const ask = makeAsk(session, cfg, signal, null)

  const vote = async (lane, round) => {
    const lens = ORAL_LENSES[(round - 1) % ORAL_LENSES.length]
    const p = oralVotePrompt(session, cfg, contribution, round, lens)
    let parsed = null
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      parsed = parseJSON(await ask(lane, `oral ${lane}#${round}`, p, { maxTokens: 1200, temperature: 0.9, reasoning: 'medium', quiet: true }))
    }
    const v = parsed
      ? { lane, round, lens, ok: true, verdict: str(parsed.verdict), positive: isPositive(parsed.verdict), score: Number(parsed.score) || null,
          strongest: str(parsed.strongest_point), fatal: str(parsed.fatal_issue), neighbor: str(parsed.nearest_neighbor_risk),
          needed: str(parsed.decisive_evidence_needed), reason: str(parsed.reason) }
      : { lane, round, lens, ok: false, verdict: '失败', positive: false, error: '调用或解析失败' }
    result.votes.push(v)
    result.positives = result.votes.filter((x) => x.positive).length
    persist(session)
    return v
  }

  try {
    await Promise.all(lanes.map((lane) => pool(
      Array.from({ length: rounds }, (_, i) => i + 1)
        .filter((round) => !result.votes.some((v) => v.lane === lane && v.round === round)), Math.max(1, Math.min(5, Number(cfg.lanes[lane].reviewConcurrency) || 3)), (round) => vote(lane, round),
    )))
  } finally {
    session.oralRunning = false
  }
  result.votes.sort((a, b) => a.lane.localeCompare(b.lane) || a.round - b.round)
  for (const lane of lanes) {
    const vs = result.votes.filter((v) => v.lane === lane)
    result.perLane[lane] = {
      positive: vs.filter((v) => v.positive).length, reserved: vs.filter((v) => /保留|reserve/i.test(v.verdict)).length,
      negative: vs.filter((v) => /消极|negative/i.test(v.verdict)).length, failed: vs.filter((v) => !v.ok).length, total: vs.length,
    }
  }
  result.positives = result.votes.filter((v) => v.positive).length
  result.complete = result.votes.length === result.planned && result.votes.every((v) => v.ok)
  result.passed = result.complete && result.positives >= threshold
  const issues = new Map()
  for (const v of result.votes) if (v.fatal && !/^无/.test(v.fatal)) issues.set(v.fatal.slice(0, 60), (issues.get(v.fatal.slice(0, 60)) || 0) + 1)
  result.topIssues = [...issues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
  result.finishedAt = new Date().toISOString()
  if (!signal?.aborted) writeFileSync(cacheFile, JSON.stringify(result, null, 2) + '\n')
  event(session, `${result.passed ? '✓' : '✗'} 贡献评审：积极 ${result.positives}/${result.planned}（门槛 ${threshold}）${result.complete ? '' : '｜有失败票，结果不完整'}`)
  persist(session)
  return result
}

/** 手动提交一个贡献版本做评审（不占用回合）。 */
export function startManualOral(session, cfg, contribution, title) {
  ensureShape(session)
  if (session.oralRunning) throw new Error('该会话已有贡献评审在进行')
  session.oralController = new AbortController()
  void runOralPanel(session, cfg, String(contribution), { title, signal: session.oralController.signal })
    .catch((err) => event(session, `✗ 贡献评审失败：${err.message}`))
    .finally(() => { session.oralController = null; persist(session) })
}

/* ───────────────────────── 状态端口 ───────────────────────── */

/** 所有会话的紧凑状态快照（不调用模型）。 */
export function statusSnapshot({ sessionId } = {}) {
  const list = [...sessions.values()].filter((s) => !sessionId || s.id === sessionId)
  return list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((s) => {
    const t = s.turns[s.turns.length - 1]
    const o = s.oral?.[s.oral.length - 1]
    return {
      id: s.id, title: s.title, status: s.status, phase: s.phase, updatedAt: s.updatedAt,
      busy: s.busy, oralRunning: Boolean(s.oralRunning),
      autopilot: s.autopilot,
      directives: s.board?.directives || [],
      recentRulings: (s.board?.rulings || []).slice(-5).map((r) => `${r.taskId} ${r.worker} ${r.score ?? '–'}/10 ${r.verdict || ''} ${str(r.note).slice(0, 80)}`),
      turn: t ? {
        id: t.id, user: t.user.slice(0, 200), auto: t.auto, startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error,
        tasks: (t.tasks || []).map((x) => ({ id: x.id, worker: x.worker, status: x.status, attempt: x.attempt, score: x.ruling?.score ?? null, task: x.task.slice(0, 100) })),
        finalExcerpt: (t.final || '').slice(0, 500),
      } : null,
      memory: s.memory ? { version: s.memory.version, savedAt: s.memory.savedAt, file: s.memory.file, stageFile: s.memory.stageFile, reason: s.memory.reason } : null,
      memoryDue: s.memoryDue || null,
      mainline: s.mainline ? { direction: s.mainline.direction, stage: STAGES[s.mainline.stage], progress: s.mainline.progress?.percent ?? 0, progressReason: s.mainline.progress?.reason || '', blocker: s.mainline.progress?.blocker || '', mapRef: mapCompletion(s.mainline.map), map: s.mainline.map.map((x) => `${x.element}=${x.status}`), last: s.mainline.decisions.slice(-1)[0] || null } : null,
      pressure: s.pressure || {},
      carryOver: t?.carryOver || [],
      oral: o ? { title: o.title, positives: o.positives, done: o.votes.length, planned: o.planned, passed: o.passed, complete: o.complete, perLane: o.perLane, reused: Boolean(o.reused) } : null,
      events: (s.events || []).slice(-8),
    }
  })
}

/** 让总控 回答关于会话状态的任何问题。 */
export async function askStatus(cfg, question, { sessionId } = {}) {
  const snap = statusSnapshot({ sessionId })
  const focus = sessionId ? sessions.get(sessionId) : null
  let usage = null
  try { usage = await getUsage(cfg, { includeBalance: false }) } catch { /* 余额查询失败不影响回答 */ }
  const system = `你是总控，多 Agent 科研协作的总控。用户在问各会话的运行状态。只依据下面的实时快照回答，
不知道的说不知道；回答简洁、具体（谁在做什么、卡在哪、评审进度、下一步），中文。`
  const user = `【当前时间】${new Date().toISOString()}
【全部会话快照】
${JSON.stringify(snap, null, 1).slice(0, 30_000)}
${usage ? `\n【各条线路用量余额与上下文】\n${JSON.stringify(usage.lanes, null, 1).slice(0, 6000)}` : ''}
${focus ? `\n【重点会话最近结论】\n${String(focus.turns[focus.turns.length - 1]?.final || '').slice(0, 4000)}` : ''}

【用户问题】${question}`
  if (MOCK) return { answer: `mock：共 ${snap.length} 个会话`, snapshot: snap }
  const res = await callLane(controllerLane(cfg), cfg, { system, user, maxTokens: 1500, temperature: 0.2 })
  return { answer: res.text, snapshot: snap }
}

/* ───────────────────────── 解析与渲染 ───────────────────────── */

export function parseJSON(text) {
  if (!text) return null
  try { const v = extractJSON(text); return v && typeof v === 'object' ? v : null } catch {
    try { const s = salvageJSON(text); return s && typeof s === 'object' ? s : null } catch { return null }
  }
}

function renderDirectives(board) {
  return asArray(board?.directives).length
    ? `**常设指令（第 ${board.version} 版，已广播给所有 Agent）**\n${board.directives.map((d, i) => `${i + 1}. ${d}`).join('\n')}` : ''
}

function renderPlan(p, tasks, board) {
  return [
    `**理解**：${str(p.understanding)}`,
    p.strategy ? `**分工思路**：${str(p.strategy)}` : '',
    ...tasks.map((t) => `**→ ${t.worker} ${t.id}**：${t.task}${t.deliverable ? `\n  - 交付：${t.deliverable}` : ''}${t.acceptance ? `\n  - 验收：${t.acceptance}` : ''}${t.skills.length ? `\n  - skill：${t.skills.join(', ')}` : ''}`),
    asArray(p.watch_out).length ? `**预警**：${asArray(p.watch_out).map((x) => str(x)).join('；')}` : '',
    renderDirectives(board),
  ].filter(Boolean).join('\n')
}

function renderJudge(batch, conflicts, board, allTasks) {
  const lines = []
  for (const t of batch) {
    const r = t.ruling || {}
    lines.push(`**${t.id} · ${t.worker}：${r.score ?? '–'}/10${r.story_score != null ? ` · 故事 ${r.story_score}/10` : ''} ${r.verdict === 'revise' ? '↩ 打回' : '✓ 通过'}**${r.note ? ` —— ${str(r.note)}` : ''}`)
    for (const a of asArray(r.accepted)) lines.push(`  - ✓ ${str(a)}`)
    for (const x of asArray(r.rejected)) lines.push(`  - ✗ ${typeof x === 'object' ? `${str(x.point)} —— ${str(x.reason)}` : str(x)}`)
    const child = allTasks.find((c) => c.parent === t.id)
    if (child) lines.push(`  - ${child.attempt > 1 ? '打回重做' : '续派'} → ${child.worker} ${child.id}：${(child.feedback || child.task).slice(0, 140)}`)
  }
  for (const c of conflicts) lines.push(`**分歧**：${str(c?.issue)}\n  - ${c?.debate === true ? '初步裁决（将进入相互说服）' : '裁决'}：${str(c?.ruling)}（${str(c?.why)}）`)
  const dir = renderDirectives(board)
  if (dir) lines.push(dir)
  return lines.join('\n')
}

function renderOral(o) {
  const lanes = Object.entries(o.perLane || {}).map(([l, s]) => `${laneName(l)} ${s.positive}/${s.total}${s.failed ? `（失败 ${s.failed}）` : ''}`).join(' · ')
  return [
    `**${o.passed ? '✓ 合格贡献' : '✗ 未达标'}：积极 ${o.positives}/${o.planned}（门槛 ${o.threshold}）**${o.reused ? '（同一版本已评过，按规则不重抽）' : ''}${o.complete ? '' : '（有失败票，结果不完整）'}`,
    `**分模型**：${lanes}`,
    `**版本**：${o.title}（${o.versionHash}）`,
    o.topIssues?.length ? `**高频致命问题**：\n${o.topIssues.map((x) => `  - ${x}`).join('\n')}` : '',
    '说明：每票是一次独立的模型调用，同一模型的多轮调用仍是同源判断，不等同于多位独立审稿人，也不代表录用概率。',
  ].filter(Boolean).join('\n')
}

function fallbackFinal(tasks) {
  return `## 结论\n（总控综合失败，以下为执行者原始汇报，请自行判断）\n\n${tasks.filter((t) => t.report).map((t) => `### ${t.id} ${t.worker}\n${t.report}`).join('\n\n')}`
}

export function renderSessionMd(s) {
  const out = [`# 总控协作会话 — ${s.title}`, '', `- 会话：${s.id}　创建：${s.createdAt}`, `- 会议：${resolveVenueName(s.context?.venue)}`]
  if ((s.materials || []).length) out.push(`- 材料：${s.materials.map((m) => m.path).join('；')}`)
  if (asArray(s.board?.directives).length) out.push('', renderDirectives(s.board))
  out.push('')
  for (const t of s.turns || []) {
    out.push(`## 第 ${t.id.slice(1)} 回合${t.auto ? '（自动）' : ''}`, '', `> ${t.user.replace(/\n/g, '\n> ')}`, '')
    for (const e of t.entries || []) if (e.kind !== 'knowledge') out.push(`### ${e.role}`, '', e.text, '')
    if (t.next?.evidenceReview) {
      const { stage, disposition, evidence, nextTrigger } = t.next.evidenceReview
      out.push('### 证据判断', '', `- 阶段：${stage || '待判断'}`, `- 决定：${disposition}`,
        `- 证据：${evidence.join('；') || '待补'}`, `- 下一触发：${nextTrigger}`, '')
    }
    if (t.error) out.push(`**错误**：${t.error}`, '')
  }
  return out.join('\n')
}

/* ───────────────────────── mock ───────────────────────── */

function mockText(tag, lane, ctx = {}) {
  const workers = ctx.workers || []
  const commander = ctx.controller || 'controller'
  if (tag === 'plan') {
    return JSON.stringify({
      understanding: 'mock 理解', strategy: 'mock 分工', directives: ['文献标【需核验】', '遵守实验训练准则'],
      tasks: Object.fromEntries(workers.map((w) => [w, [{ task: `mock 任务 ${w} A`, deliverable: 'd', acceptance: 'a', skills: ['oral-paper-skill'] }, { task: `mock 任务 ${w} B` }]])),
      watch_out: ['编文献'],
    })
  }
  if (tag.startsWith('judge')) {
    const ids = tag.split(' ')[1].split(',')
    return JSON.stringify({
      rulings: ids.map((id) => {
        const t = (ctx.tasks || []).find((x) => x.id === id) || {}
        const first = id.endsWith('.1') && (t.attempt || 1) === 1
        return { task_id: id, score: first ? 5 : 8, accepted: ['要点 A'], rejected: [{ point: '要点 B', reason: '无依据' }], verdict: first ? 'revise' : 'accept', revise_instruction: first ? '补对照' : '', next_task: id.endsWith('.2') ? { task: 'mock 续派' } : null, note: 'mock' }
      }),
      directives: ['文献标【需核验】', '遵守实验训练准则', 'mock 新指令'],
      conflicts: ids.some((id) => id.endsWith('.2')) ? [{ issue: 'mock 分歧', ruling: '初步', why: 'w', debate: true, sides: { [workers[0]]: '立场A', [commander]: '立场B' } }] : [],
    })
  }
  if (tag.startsWith('debate')) return JSON.stringify({ arguments: [{ claim: `${lane} 论点`, evidence: [{ type: 'quote', source: '', content: `mock ${workers[0]} task` }, { type: 'quote', source: '', content: '这句话根本不存在于任何汇报中' }, { type: 'literature', content: 'Foo et al. 2025' }] }], responses: tag.endsWith('r2') ? [{ to: '对方论点', verdict: '接受', why: 'w' }] : [], position: tag.endsWith('r2') ? (lane === commander ? 'persuaded' : 'maintain') : undefined, revised_stance: 's' })
  if (tag.startsWith('moderate')) return JSON.stringify({ outcome: 'side_won', winner: workers[0], persuaded: [commander], ruling: 'mock 终裁', why: '已核对证据', struck: [{ by: commander, evidence: '这句话根本不存在', reason: '原文未找到' }], to_verify: ['Foo et al. 2025'], directive: '' })
  if (tag.includes('补写')) return `## 阶段反馈\n- 已完成：mock 补写\n- 未完成及原因：无`
  if (tag.includes('续写')) return `\n## 风险与反例\n- z（续写）`
  if (tag.startsWith('task')) return `## 结论\nmock ${lane} ${tag}\n## 交付内容\n- x\n## 依据与置信度\n- y [中]`
  if (tag.startsWith('cross')) return '## 错误或可疑之处\n- mock\n## 一句话评价\nmock'
  if (tag === 'extract') return JSON.stringify({ has_contribution: true, title: 'mock 贡献', contribution_type: '新方法', problem: 'p', delta: 'd' })
  if (tag.startsWith('oral')) return JSON.stringify({ verdict: Math.random() < 0.8 ? '积极' : '保留', score: 7, fatal_issue: 'mock 致命问题', reason: 'mock' })
  if (tag.startsWith('mainline') && ctx.evidenceWorkflow) return JSON.stringify({
    decision: 'wait', direction: 'mock 主线', reason: '等待可复现记录',
    evidence_review: { stage: 'minimal_check', disposition: 'wait', evidence: [], next_trigger: '由执行者交付可复现记录' },
  })
  if (tag.startsWith('mainline')) return JSON.stringify({ direction: 'mock 主线', stage: 'explore', map: [{ element: '一句话主张', status: '有方案', note: 'n' }], advanced: ['一句话主张'], loop_check: '无', progress: 12, progress_reason: 'mock', blocker: 'mock 卡点', decision: process.env.FOUNDRY_MOCK_NEEDUSER ? 'need_user' : process.env.FOUNDRY_MOCK_CONTINUE ? 'continue' : 'finish', needs_user: process.env.FOUNDRY_MOCK_NEEDUSER ? '请用户确认 A/B 选型' : '', reason: 'mock 判断', next_message: '', template: 'free' })
  return '## 结论\nmock 综合答复\n## 下一步\n1. mock'
}
