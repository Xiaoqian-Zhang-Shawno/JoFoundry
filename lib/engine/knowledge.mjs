/**
 * 经验知识库：把用户显式提供的工作宪法、实验准则、审核规则和 skill 库
 * 交给总控 总控 先读一遍，提炼成「执行判断手册」，之后每个回合都带着它做判断。
 *
 *   sources   原文（AGENTS.md / 实验训练准则 / 贡献审核规则 / oral-paper-skill）
 *   skills    ~/.codex/skills/<name>/SKILL.md 的 name + description 索引（供总控按需挑选）
 *   digest    总控读完全部原文后写的手册；按源文件 mtime/size 缓存，源变了自动重读
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { callLane } from './lanes.mjs'
import { FOUNDRY_HOME, controllerLane } from './config.mjs'

const HOME = homedir()
export const SKILLS_DIR = process.env.FOUNDRY_SKILLS_DIR || join(FOUNDRY_HOME, 'skills')
const CACHE_DIR = join(FOUNDRY_HOME, 'knowledge')

/** 需要 总控 精读全文的科研相关 skill（其余 skill 只进索引）；config.json 的 knowledge.deepSkills 可覆盖。 */
export const DEFAULT_DEEP_SKILLS = []

/** 默认读取的经验原文；config.json 的 knowledge.extraSources 可追加。 */
export function knowledgeSources(cfg) {
  const base = []
  const extra = (cfg?.knowledge?.extraSources || []).map((p, i) => ({
    key: `extra-${i}`, title: String(p), path: String(p).replace(/^~(?=\/|$)/, HOME),
  }))
  return [...base, ...extra].map((s) => {
    try {
      const st = statSync(s.path)
      return { ...s, exists: st.isFile(), size: st.size, mtime: st.mtimeMs }
    } catch { return { ...s, exists: false } }
  })
}

export function readSource(s, limit = 40_000) {
  if (!s.exists) return ''
  const text = readFileSync(s.path, 'utf8')
  return text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text
}

/* ───────────────────────── skill 索引 ───────────────────────── */

/** 解析 SKILL.md frontmatter 的 description（支持单行与 >- / | 折叠块）。 */
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const lines = m[1].split('\n')
  const out = {}
  for (let i = 0; i < lines.length; i += 1) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/)
    if (!kv) continue
    let [, k, v] = kv
    if (/^[>|][+-]?$/.test(v.trim())) {
      const block = []
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[(i += 1)].trim())
      v = block.join(' ')
    }
    out[k] = v.replace(/^['"]|['"]$/g, '').trim()
  }
  return out
}

let skillCache = null
export function listSkills() {
  if (skillCache) return skillCache
  const out = []
  let names = []
  try { names = readdirSync(SKILLS_DIR) } catch { return (skillCache = []) }
  for (const name of names.sort()) {
    const p = join(SKILLS_DIR, name, 'SKILL.md')
    if (!existsSync(p)) continue
    try {
      const fm = parseFrontmatter(readFileSync(p, 'utf8').slice(0, 4000))
      out.push({ name: fm.name || name, dir: name, description: fm.description || '' })
    } catch { /* 跳过坏文件 */ }
  }
  return (skillCache = out)
}

/** 给总控挑 skill 用的紧凑索引：每行 name：描述前 N 字。 */
export function skillIndexText(max = 80) {
  return listSkills().map((s) => `- ${s.name}：${s.description.slice(0, max)}`).join('\n')
}

/** 按名字载入若干 skill 的正文（截断），供执行者参考。 */
export function loadSkillBodies(names, limit = 6000) {
  const byName = new Map(listSkills().map((s) => [s.name, s]))
  const out = []
  for (const n of [...new Set((names || []).map(String))].slice(0, 3)) {
    const s = byName.get(n)
    if (!s) continue
    try {
      let text = readFileSync(join(SKILLS_DIR, s.dir, 'SKILL.md'), 'utf8')
      if (text.length > limit) text = text.slice(0, limit) + '\n…（已截断）'
      out.push({ name: s.name, text })
    } catch { /* ignore */ }
  }
  return out
}

/* ───────────────────────── 手册（digest） ───────────────────────── */

function deepSkillFiles(cfg) {
  const names = cfg?.knowledge?.deepSkills || DEFAULT_DEEP_SKILLS
  const byName = new Map(listSkills().map((s) => [s.name, s]))
  return names.map((n) => byName.get(n)).filter(Boolean).map((s) => {
    const path = join(SKILLS_DIR, s.dir, 'SKILL.md')
    try { const st = statSync(path); return { name: s.name, path, size: st.size, mtime: st.mtimeMs } } catch { return null }
  }).filter(Boolean)
}

function sourcesKey(sources, deep = []) {
  const h = createHash('sha1')
  for (const s of sources) h.update(`${s.path}|${s.exists ? `${s.size}|${s.mtime}` : 'missing'}\n`)
  for (const d of deep) h.update(`${d.path}|${d.size}|${d.mtime}\n`)
  h.update(`skills:${listSkills().length}`)
  return h.digest('hex').slice(0, 16)
}

/** 把精读 skill 按 ~100k 字符分批，每批让总控 写一份经验笔记（map 阶段）。 */
function skillBatches(deep, limit = 100_000) {
  const batches = []
  let cur = []
  let size = 0
  for (const d of deep) {
    let text = ''
    try { text = readFileSync(d.path, 'utf8') } catch { continue }
    if (text.length > 30_000) text = text.slice(0, 30_000) + '\n…（已截断）'
    if (size + text.length > limit && cur.length) { batches.push(cur); cur = []; size = 0 }
    cur.push({ name: d.name, text })
    size += text.length
  }
  if (cur.length) batches.push(cur)
  return batches
}

function skillNotesPrompt(batch) {
  return {
    system: `你是总控，多 Agent 科研协作的总控。下面是用户显式提供的若干科研 skill 全文。
逐个读完，为每个 skill 写经验笔记：何时调用、核心做法、硬约束/红线、常见翻车点。只写原文有的内容，不编造。`,
    user: `${batch.map((b) => `===== skill: ${b.name} =====\n${b.text}`).join('\n\n')}

用 markdown 输出，每个 skill 一个 "### 名称" 小节，每节 ≤ 220 字。`,
  }
}

function digestPrompt(sources, notes = '') {
  const system = `你是总控，多 Agent 科研协作的总控。下面是用户显式提供的工作宪法、
实验训练准则、贡献审核规则、oral-paper-skill 与 skill 库清单——这是用户最看重的执行判断经验。
请完整阅读后，写一份你作为总控时随身携带的《执行判断手册》。要求：
- 保留所有硬约束的具体数字与条件（如参数量阈值、epoch 下限、checkpoint 选择规则、十轮/票数门槛、保留不计积极等），不得改写含义。
- 区分「硬约束（必须遵守）」与「判断经验（指导取舍）」。
- 用户的项目级约定优先于通用约定；冲突处写明优先级。
- 不编造原文没有的规则。`
  const user = `${sources.filter((s) => s.exists).map((s) => `===== ${s.title} =====\n${readSource(s)}`).join('\n\n')}

${notes ? `===== 科研 skill 精读笔记 =====\n${notes}\n\n` : ''}===== skill 库清单（${listSkills().length} 个，name：描述） =====
${skillIndexText(60)}

用 markdown 输出《执行判断手册》（≤ 3500 字），小节固定为：
## 1. 判断原则与优先级
## 2. 科研想法与贡献评审要点
## 3. 实验与训练硬约束
## 4. 贡献审核门槛（仅保留用户原文已有规则）
## 5. 诚信与隐私红线
## 6. skill 路由建议（按任务类型列出最该调用的 skill 名，10-20 个）
## 7. 给执行者的工作要求`
  return { system, user }
}

let digestPromise = null
/** 手册构建进度（给 GUI / 状态端口看）。 */
export const digestLog = []
export const isDigestBuilding = () => Boolean(digestPromise)

/** 取手册：命中缓存直接返回；否则让总控 读原文重写。force=true 强制重读。 */
export async function getDigest(cfg, { force = false, signal, onProgress: userProgress = () => {} } = {}) {
  const onProgress = (msg) => {
    digestLog.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
    if (digestLog.length > 50) digestLog.splice(0, digestLog.length - 50)
    userProgress(msg)
  }
  const sources = knowledgeSources(cfg)
  const deep = deepSkillFiles(cfg)
  const key = sourcesKey(sources, deep)
  const file = join(CACHE_DIR, 'digest.json')
  if (!force) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8'))
      if (cached.key === key && cached.text) return cached
    } catch { /* 无缓存 */ }
  }
  if (digestPromise) return digestPromise
  digestPromise = (async () => {
    const mock = process.env.FOUNDRY_MOCK === '1'
    const batches = skillBatches(deep)
    const notes = []
    for (const [i, batch] of batches.entries()) {
      onProgress(`精读 skill 第 ${i + 1}/${batches.length} 批：${batch.map((b) => b.name).join(', ')}`)
      const sp = skillNotesPrompt(batch)
      try {
        const r = mock
          ? { text: batch.map((b) => `### ${b.name}\nmock 笔记`).join('\n') }
          : await callLane(controllerLane(cfg), cfg, { system: sp.system, user: sp.user, maxTokens: 6000, temperature: 0.2 }, { signal })
        notes.push(r.text)
      } catch (err) { onProgress(`第 ${i + 1} 批精读失败：${err.message}（跳过）`) }
    }
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(join(CACHE_DIR, 'skill-notes.md'), notes.join('\n\n') + '\n')
    onProgress('写《执行判断手册》')
    const p = digestPrompt(sources, notes.join('\n\n'))
    const res = mock
      ? { text: '## 1. 判断原则与优先级\nmock 手册', model: 'mock', ms: 1 }
      : await callLane(controllerLane(cfg), cfg, { system: p.system, user: p.user, maxTokens: 7000, temperature: 0.2 }, { signal })
    const out = {
      key, text: res.text, model: res.model, ms: res.ms, builtAt: new Date().toISOString(),
      sources: sources.map(({ key: k, title, path, exists, size }) => ({ key: k, title, path, exists, size })),
      skills: listSkills().length, deepSkills: deep.map((d) => d.name),
    }
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
    writeFileSync(join(CACHE_DIR, 'digest.md'), out.text + '\n')
    return { ...out, justBuilt: true }
  })()
  try { return await digestPromise } finally { digestPromise = null }
}

/** 不触发重建，只报告状态（给 GUI）。 */
export function digestStatus(cfg) {
  const sources = knowledgeSources(cfg)
  const deep = deepSkillFiles(cfg)
  const key = sourcesKey(sources, deep)
  let cached = null
  try { cached = JSON.parse(readFileSync(join(CACHE_DIR, 'digest.json'), 'utf8')) } catch { /* none */ }
  return {
    fresh: Boolean(cached && cached.key === key), builtAt: cached?.builtAt || null, model: cached?.model || null,
    text: cached?.text || '', skills: listSkills().length, deepSkills: deep.map((d) => d.name),
    building: isDigestBuilding(), log: digestLog.slice(-12),
    sources: sources.map(({ key: k, title, path, exists, size }) => ({ key: k, title, path, exists, size })),
  }
}

/** oral-paper-skill 原文 + 用户审核规则：评审员的共同评审依据。 */
export function oralRubric(cfg) {
  const want = { 'oral-skill': 9000, 'oral-archetypes': 4000, 'oral-practices': 7000, 'oral-scorecard': 3000, 'review-policy': 3000 }
  return knowledgeSources(cfg)
    .filter((s) => s.key in want && s.exists)
    .map((s) => `===== ${s.title} =====\n${readSource(s, want[s.key])}`)
    .join('\n\n')
}
