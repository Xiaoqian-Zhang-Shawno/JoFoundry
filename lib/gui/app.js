/* 三模型圆桌 · 控制台前端（无框架、无构建） */
const API = './api'
const PHASES = [
  ['brief', '简报'], ['position', '立场'], ['rebuttal', '反驳'],
  ['review', '审稿'], ['ac', '合议'], ['plan', '计划'],
]
const LANE_LABEL = { deepseek: 'DeepSeek', claude: 'Claude Opus 5.5', chatgpt: 'ChatGPT' }

const $ = (s) => document.querySelector(s)
const el = (tag, cls, html) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let state = { currentJob: null, timer: null, lastTranscript: 0, tab: 'plan', planMarkdown: '', donePlanRun: null }

function toast(msg, ms = 4200) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), ms)
}

/* ── markdown-lite ── */
function md(src) {
  const lines = String(src || '').split('\n')
  const out = []
  let inList = false
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*$/.test(line)) { if (inList) { out.push('</ul>'); inList = false } continue }
    let m
    if ((m = line.match(/^#\s+(.*)$/))) { if (inList) { out.push('</ul>'); inList = false } out.push(`<h3>${inline(m[1])}</h3>`); continue }
    if ((m = line.match(/^##\s+(.*)$/))) { if (inList) { out.push('</ul>'); inList = false } out.push(`<h3>${inline(m[1])}</h3>`); continue }
    if ((m = line.match(/^###\s+(.*)$/))) { if (inList) { out.push('</ul>'); inList = false } out.push(`<h4>${inline(m[1])}</h4>`); continue }
    if ((m = line.match(/^>\s?(.*)$/))) { if (inList) { out.push('</ul>'); inList = false } out.push(`<div class="quote">${inline(m[1])}</div>`); continue }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(m[1])}</li>`)
      continue
    }
    if (inList) { out.push('</ul>'); inList = false }
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

/* ── 状态渲染 ── */
async function loadState() {
  try {
    const r = await fetch(`${API}/state`).then((x) => x.json())
    if (!r.ok) throw new Error(r.error || 'state failed')
    renderLanes(r.lanes)
    $('#cfgPath').textContent = r.configPath || ''
    $('#cfgPath').title = r.configPath || ''
    renderRuns(r.jobs || [], r.runs || [])
    if (!state.currentJob) {
      const running = (r.jobs || []).find((j) => j.status === 'running')
      const latestJob = (r.jobs || []).find((j) => j.status === 'done')
      if (running) selectJob(running.id)
      else if (latestJob) selectJob(latestJob.id)
      else if ((r.jobs || []).length) selectJob(r.jobs[0].id)
      else if ((r.runs || []).length) openRun(r.runs[0].id)
    }
    if (r.venue && !$('#venue').dataset.touched) $('#venue').value = (r.venue || '').toLowerCase().replace(/[^a-z]/g, '') || 'neurips'
  } catch (err) {
    toast('无法连接插件接口：' + err.message)
  }
}

function renderLanes(lanes) {
  const box = $('#lanes')
  box.innerHTML = ''
  for (const [key, lane] of Object.entries(lanes || {})) {
    const chip = el('div', 'lane-chip')
    chip.appendChild(el('span', 'dot ' + (lane.enabled ? (lane.hasKey ? 'on' : 'off') : 'off')))
    chip.appendChild(el('span', null, `${esc(lane.label)}`))
    chip.appendChild(el('span', 'dim', esc(lane.model || (lane.kind === 'codex' ? 'codex' : ''))))
    box.appendChild(chip)
  }
}

function renderRuns(jobs, runs) {
  const ul = $('#runList')
  ul.innerHTML = ''
  const items = []
  for (const j of jobs) items.push({ kind: 'job', id: j.id, status: j.status, title: j.topic, meta: `${j.mode || 'paper'} · ${j.venue || '–'} · ${j.phase}` })
  for (const r of runs.slice(0, 15)) items.push({ kind: 'run', id: r.id, status: 'done', title: r.topIdea || r.topic, meta: `历史 · ${r.mode || 'paper'} · ${r.venue || '–'}` })
  if (!items.length) { ul.appendChild(el('li', 'dim', '还没有记录')); return }
  for (const it of items) {
    const li = el('li')
    if (state.currentJob && state.currentJob === it.id) li.classList.add('active')
    li.appendChild(el('div', 't', esc(it.title || '(无标题)')))
    const m = el('div', 'm')
    m.appendChild(el('span', 'badge ' + it.status, it.status))
    m.appendChild(el('span', null, esc(it.meta)))
    li.appendChild(m)
    li.onclick = () => {
      if (it.kind === 'job') { selectJob(it.id) } else { openRun(it.id) }
    }
    ul.appendChild(li)
  }
}

/* ── 会话 ── */
async function startRun(ev) {
  ev.preventDefault()
  const topic = $('#topic').value.trim()
  if (!topic) { $('#formMsg').className = 'msg err'; $('#formMsg').textContent = '先写一个方向'; return }
  const body = {
    topic,
    venue: $('#venue').value,
    mode: $('#mode').value,
    field: $('#field').value,
    constraints: $('#constraints').value,
    deadline: $('#deadline').value,
    anchors: $('#anchors').value,
  }
  $('#startBtn').disabled = true
  $('#formMsg').className = 'msg'
  $('#formMsg').textContent = '正在召集…'
  try {
    const r = await fetch(`${API}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
    if (!r.ok) throw new Error(r.error || 'start failed')
    $('#formMsg').className = 'msg ok'
    $('#formMsg').textContent = `已开始：${r.jobId}`
    $('#cancelBtn').disabled = false
    selectJob(r.jobId)
    loadState()
  } catch (err) {
    $('#formMsg').className = 'msg err'
    $('#formMsg').textContent = err.message
    $('#startBtn').disabled = false
  }
}

function selectJob(id) {
  state.currentJob = id
  state.lastTranscript = 0
  state.planMarkdown = ''
  state.donePlanRun = null
  $('#transcript').innerHTML = ''
  $('#sessionTitle').textContent = '讨论进行中…'
  $('#sessionMeta').textContent = ''
  $('#tabbody').innerHTML = '<p class="dim">讨论结束后在这里生成。</p>'
  poll()
  clearInterval(state.timer)
  state.timer = setInterval(poll, 2500)
}

async function poll() {
  if (!state.currentJob) return
  try {
    const r = await fetch(`${API}/run?jobId=${encodeURIComponent(state.currentJob)}`).then((x) => x.json())
    if (!r.ok) throw new Error(r.error || 'poll failed')
    renderJob(r.job)
  } catch (err) {
    clearInterval(state.timer)
    toast('轮询失败：' + err.message)
  }
}

function renderJob(job) {
  const running = job.status === 'running'
  $('#sessionTitle').textContent = job.input?.topic || ''
  $('#sessionMeta').textContent = `${job.venue || '–'} · ${job.mode} · ${job.status}${job.runId ? ' · ' + job.runId : ''}`
  $('#startBtn').disabled = running
  $('#cancelBtn').disabled = !running
  if (job.status === 'done') { clearInterval(state.timer); loadState() }
  if (job.status === 'failed') {
    clearInterval(state.timer)
    $('#formMsg').className = 'msg err'
    $('#formMsg').textContent = job.error || '运行失败'
  }

  renderSteps(job.phase, job.status)
  renderTranscript(job)
  renderTab(job)

  if (job.status === 'done' && job.runId && state.donePlanRun !== job.runId) {
    state.donePlanRun = job.runId
    loadPlanFile(job.runId)
  }
}

function renderSteps(phase, status) {
  const box = $('#phaseSteps')
  box.innerHTML = ''
  const order = PHASES.map(([k]) => k)
  const cur = order.indexOf(phase)
  for (const [key, label] of PHASES) {
    const i = order.indexOf(key)
    let cls = 'step'
    if (phase === 'done' || (cur > i && cur >= 0)) cls += ' done'
    if (cur === i && status === 'running') cls += ' current'
    box.appendChild(el('span', cls, label))
  }
}

function laneClass(entry) {
  const lane = entry.lane || ''
  return 'lane-' + (['deepseek', 'claude', 'chatgpt'].includes(lane) ? lane : 'lead')
}

function renderTranscript(job) {
  const box = $('#transcript')
  const list = job.transcript || []
  if (!list.length) {
    if (job.status === 'running') {
      box.innerHTML = `<div class="typing">${esc(job.phase)} 阶段，模型正在思考<i></i><i></i><i></i></div>`
    }
    return
  }
  // 增量渲染：只追加新条目
  if (state.lastTranscript > list.length) { box.innerHTML = ''; state.lastTranscript = 0 }
  for (let i = state.lastTranscript; i < list.length; i += 1) {
    const t = list[i]
    if (i === 0 || list[i - 1].phase !== t.phase) {
      const label = (PHASES.find(([k]) => k === t.phase) || [null, t.phase])[1]
      box.appendChild(el('div', 'phase-break', esc(label)))
    }
    const card = el('div', 'turn ' + laneClass(t))
    const head = el('div', 'turn-head')
    head.appendChild(el('span', 'turn-who', esc(t.role || t.lane || '')))
    if (t.lane) head.appendChild(el('span', 'dim', esc(t.lane)))
    card.appendChild(head)
    card.appendChild(el('div', 'turn-say', renderTurnText(t.text)))
    box.appendChild(card)
  }
  state.lastTranscript = list.length
  if (job.status === 'running') {
    box.appendChild(el('div', 'typing', `${esc(job.phase)} 阶段，模型正在思考<i></i><i></i><i></i>`))
    setTimeout(() => { box.querySelectorAll('.typing').forEach((n, idx, all) => { if (idx < all.length - 1) n.remove() }) }, 0)
  }
  box.scrollTop = box.scrollHeight
}

function renderTurnText(text) {
  const lines = String(text || '').split('\n')
  return lines.map((line) => {
    const m = line.match(/^\*\*(.+?)\*\*：(.*)$/)
    if (m) return `<span class="kv"><strong>${esc(m[1])}</strong>：${esc(m[2])}</span>`
    if (/^\s+[-*]\s+/.test(line)) return `<span class="kv" style="padding-left:14px">${esc(line.trim())}</span>`
    return esc(line)
  }).join('\n')
}

async function loadPlanFile(runId) {
  try {
    const r = await fetch(`${API}/file?runId=${encodeURIComponent(runId)}&file=plan.md`).then((x) => x.json())
    if (r.ok) { state.planMarkdown = r.content; if (state.tab === 'plan') renderTabFromState() }
  } catch { /* 忽略 */ }
}

function renderTab(job) {
  if (state.tab === 'events') {
    const box = $('#tabbody')
    box.innerHTML = '<div class="events"></div>'
    const e = box.querySelector('.events')
    for (const line of job.events || []) e.appendChild(el('div', null, esc(line)))
    box.scrollTop = box.scrollHeight
    return
  }
  if (state.tab === 'reviews') {
    renderReviews(job.reviews || [], job.acDecision)
    return
  }
  if (state.tab === 'brief') {
    $('#tabbody').innerHTML = job.brief ? md(renderJsonish(job.brief)) : '<p class="dim">简报还没生成。</p>'
    return
  }
  if (state.tab === 'plan') {
    if (state.planMarkdown) { $('#tabbody').innerHTML = md(state.planMarkdown); return }
    if (job.plan && job.status === 'done') { $('#tabbody').innerHTML = md(renderPlanFromJson(job.plan)); return }
    $('#tabbody').innerHTML = '<p class="dim">讨论结束后在这里生成作战计划。</p>'
  }
}

function renderTabFromState() {
  if (state.tab === 'plan' && state.planMarkdown) $('#tabbody').innerHTML = md(state.planMarkdown)
}

function renderReviews(reviews, ac) {
  const box = $('#tabbody')
  box.innerHTML = ''
  if (ac) {
    box.appendChild(el('div', null, md(renderAcFromJson(ac))))
  }
  if (!reviews.length) {
    box.appendChild(el('p', 'dim', '审稿意见还没生成。'))
    return
  }
  for (const rv of reviews) {
    const s = rv.scores || {}
    const wrap = el('div', 'turn ' + laneClass({ lane: rv._lane }))
    wrap.appendChild(el('div', 'turn-head', `<span class="turn-who">${esc(rv.persona || '审稿人')}</span>`))
    const scores = el('div', 'score-row')
    for (const key of ['novelty', 'rigor', 'impact', 'clarity', 'overall']) {
      if (s[key] != null) scores.appendChild(el('span', 'score', `${key} ${s[key]}`))
    }
    if (rv.verdict) scores.appendChild(el('span', 'score', esc(rv.verdict)))
    wrap.appendChild(scores)
    wrap.appendChild(el('div', 'turn-say', md([
      rv.summary ? `**复述**：${rv.summary}` : '',
      (rv.strengths || []).length ? '**优点**：\n' + rv.strengths.map((x) => `- ${x}`).join('\n') : '',
      (rv.weaknesses || []).length ? '**问题**：\n' + rv.weaknesses.map((x) => `- ${x}`).join('\n') : '',
      (rv.fatal_if_unaddressed || []).length ? '**不补就拒**：\n' + rv.fatal_if_unaddressed.map((x) => `- ${x}`).join('\n') : '',
      (rv.required_experiments || []).length ? '**补做实验**：\n' + rv.required_experiments.map((x) => `- ${x}`).join('\n') : '',
    ].filter(Boolean).join('\n'))))
    box.appendChild(wrap)
  }
}

function renderAcFromJson(ac) {
  const scores = (ac.scores_table || []).map((s) => `${s.persona}: ${s.overall}（${s.verdict}）`).join(' · ')
  return [
    '## AC 合议',
    scores ? `**打分**：${scores}` : '',
    ac.ac_decision ? `**判断**：${ac.ac_decision}` : '',
    (ac.consensus_weaknesses || []).length ? '**共识问题**：\n' + ac.consensus_weaknesses.map((x) => `- ${x}`).join('\n') : '',
    ac.decisive_experiment ? `**决胜实验**：${ac.decisive_experiment}` : '',
  ].filter(Boolean).join('\n\n')
}

function renderJsonish(obj) {
  if (!obj || typeof obj !== 'object') return String(obj)
  const lines = []
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) lines.push(`**${k}**：\n${v.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')}`)
    else if (v && typeof v === 'object') lines.push(`**${k}**：\n${renderJsonish(v)}`)
    else lines.push(`**${k}**：${v}`)
  }
  return lines.join('\n\n')
}

function renderPlanFromJson(p) {
  return [
    '# 作战计划',
    p.one_sentence_claim ? `> ${p.one_sentence_claim}` : '',
    (p.title_candidates || []).length ? '## 候选标题\n' + p.title_candidates.map((t) => `- ${t}`).join('\n') : '',
    (p.contributions || []).length ? '## 贡献\n' + p.contributions.map((c, i) => `${i + 1}. ${c}`).join('\n') : '',
    (p.next_three_actions || []).length ? '## 接下来 72 小时\n' + p.next_three_actions.map((a, i) => `${i + 1}. ${a}`).join('\n') : '',
  ].filter(Boolean).join('\n\n')
}

async function openRun(runId) {
  state.currentJob = null
  clearInterval(state.timer)
  $('#sessionTitle').textContent = runId
  $('#sessionMeta').textContent = '历史运行（只读）'
  $('#transcript').innerHTML = '<p class="dim">正在载入历史讨论…</p>'
  try {
    const t = await fetch(`${API}/file?runId=${encodeURIComponent(runId)}&file=transcript.md`).then((x) => x.json())
    if (t.ok) $('#transcript').innerHTML = md(t.content)
  } catch { /* 忽略 */ }
  state.planMarkdown = ''
  await loadPlanFile(runId)
  state.tab = 'plan'
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'plan'))
  renderTabFromState()
  if (!state.planMarkdown) $('#tabbody').innerHTML = '<p class="dim">这次运行没有 plan.md。</p>'
}

/* ── 交互 ── */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.onclick = () => {
    state.tab = btn.dataset.tab
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn))
    if (state.currentJob) poll()
    else renderTabFromState()
  }
})
$('#runForm').addEventListener('submit', startRun)
$('#venue').addEventListener('change', (e) => { e.target.dataset.touched = '1' })
$('#cancelBtn').onclick = async () => {
  if (!state.currentJob) return
  await fetch(`${API}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: state.currentJob }) })
  toast('已请求停止')
}
$('#probeBtn').onclick = async () => {
  toast('正在探测三条线路（ChatGPT 走 codex，可能要 1-2 分钟）…', 8000)
  try {
    const r = await fetch(`${API}/probe`, { method: 'POST' }).then((x) => x.json())
    const lines = Object.entries(r.result || {}).map(([k, v]) => `${v.ok ? '✓' : '✗'} ${k}: ${v.ok ? v.model + ' ' + v.ms + 'ms' : v.error}`)
    toast(lines.join('\n'), 12000)
    loadState()
  } catch (err) { toast('探测失败：' + err.message) }
}

loadState()
setInterval(() => { if (!state.currentJob) loadState() }, 8000)
