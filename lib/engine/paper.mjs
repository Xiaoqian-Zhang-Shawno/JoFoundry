/**
 * 论文成稿与人机审稿：各模型写中英双份初稿 → 机械核对数字 → 总控 审稿与修订 → 人机审稿讨论窗。
 *
 *   draft      总控 按故事线定大纲 → 执行者 分节写英文 → 另一方写对齐的中文
 *              → 系统逐个核对正文数字能否在本项目的汇报/记忆/材料里找到 → 总控 审稿 → 需要时修订一次
 *   comments   用户在审稿窗对某节/某句提意见 → 两名执行者各自提出处理方案（改稿/补实验/带证据反驳）
 *              → 看过对方方案后相互说服一轮 → 总控 决断并执行：改稿直接更新正文，补实验排入方案讨论，反驳附证据回复用户
 *
 * 初稿写入 Obsidian：<会话记忆目录>/论文初稿/v<N>/（paper_en.md、paper_zh.md、REVIEW.md），latest_* 为最新版。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { str, asArray } from './parse.mjs'
import { controllerLane, workerLanes } from './config.mjs'
import { loadSkillBodies } from './knowledge.mjs'
import {
  persist, event, makeAsk, parseJSON, contextBlock, memoryDir, ensureShape, laneName,
  HARD_LINES, WRITING_STYLE, WRITING_SKILLS, queueMessage, citableTexts,
} from './command.mjs'

const MAX_SECTIONS = 9
const WRITER_CONCURRENCY = 2

// Use only the selected session's evidence.
function evidenceCorpus(session) {
  return [...citableTexts(session).values()].join('\n')
}

const norm = (x) => String(x).replace(/[\s,，]/g, '')
/** 抽出正文里"实质数字"（小数、百分比、分数、带单位的大数），逐个查能否在证据语料里找到。 */
export function traceNumbers(text, corpus) {
  const nums = new Set()
  const re = /\d+\.\d+%?|\d+(?:\.\d+)?\s*%|\d+\s*\/\s*\d+|\b\d{3,}(?:,\d{3})*\b/g
  for (const m of String(text).matchAll(re)) {
    const v = m[0].trim()
    if (/^(19|20)\d\d$/.test(v)) continue // 年份
    nums.add(v)
  }
  const c = norm(corpus)
  const missing = [...nums].filter((v) => !c.includes(norm(v)))
  return { total: nums.size, missing }
}

/* ───────────────────────── 提示词 ───────────────────────── */

function outlinePrompt(session, writers) {
  return {
    system: `你是总控，负责把本项目整理成一篇论文的初稿大纲。只用已有的真实证据，不编造结果；
证据还没有的部分在大纲里标明"待结果"，并写出结果到来前的写法。${HARD_LINES}
只输出一个 JSON 对象，无 markdown 围栏。`,
    user: `${contextBlock(session, null)}

输出（最多 ${MAX_SECTIONS} 节，通常为 abstract / introduction / related_work / method / experiments / results / limitations / conclusion）：
{
  "title_en": "英文标题", "title_zh": "中文标题",
  "one_sentence_claim": "一句话主张（当前证据撑得住的版本）",
  "sections": [ { "id": "introduction", "title_en": "Introduction", "title_zh": "引言",
    "purpose": "这一节在故事里承担什么", "key_points": ["要写的要点"],
    "evidence": ["引用的证据：数字、文件路径或回合编号"], "pending": ["还在等的结果及临时写法"],
    "writer": "从 ${writers.join('、')} 中选择线路 ID" } ]
}`,
  }
}

function writePrompt(session, outline, sec, lang, enText = '') {
  const skills = loadSkillBodies(WRITING_SKILLS.slice(0, 2))
  const zh = lang === 'zh'
  return {
    system: `你在为一篇论文写「${zh ? sec.title_zh : sec.title_en}」一节的${zh ? '中文版' : '英文版'}。
${WRITING_STYLE}
${zh ? '中文版必须与给定英文版逐段对齐：内容、数字、限定条件完全一致，用自然的中文学术表达，不逐字硬译。' : ''}
只写有证据支撑的内容；数字必须来自给出的证据；还没有的结果写成"待结果"占位，不得编造。${HARD_LINES}
${skills.map((s) => `--- 写作辅导 skill：${s.name} ---\n${s.text}`).join('\n\n')}`,
    user: `${contextBlock(session, null)}

【论文】${outline.title_en}｜一句话主张：${outline.one_sentence_claim}
【全文大纲】${asArray(outline.sections).map((s) => `${s.id}：${s.purpose}`).join('；')}
【本节】${sec.id}
目的：${sec.purpose}
要点：${asArray(sec.key_points).join('；')}
证据：${asArray(sec.evidence).join('；')}
待结果：${asArray(sec.pending).join('；') || '无'}
${zh ? `\n【对应英文版（中文版必须与之对齐）】\n${enText}` : ''}

直接输出本节${zh ? '中文' : '英文'}正文（markdown，用 ### 小标题即可，不要再写节标题），不要任何说明文字。`,
  }
}

function reviewPrompt(session, outline, items) {
  return {
    system: `你是总控，按目标会议审稿标准审这一版初稿的各节。重点：
1. 与证据是否一致（系统已列出在证据里找不到的数字，逐个判断是编造、笔误还是合理的推导）；
2. 是否违反写作规范（华丽或夸张措辞、丢失限定条件、用词单调重复）；
3. 中英两版是否一致；4. 是否服务于一句话主张与故事线。
只输出一个 JSON 对象，无 markdown 围栏。`,
    user: `【论文】${outline.title_en}｜${outline.one_sentence_claim}
${WRITING_STYLE}
${items.map((x) => `
===== ${x.id} =====
【英文】
${x.en.slice(0, 7000)}
【中文】
${x.zh.slice(0, 5000)}
【证据里找不到的数字】${x.trace.missing.join('、') || '无'}（共检出 ${x.trace.total} 个）`).join('\n')}

输出：
{ "sections": [ { "id": "节 id", "verdict": "ok 或 revise", "score": 1-10,
    "issues": ["具体问题"], "instruction": "revise 时给作者的具体修改指令（ok 则空）" } ],
  "overall": "一句话总评" }`,
  }
}

function revisePrompt(session, outline, sec, enText, instruction, trace) {
  return {
    system: `你在按总控的审稿意见修改论文「${sec.title_en}」一节的英文版。${WRITING_STYLE}
只按意见修改，其余保持不变；数字必须来自证据，找不到出处的数字删除或改为"待结果"。${HARD_LINES}`,
    user: `${contextBlock(session, null)}

【当前英文版】
${enText}

【总控修改意见】${instruction}
【证据里找不到的数字】${trace.missing.join('、') || '无'}

直接输出修改后的本节英文正文，不要说明文字。`,
  }
}

/* ───────────────────────── 成稿 ───────────────────────── */

async function pool(items, limitOf, fn) {
  const running = new Map()
  const queue = [...items]
  const out = []
  await new Promise((resolveAll) => {
    let active = 0
    const pump = () => {
      if (!queue.length && !active) return resolveAll()
      for (let i = 0; i < queue.length; i += 1) {
        const it = queue[i]
        const lane = it.lane
        if ((running.get(lane) || 0) >= limitOf) continue
        queue.splice(i, 1); i -= 1
        running.set(lane, (running.get(lane) || 0) + 1); active += 1
        fn(it).then((r) => out.push(r), () => out.push(null)).finally(() => { running.set(lane, running.get(lane) - 1); active -= 1; pump() })
      }
    }
    pump()
  })
  return out
}


export function paperState(session) {
  ensureShape(session)
  session.paper ||= { version: 0, outline: null, sections: {}, comments: [], reviews: [], running: false, log: [] }
  return session.paper
}

function plog(session, msg) {
  const p = paperState(session)
  p.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  if (p.log.length > 200) p.log.splice(0, p.log.length - 200)
  event(session, `📝 ${msg}`)
}

function assemble(p, lang) {
  const o = p.outline || {}
  const title = lang === 'zh' ? o.title_zh : o.title_en
  return [`# ${title || ''}`, '', ...asArray(o.sections).map((s) => {
    const sec = p.sections[s.id] || {}
    return `## ${lang === 'zh' ? s.title_zh : s.title_en}\n\n${(lang === 'zh' ? sec.zh : sec.en) || '（待写）'}\n`
  })].join('\n')
}

function savePaper(session, cfg, note) {
  const p = paperState(session)
  const dir = join(memoryDir(session, cfg), '论文初稿')
  const vdir = join(dir, `v${p.version}`)
  mkdirSync(vdir, { recursive: true })
  const en = assemble(p, 'en')
  const zh = assemble(p, 'zh')
  const review = [`# 审稿记录 v${p.version}`, '', `- ${new Date().toLocaleString('zh-CN')}　${note}`, '',
    ...asArray(p.outline?.sections).map((s) => {
      const sec = p.sections[s.id] || {}
      return `## ${s.id}\n- 审稿：${sec.verdict || '–'} ${sec.score ?? ''}　${asArray(sec.issues).join('；')}\n- 证据里找不到的数字：${asArray(sec.trace?.missing).join('、') || '无'}`
    })].join('\n')
  for (const [f, t] of [['paper_en.md', en], ['paper_zh.md', zh], ['REVIEW.md', review]]) writeFileSync(join(vdir, f), t)
  writeFileSync(join(dir, 'latest_en.md'), en)
  writeFileSync(join(dir, 'latest_zh.md'), zh)
  p.dir = dir
  p.savedAt = new Date().toISOString()
  persist(session)
}

/** 生成或重写整篇初稿（异步，不阻塞调用方）。 */
export function startDraft(session, cfg) {
  const p = paperState(session)
  if (p.running) throw new Error('该会话已有成稿任务在进行')
  const writers = workerLanes(cfg)
  const otherWriter = writer => writers.find(id => id !== writer) || writer
  p.running = 'draft'
  persist(session)
  void (async () => {
    const ask = makeAsk(session, cfg, null, null)
    try {
      plog(session, '成稿开始：总控 定大纲')
      const outline = parseJSON(await ask(controllerLane(cfg), 'paper-outline', outlinePrompt(session, writers), { maxTokens: 6000, temperature: 0.3 }))
      if (!outline || !asArray(outline.sections).length) throw new Error('大纲生成失败')
      outline.sections = asArray(outline.sections).slice(0, MAX_SECTIONS).map((s) => ({
        ...s, id: str(s.id).replace(/[^\w-]/g, '_') || 'section', writer: writers.includes(s.writer) ? s.writer : writers[0],
      }))
      p.version += 1
      p.outline = outline
      p.sections = {}
      persist(session)

      plog(session, `大纲 ${outline.sections.length} 节，分节写英文版`)
      await pool(outline.sections.map((s) => ({ lane: s.writer, s })), WRITER_CONCURRENCY, async ({ s }) => {
        const en = await ask(s.writer, `paper-en ${s.id}`, writePrompt(session, outline, s, 'en'), { maxTokens: 5000, temperature: 0.5, reasoning: 'medium' })
        p.sections[s.id] = { en: en || '', zh: '', writer: s.writer, translator: otherWriter(s.writer) }
        persist(session)
      })

      plog(session, '英文版完成，按英文稿生成对齐的中文版')
      await pool(outline.sections.map((s) => ({ lane: otherWriter(s.writer), s })), WRITER_CONCURRENCY, async ({ s }) => {
        const sec = p.sections[s.id]
        if (!sec?.en) return
        sec.zh = (await ask(sec.translator, `paper-zh ${s.id}`, writePrompt(session, outline, s, 'zh', sec.en), { maxTokens: 5000, temperature: 0.3, reasoning: 'medium' })) || ''
        persist(session)
      })

      await reviewAndRevise(session, cfg, ask, outline)
      savePaper(session, cfg, '初稿生成并经 总控 审稿修订')
      plog(session, `初稿 v${p.version} 完成，已存入 Obsidian：${p.dir}`)
    } catch (err) {
      plog(session, `✗ 成稿失败：${err.message}`)
    } finally {
      p.running = false
      persist(session)
    }
  })()
}

async function reviewAndRevise(session, cfg, ask, outline) {
  const p = paperState(session)
  const corpus = evidenceCorpus(session)
  const items = asArray(outline.sections).filter((s) => p.sections[s.id]?.en).map((s) => {
    const sec = p.sections[s.id]
    sec.trace = traceNumbers(`${sec.en}\n${sec.zh}`, corpus)
    return { id: s.id, en: sec.en, zh: sec.zh, trace: sec.trace }
  })
  plog(session, `数字核对：${items.reduce((a, x) => a + x.trace.missing.length, 0)} 个数字在证据里找不到；总控 审稿`)
  const review = parseJSON(await ask(controllerLane(cfg), 'paper-review', reviewPrompt(session, outline, items), { maxTokens: 6000, temperature: 0.2 }))
  p.reviews.push({ at: new Date().toISOString(), version: p.version, overall: str(review?.overall) })
  const revs = asArray(review?.sections)
  for (const r of revs) {
    const sec = p.sections[str(r.id)]
    if (!sec) continue
    Object.assign(sec, { verdict: str(r.verdict), score: r.score ?? null, issues: asArray(r.issues).map(str) })
  }
  const todo = revs.filter((r) => r.verdict === 'revise' && str(r.instruction).trim() && p.sections[str(r.id)])
  if (!todo.length) return
  plog(session, `${todo.length} 节需要修订`)
  await pool(todo.map((r) => ({ lane: p.sections[str(r.id)].writer, r })), WRITER_CONCURRENCY, async ({ r }) => {
    const id = str(r.id)
    const sec = p.sections[id]
    const s = outline.sections.find((x) => x.id === id)
    const en = await ask(sec.writer, `paper-revise ${id}`, revisePrompt(session, outline, s, sec.en, str(r.instruction), sec.trace), { maxTokens: 5000, temperature: 0.3, reasoning: 'medium' })
    if (!en) return
    sec.en = en
    const zh = await ask(sec.translator, `paper-zh ${id}`, writePrompt(session, outline, s, 'zh', en), { maxTokens: 5000, temperature: 0.3, reasoning: 'medium' })
    if (zh) sec.zh = zh
    sec.trace = traceNumbers(`${sec.en}\n${sec.zh}`, corpus)
    sec.revised = (sec.revised || 0) + 1
    persist(session)
  })
}

/* ───────────────────────── 人机审稿讨论窗 ───────────────────────── */

export function addComment(session, { sectionId, quote, text }) {
  const p = paperState(session)
  if (!p.outline) throw new Error('还没有初稿')
  if (!str(text).trim()) throw new Error('意见不能为空')
  const c = {
    id: `C${p.comments.length + 1}`, sectionId: str(sectionId) || 'general', quote: str(quote).slice(0, 1200),
    text: str(text).slice(0, 4000), status: 'open', at: new Date().toISOString(), thread: [],
  }
  p.comments.push(c)
  persist(session)
  return c
}

function proposePrompt(session, p, c, lane, other) {
  const sec = p.sections[c.sectionId] || {}
  return {
    system: `你是 ${laneName(lane)}，在处理用户（论文作者）对初稿的一条审稿意见。可选三种处理：
revise（改稿：给出修改后的整节英文）、experiment（补实验：给出能回答该意见的最小实验，由用户核验后执行）、
rebut（带证据反驳：意见不成立时，用可查证的证据说明原因）。出发点：哪种处理能让论文故事更好、更容易被接收。
${other ? '你已看到另一名模型的方案：如果对方更有理有据，就采纳或吸收；如果你坚持，要指出对方方案的具体问题。' : ''}
${WRITING_STYLE}
${HARD_LINES}
只输出一个 JSON 对象，无 markdown 围栏。`,
    user: `${contextBlock(session, null)}

【所在节】${c.sectionId}
【当前英文】
${String(sec.en || '').slice(0, 7000)}
【用户引用的句子】${c.quote || '（整节）'}
【用户意见】${c.text}
${other ? `\n【${laneName(other.lane)} 的方案】\n${JSON.stringify(other.json).slice(0, 5000)}` : ''}

输出：
{ "action": "revise / experiment / rebut", "reason": "≤150 字",
  "revised_en": "action=revise 时：修改后的整节英文", "experiment": "action=experiment 时：实验设计（对照、读出、判定标准、预算）",
  "rebuttal": "action=rebut 时：给用户的回复", "evidence": ["可查证的依据：数字、路径、回合编号"] }`,
  }
}

function decidePrompt(session, p, c, proposals) {
  return {
    system: `你是总控，对用户的这条审稿意见做最终决断。比较各执行者（各两轮、相互看过对方）的方案，
按"有理有据、能经得起查证、能让故事更好"选择处理方式，可以合并两方的优点。决断后系统会立即执行。
${WRITING_STYLE}
${HARD_LINES}
只输出一个 JSON 对象，无 markdown 围栏。`,
    user: `【所在节】${c.sectionId}
【当前英文】
${String(p.sections[c.sectionId]?.en || '').slice(0, 7000)}
【用户引用】${c.quote || '（整节）'}
【用户意见】${c.text}
${proposals.map((x) => `\n【${laneName(x.lane)} 第 ${x.round} 轮】\n${JSON.stringify(x.json).slice(0, 5000)}`).join('\n')}

输出：
{ "action": "revise / experiment / rebut", "why": "≤200 字：为什么这样处理、依据什么证据",
  "final_en": "action=revise 时：最终的整节英文", "experiment": "action=experiment 时：可核验的实验计划（具体可执行）",
  "reply_to_user": "给用户的简短回复（中文，说明怎么处理的）" }`,
  }
}

/** 处理全部未决意见（异步）。 */
export function startResolve(session, cfg) {
  const p = paperState(session)
  if (p.running) throw new Error('该会话已有成稿任务在进行')
  const open = p.comments.filter((c) => c.status === 'open')
  if (!open.length) throw new Error('没有未处理的意见')
  const writers = workerLanes(cfg)
  p.running = 'resolve'
  persist(session)
  void (async () => {
    const ask = makeAsk(session, cfg, null, null)
    const corpus = evidenceCorpus(session)
    try {
      for (const c of open) {
        c.status = 'discussing'
        persist(session)
        plog(session, `处理意见 ${c.id}（${c.sectionId}）：各执行者各提方案并相互说服`)
        const r1 = await Promise.all(writers.map(async (lane) => {
          const json = parseJSON(await ask(lane, `paper-comment ${c.id} r1`, proposePrompt(session, p, c, lane, null), { maxTokens: 5000, temperature: 0.4, reasoning: 'medium' }))
          return json ? { lane, round: 1, json } : null
        }))
        const ok1 = r1.filter(Boolean)
        const r2 = await Promise.all(ok1.map(async (mine) => {
          const other = ok1.find((x) => x.lane !== mine.lane)
          if (!other) return null
          const json = parseJSON(await ask(mine.lane, `paper-comment ${c.id} r2`, proposePrompt(session, p, c, mine.lane, other), { maxTokens: 5000, temperature: 0.4, reasoning: 'medium' }))
          return json ? { lane: mine.lane, round: 2, json } : null
        }))
        const proposals = [...ok1, ...r2.filter(Boolean)]
        c.thread = proposals.map((x) => ({ lane: x.lane, round: x.round, action: str(x.json.action), reason: str(x.json.reason), rebuttal: str(x.json.rebuttal), experiment: str(x.json.experiment), evidence: asArray(x.json.evidence).map(str) }))
        const d = parseJSON(await ask(controllerLane(cfg), `paper-decide ${c.id}`, decidePrompt(session, p, c, proposals), { maxTokens: 6000, temperature: 0.2 }))
        if (!d) { c.status = 'open'; plog(session, `✗ ${c.id} 决断失败，保留为未决`); continue }
        c.decision = { action: str(d.action), why: str(d.why), reply: str(d.reply_to_user), at: new Date().toISOString() }
        const sec = p.sections[c.sectionId]
        if (d.action === 'revise' && sec && str(d.final_en).trim()) {
          sec.en = str(d.final_en)
          const s = asArray(p.outline?.sections).find((x) => x.id === c.sectionId) || { id: c.sectionId, title_en: c.sectionId, title_zh: c.sectionId }
          const zh = await ask(writers.includes(sec.translator) ? sec.translator : writers[0], `paper-zh ${c.sectionId}`, writePrompt(session, p.outline, s, 'zh', sec.en), { maxTokens: 5000, temperature: 0.3, reasoning: 'medium' })
          if (zh) sec.zh = zh
          sec.trace = traceNumbers(`${sec.en}\n${sec.zh}`, corpus)
          c.status = 'revised'
        } else if (d.action === 'experiment' && str(d.experiment).trim()) {
          queueMessage(session, `[审稿意见 ${c.id} 补实验] 用户对「${c.sectionId}」提出：${c.text}\n总控决断：${str(d.why)}\n请整理以下实验的可复现方案及验收标准：\n${str(d.experiment)}`, cfg, { auto: true })
          c.status = 'experiment'
        } else {
          c.status = 'rebutted'
        }
        plog(session, `${c.id} → ${({ revised: '已改稿', experiment: '已排实验方案', rebutted: '带证据回复' })[c.status]}`)
        persist(session)
      }
      p.version += 1
      savePaper(session, cfg, `处理 ${open.length} 条用户审稿意见`)
    } catch (err) {
      plog(session, `✗ 处理意见失败：${err.message}`)
      for (const c of open) if (c.status === 'discussing') c.status = 'open'
    } finally {
      p.running = false
      persist(session)
    }
  })()
}

export function publicPaper(session) {
  const p = paperState(session)
  return {
    version: p.version, outline: p.outline, sections: p.sections, comments: p.comments, reviews: p.reviews.slice(-5),
    running: p.running, log: p.log.slice(-30), dir: p.dir || null, savedAt: p.savedAt || null,
  }
}
