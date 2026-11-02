/* 总控协作 · 前端（无框架、无构建） */
const API = './api/cmd'
const PHASES = [['knowledge', '读手册'], ['plan', '派活'], ['pipeline', '流水线'], ['debate', '说服'], ['final', '综合'], ['oral', '贡献评审'], ['memory', '存记忆'], ['next', '主线判断']]
const KIND_LABEL = { debate: '说服', 'debate-open': '分歧', plan: '派活', report: '汇报', cross: '互审', judge: '裁决', final: '综合答复', oral: '贡献评审', knowledge: '经验手册' }
const LANES = ['claude', 'deepseek', 'chatgpt']
const TASK_ST = { queued: '排队', running: '进行中', reported: '待裁', judging: '裁决中', judged: '已裁', failed: '失败' }

const $ = (s) => document.querySelector(s)
const el = (tag, cls, html) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html != null) n.innerHTML = html
  return n
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let state = {
  sid: null, session: null, timer: null, tab: 'final', template: 'free', templates: {}, rendered: '',
  oralCfg: { rounds: 10, threshold: 24 }, statusAnswer: '', statusBusy: false,
}

function toast(msg, ms = 4200) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), ms)
}

async function api(path, body) {
  const r = await fetch(`${API}/${path}`, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined).then((x) => x.json())
  if (!r.ok) throw new Error(r.error || 'request failed')
  return r
}

/* ── markdown-lite（标题/列表/有序列表/粗体/代码/引用） ── */
function md(src) {
  const out = []
  let list = null
  const close = () => { if (list) { out.push(`</${list}>`); list = null } }
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  for (const raw of String(src || '').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    let m
    if (!line.trim()) { close(); continue }
    if ((m = line.match(/^#{1,2}\s+(.*)$/))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); continue }
    if ((m = line.match(/^#{3,6}\s+(.*)$/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); continue }
    if ((m = line.match(/^>\s?(.*)$/))) { close(); out.push(`<div class="quote">${inline(m[1])}</div>`); continue }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inline(m[1])}</li>`); continue
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inline(m[1])}</li>`); continue
    }
    close()
    out.push(`<p>${inline(line)}</p>`)
  }
  close()
  return out.join('\n')
}

/* ── 元信息 ── */
async function loadMeta() {
  try {
    const r = await api('meta')
    state.templates = r.templates
    state.oralCfg = r.oral || state.oralCfg
    renderLanes(r.lanes)
    renderSessions(r.sessions)
    renderKbInfo(r.knowledge)
    const sel = $('#venue')
    if (!sel.options.length) {
      for (const [k, v] of Object.entries(r.venues)) sel.appendChild(new Option(v, k))
      sel.value = 'generic'
    }
    const row = $('#tplRow')
    if (!row.children.length) {
      for (const [k, v] of Object.entries(r.templates)) {
        const b = el('span', 'tpl' + (k === state.template ? ' active' : ''), esc(v))
        b.onclick = () => {
          state.template = k
          row.querySelectorAll('.tpl').forEach((n) => n.classList.toggle('active', n === b))
        }
        row.appendChild(b)
      }
    }
    if (!state.sid && r.sessions.length) openSession(r.sessions[0].id)
    else if (state.sid && !state.timer && r.sessions.find((s) => s.id === state.sid && (s.status === 'running' || s.oralRunning || s.autopilot))) openSession(state.sid)
  } catch (err) { toast('无法连接服务：' + err.message) }
}

function renderKbInfo(k) {
  if (!k) return
  $('#kbInfo').textContent = k.building
    ? `正在重读… ${(k.log || []).slice(-1)[0] || ''}`
    : k.builtAt
      ? `${k.fresh ? '最新' : '源文件有更新，下回合自动重读'} · ${k.builtAt.slice(0, 16).replace('T', ' ')} · 原文 ${k.sources.filter((s) => s.exists).length} 份 · skill ${k.skills} 个（精读 ${(k.deepSkills || []).length}）`
      : `尚未生成：第一个回合开始时 Claude 会先读完 ChatGPT 的 AGENTS.md、实验准则与 ${k.skills} 个 skill（首次约需几分钟）`
}

function renderLanes(lanes) {
  const box = $('#lanes')
  box.innerHTML = ''
  const role = { claude: '总控', deepseek: '执行', chatgpt: '执行' }
  for (const [key, lane] of Object.entries(lanes || {})) {
    const chip = el('div', 'lane-chip')
    chip.dataset.lane = key
    chip.appendChild(el('span', 'dot ' + (lane.enabled && lane.hasKey ? 'on' : 'off')))
    chip.appendChild(el('span', null, `${esc(role[key] || '')} · ${esc(lane.label)}`))
    chip.appendChild(el('span', 'dim busy-tag', ''))
    box.appendChild(chip)
  }
}

function renderBusy(busy) {
  document.querySelectorAll('.lane-chip').forEach((chip) => {
    const tags = (busy || {})[chip.dataset.lane] || []
    const t = chip.querySelector('.busy-tag')
    if (t) t.textContent = tags.length ? `忙：${tags.length > 1 ? `${tags.length} 项` : tags[0]}` : '空闲'
  })
}

function renderSessions(list) {
  const ul = $('#sessionList')
  ul.innerHTML = ''
  if (!list.length) { ul.appendChild(el('li', 'dim', '还没有会话')); return }
  for (const s of list) {
    const li = el('li')
    if (s.id === state.sid) li.classList.add('active')
    li.appendChild(el('div', 't', esc(s.title)))
    const m = el('div', 'm')
    m.appendChild(el('span', 'badge ' + s.status, s.status === 'running' ? '进行中' : s.status === 'interrupted' ? '中断' : '空闲'))
    if (s.autopilot) m.appendChild(el('span', 'badge running', '续航'))
    if (s.oralRunning) m.appendChild(el('span', 'badge running', '评审中'))
    m.appendChild(el('span', null, `${esc(s.venue)} · ${s.turns} 回合 · CCF-A ${s.progress ?? 0}%`))
    li.appendChild(m)
    li.appendChild(el('div', 'ccfa-mini', `<i style="width:${s.progress ?? 0}%"></i>`))
    li.onclick = () => openSession(s.id)
    ul.appendChild(li)
  }
}

/* ── 会话 ── */
function openSession(id) {
  if (state.sid !== id) { state.rendered = ''; $('#feed').innerHTML = '' }
  state.sid = id
  poll()
  clearInterval(state.timer)
  state.timer = setInterval(poll, 2500)
}

async function poll() {
  if (!state.sid) return
  try {
    const r = await api(`session?id=${encodeURIComponent(state.sid)}`)
    state.session = r.session
    render(r.session)
    const live = r.session.status === 'running' || r.session.oralRunning || r.session.autopilot?.enabled
    if (!live) { clearInterval(state.timer); state.timer = null }
  } catch (err) {
    clearInterval(state.timer)
    state.timer = null
    toast('读取会话失败：' + err.message)
  }
}

function render(s) {
  const running = s.status === 'running'
  $('#sessionTitle').textContent = s.title
  const mats = (s.materials || []).map((m) => m.error ? `✗ ${m.path}（${m.error}）` : `${m.path.split('/').pop()}${m.truncated ? '（截断）' : ''}`)
  $('#sessionMeta').textContent = [`${(s.turns || []).length} 回合`, s.context?.field, mats.length ? `材料：${mats.join('、')}` : ''].filter(Boolean).join(' · ')
  $('#sendBtn').disabled = running
  $('#stopBtn').disabled = !(running || s.oralRunning || s.autopilot?.enabled)
  const ap = s.autopilot || {}
  $('#apNote').textContent = ap.note ? `续航：${ap.note}` : ''
  $('#apToggle').textContent = ap.enabled ? `关闭自动续航（已续 ${ap.cycles || 0} 回合）` : '开启自动续航'
  renderCcfa(s)
  renderBusy(s.busy)
  renderSteps(s.phase, running)
  renderFeed(s, running)
  if (!['status', 'mission'].includes(state.tab)) renderTab(s)
}

function renderCcfa(s) {
  const m = s.mainline
  const p = m?.progress || {}
  const pct = p.percent ?? 0
  const stage = { explore: '探索', converge: '收敛', write: '成稿', done: '完成' }[m?.stage] || ''
  const last = m?.decisions?.[m.decisions.length - 1]
  const delta = last?.progressDelta
  $('#ccfaBar').innerHTML = `<div class="ulabel"><span><b>CCF-A 进度 ${pct}%</b>${delta ? `（${delta > 0 ? '+' : ''}${delta}）` : ''} · ${esc(stage)} · 主持人 Claude 评估</span><span>${p.blocker ? `卡点：${esc(p.blocker)}` : ''}</span></div><div class="meter"><i class="${pct >= 85 ? '' : pct >= 40 ? 'warn' : 'bad'}" style="width:${pct}%"></i></div>`
  $('#ccfaBar').title = p.reason ? `主持人理由：${p.reason}\n完整度地图参考值：${p.mapRef ?? '–'}%` : '第一回合结束后由主持人评估'
}

function renderSteps(phase, running) {
  const box = $('#phaseSteps')
  box.innerHTML = ''
  const order = PHASES.map(([k]) => k)
  const cur = order.indexOf(phase)
  for (const [key, label] of PHASES) {
    const i = order.indexOf(key)
    let cls = 'step'
    if (cur > i) cls += ' done'
    if (cur === i) cls += ' current'
    box.appendChild(el('span', cls, label))
  }
}

function renderFeed(s, running) {
  // 用签名判断是否需要重绘，避免每 2.5s 打断用户展开/滚动
  const t0 = s.turns?.[s.turns.length - 1]
  const sig = JSON.stringify([(s.turns || []).map((t) => [t.entries.length, t.error, (t.tasks || []).map((x) => x.status).join()]), running, s.phase, s.busy, s.oral?.length, s.oral?.[s.oral.length - 1]?.votes?.length, t0?.next])
  if (sig === state.rendered) return
  const box = $('#feed')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80
  const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.key))
  state.rendered = sig
  box.innerHTML = ''
  if (!(s.turns || []).length) {
    box.appendChild(el('div', 'empty', '<p>会话已创建。在下方输入第一个问题。</p>'))
  }
  for (const t of s.turns || []) {
    const um = el('div', 'user-msg')
    if (t.auto) um.appendChild(el('span', 'tplbadge', 'Claude 自动续航'))
    else if (t.template && t.template !== 'free') um.appendChild(el('span', 'tplbadge', esc(state.templates[t.template] || t.template)))
    um.appendChild(document.createTextNode(t.user))
    box.appendChild(um)
    for (const [i, e] of (t.entries || []).entries()) {
      const key = `${t.id}-${i}`
      const card = el('div', `turn lane-${LANES.includes(e.lane) ? e.lane : 'lead'} kind-${e.kind}`)
      const head = el('div', 'turn-head')
      head.appendChild(el('span', 'turn-who', esc(e.role)))
      card.appendChild(head)
      const body = el('div', 'turn-say md', md(e.text))
      // 中间过程默认折叠，只展开派活/裁决/综合/评审
      if (['report', 'cross', 'knowledge'].includes(e.kind)) {
        const d = el('details')
        d.dataset.key = key
        if (open.has(key)) d.open = true
        d.appendChild(el('summary', null, `${KIND_LABEL[e.kind]}全文（${e.text.length} 字）· ${esc(firstLine(e.text))}`))
        d.appendChild(body)
        card.appendChild(d)
      } else {
        card.appendChild(body)
      }
      box.appendChild(card)
    }
    if (t.next?.decision) box.appendChild(el('div', 'busyline', `◆ 主持人主线判断：<b>${({ continue: '继续', converge: '收敛', finish: '完成', need_user: '需要你' })[t.next.decision]}</b>${t.next.progress != null ? `｜CCF-A ${t.next.progress}%（${t.next.progressDelta >= 0 ? '+' : ''}${t.next.progressDelta}）` : ''}｜推进：${esc((t.next.advanced || []).join('、') || '无')}｜${esc(t.next.reason || '')}${t.next.needsUser ? `｜需要你：${esc(t.next.needsUser)}` : ''}`))
    if (t.error) box.appendChild(el('div', 'turn-err', `✗ ${esc(t.error)}`))
  }
  const last = s.turns?.[s.turns.length - 1]
  if (running && last?.tasks?.length) {
    const tb = el('div', 'scorecard')
    tb.appendChild(el('div', 'dim tiny', '任务流水线'))
    for (const x of last.tasks) {
      const row = el('div', 'task-row')
      row.appendChild(el('span', `st ${x.status}`, TASK_ST[x.status] || x.status))
      row.appendChild(el('b', null, esc(x.id)))
      row.appendChild(el('span', 'dim', esc(x.worker)))
      if (x.ruling?.score != null) row.appendChild(el('span', null, `${x.ruling.score}/10`))
      row.appendChild(el('span', null, esc(x.task.slice(0, 70))))
      tb.appendChild(row)
    }
    box.appendChild(tb)
  }
  const busy = Object.entries(s.busy || {}).map(([l, tags]) => `<b>${esc(l)}</b> ${esc(tags.join('、').slice(0, 80))}`).join('　')
  if (running || s.oralRunning) box.appendChild(el('div', 'typing', `${esc(phaseName(s.phase))}中<i></i><i></i><i></i>　${busy}`))
  if (atBottom || running) box.scrollTop = box.scrollHeight
}

const phaseName = (p) => (PHASES.find(([k]) => k === p) || [null, p === 'idle' ? '评审' : p])[1]

function firstLine(text) {
  const line = String(text || '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean).find((l) => !/^结论|^错误或可疑|^已读完/.test(l)) || ''
  return line.length > 60 ? line.slice(0, 60) + '…' : line
}

/* ── 右侧标签 ── */
function renderTab(s) {
  const box = $('#tabbody')
  if (state.tab === 'events') {
    box.innerHTML = '<div class="events"></div>'
    const e = box.querySelector('.events')
    for (const line of s?.events || []) e.appendChild(el('div', null, esc(line)))
    box.scrollTop = box.scrollHeight
    return
  }
  if (state.tab === 'final') {
    const last = [...(s?.turns || [])].reverse().find((t) => t.final) || null
    box.innerHTML = last ? md(last.final) : '<p class="dim">回合完成后在这里显示总控的综合答复。</p>'
    if (last) {
      const btn = el('button', 'ghost', '复制为 Markdown')
      btn.style.marginTop = '12px'
      btn.onclick = () => navigator.clipboard.writeText(last.final).then(() => toast('已复制'))
      box.appendChild(btn)
    }
    return
  }
  if (state.tab === 'board') return renderBoard(s, box)
  if (state.tab === 'oral') return renderOralTab(s, box)
  if (state.tab === 'kb') return renderKb(box)
  if (state.tab === 'mission') return renderMission(box)
  if (state.tab === 'memory') return renderMemory(s, box)
  if (state.tab === 'mainline') return renderMainline(s, box)
  if (state.tab === 'status') return renderStatus(box)
}

function renderBoard(s, box) {
  const b = s?.board || {}
  box.innerHTML = ''
  box.appendChild(el('p', 'dim tiny', 'Claude 的常设指令与每份裁决都写在这里，DeepSeek / ChatGPT 每次执行、互审前都会读到。'))
  box.appendChild(el('h3', null, `常设指令（第 ${b.version || 0} 版）`))
  const ol = el('ol')
  for (const d of b.directives || []) ol.appendChild(el('li', null, esc(d)))
  if (!(b.directives || []).length) box.appendChild(el('p', 'dim', '还没有。'))
  else box.appendChild(ol)
  box.appendChild(el('h3', null, '裁决记录'))
  for (const r of [...(b.rulings || [])].reverse().slice(0, 30)) {
    const card = el('div', 'scorecard')
    card.appendChild(el('div', 'turn-who', `${esc(r.taskId)} · ${esc(r.worker)} · ${r.score ?? '–'}/10${r.storyScore != null ? ` · 故事 ${r.storyScore}/10` : ''} ${r.verdict === 'revise' ? '↩ 打回' : '✓ 通过'}`))
    const v = Number(r.score) || 0
    card.appendChild(el('div', 'scorebar', `<i style="width:${v * 10}%"></i>`))
    if (r.note) card.appendChild(el('div', 'dim tiny', esc(r.note)))
    for (const x of r.rejected || []) card.appendChild(el('div', 'tiny', `✗ ${esc(typeof x === 'object' ? `${x.point} —— ${x.reason}` : x)}`))
    box.appendChild(card)
  }
}

function renderOralTab(s, box) {
  box.innerHTML = ''
  const { rounds, threshold } = state.oralCfg
  box.appendChild(el('p', 'dim tiny', `每个回合结束后，Claude 抽出贡献主张；Claude / DeepSeek / ChatGPT 各自独立评 ${rounds} 轮（oral-paper-skill + 你的审核规则），积极 ≥ ${threshold}/${rounds * 3} 才算合格。保留不计积极；同一版本不重抽。`))
  const list = [...(s?.oral || [])].reverse()
  if (!list.length) box.appendChild(el('p', 'dim', '还没有评审记录。'))
  for (const o of list) {
    const card = el('div', 'scorecard')
    const done = (o.votes || []).length
    const head = done < o.planned && !o.finishedAt
      ? `<span class="dim">评审中 ${done}/${o.planned}</span>　积极 ${o.positives}`
      : `<span class="${o.passed ? 'verdict-pass' : 'verdict-fail'}">${o.passed ? '✓ 合格' : '✗ 未达标'}</span>　积极 ${o.positives}/${o.planned}（门槛 ${o.threshold}）${o.reused ? '　<span class="dim">同版本复用</span>' : ''}${o.complete ? '' : '　<span class="dim">有失败票</span>'}`
    card.appendChild(el('div', 'turn-who', `${esc(o.title)} <span class="dim">${esc(o.versionHash)}</span>`))
    card.appendChild(el('div', null, head))
    const grid = el('div', 'votegrid')
    for (const lane of ['claude', 'deepseek', 'chatgpt']) {
      grid.appendChild(el('span', 'dim', lane))
      for (let r = 1; r <= rounds; r += 1) {
        const v = (o.votes || []).find((x) => x.lane === lane && x.round === r)
        const cls = !v ? '' : !v.ok ? 'fail' : v.positive ? 'pos' : /消极/.test(v.verdict) ? 'neg' : 'res'
        const cell = el('span', `vote ${cls}`)
        cell.title = v ? `第${r}轮 · ${v.lens}\n${v.verdict} ${v.score ?? ''}\n${v.reason || v.error || ''}\n致命：${v.fatal || '—'}` : `第${r}轮 · 等待中`
        grid.appendChild(cell)
      }
    }
    card.appendChild(grid)
    if ((o.topIssues || []).length) card.appendChild(el('div', 'tiny', '高频致命问题：' + o.topIssues.map(esc).join('；')))
    const d = el('details')
    d.appendChild(el('summary', null, '贡献版本全文'))
    d.appendChild(el('div', 'turn-say', esc(o.contribution)))
    card.appendChild(d)
    box.appendChild(card)
  }
  box.appendChild(el('h3', null, '手动送审一个贡献版本'))
  const ta = el('textarea')
  ta.rows = 6
  ta.placeholder = '问题 / 最近邻 / 具体增量 / 机制依据 / 监督假设 / 决定性比较 / 适用范围 / 可否证性'
  const ti = el('input')
  ti.placeholder = '版本名（可选）'
  const btn = el('button', 'primary wide', '开始 3×10 评审')
  btn.onclick = async () => {
    if (!state.sid) return toast('先选一个会话')
    try { await api('oral', { id: state.sid, contribution: ta.value, title: ti.value }); toast('评审已开始'); openSession(state.sid) } catch (err) { toast(err.message) }
  }
  box.appendChild(ti)
  box.appendChild(ta)
  box.appendChild(btn)
}

const DEC = { continue: '继续', converge: '收敛', finish: '完成', need_user: '需要你' }
const ST_CLS = { 缺失: 'neg', 讨论中: 'res', 有方案: 'res', 有证据: 'pos', 已定稿: 'pos' }
function renderMainline(s, box) {
  box.innerHTML = ''
  const m = s?.mainline
  if (!m) { box.innerHTML = '<p class="dim">先选一个会话。</p>'; return }
  box.appendChild(el('p', 'dim tiny', '主线方向由主持人 Claude 把控：每回合结束对照论文完整度判断推进了什么、是否原地打转，然后决定继续 / 收敛 / 完成 / 需要你。没有回合数上限。'))
  box.appendChild(el('h3', null, `主线 · ${esc({ explore: '探索', converge: '收敛', write: '成稿', done: '完成' }[m.stage] || m.stage)}`))
  box.appendChild(el('div', 'quote', esc(m.direction || '（第一回合结束后由主持人确定）')))
  const pg = m.progress || {}
  box.appendChild(el('h3', null, `CCF-A 进度 ${pg.percent ?? 0}%`))
  box.appendChild(el('div', 'meter', `<i style="width:${pg.percent ?? 0}%"></i>`))
  box.appendChild(el('div', 'ulabel', `<span>完整度地图参考值 ${pg.mapRef ?? '–'}%</span><span>${pg.blocker ? `卡点：${esc(pg.blocker)}` : ''}</span>`))
  if (pg.reason) box.appendChild(el('p', 'tiny', `主持人理由：${esc(pg.reason)}`))
  const hist = pg.history || []
  if (hist.length > 1) {
    const sp = el('div', 'spark')
    sp.title = hist.map((h) => `${h.turn}: ${h.percent}%`).join('\n')
    for (const h of hist.slice(-40)) sp.appendChild(el('i', null, '')).style.height = `${Math.max(4, h.percent)}%`
    box.appendChild(sp)
  }
  box.appendChild(el('h3', null, '论文完整度'))
  const done = m.map.filter((x) => ['有证据', '已定稿'].includes(x.status)).length
  box.appendChild(el('div', 'ulabel', `<span>${done}/${m.map.length} 个环节有证据或已定稿</span><span></span>`))
  for (const x of m.map) {
    const row = el('div', 'task-row')
    row.appendChild(el('span', `vote ${ST_CLS[x.status] || ''}`, ''))
    row.firstChild.style.width = '14px'
    row.appendChild(el('b', null, esc(x.element)))
    row.appendChild(el('span', 'st', esc(x.status)))
    row.appendChild(el('span', 'dim', esc(x.note || '')))
    box.appendChild(row)
  }
  box.appendChild(el('h3', null, '主持人判断记录'))
  for (const d of [...(m.decisions || [])].reverse().slice(0, 20)) {
    const card = el('div', 'scorecard')
    card.appendChild(el('div', 'turn-who', `${esc(d.turn)} · ${DEC[d.decision] || d.decision}${d.progress != null ? ` · 进度 ${d.progress}%（${d.progressDelta >= 0 ? '+' : ''}${d.progressDelta}）` : ''} · ${new Date(d.at).toLocaleString('zh-CN')}`))
    card.appendChild(el('div', 'tiny', `推进：${esc((d.advanced || []).join('、') || '无')}`))
    card.appendChild(el('div', 'tiny', `循环自查：${esc(d.loopCheck || '')}`))
    card.appendChild(el('div', 'tiny', `理由：${esc(d.reason || '')}`))
    if (d.next) card.appendChild(el('div', 'dim tiny', `下一回合：${esc(d.next)}`))
    if (d.needsUser) card.appendChild(el('div', 'uerr', `需要你：${esc(d.needsUser)}`))
    box.appendChild(card)
  }
  if (!(m.decisions || []).length) box.appendChild(el('p', 'dim', '还没有判断记录。'))
}

function renderMemory(s, box) {
  box.innerHTML = ''
  if (!s) { box.innerHTML = '<p class="dim">先选一个会话。</p>'; return }
  const m = s.memory || {}
  box.appendChild(el('p', 'dim tiny', '执行者每份汇报都必须带「阶段反馈」（已完成 / 未完成 / 阻塞 / 建议下一步）；被截断会自动续写，缺小节会要求补写。Claude 裁决时把遗留事项带到下一回合。某个模型提示词逼近上下文预算、或有回合要滑出历史时，Claude 把关键信息整理进 Obsidian，并注入之后所有 Agent 的提示词。'))
  // 上下文压力
  const p = s.pressure || {}
  if (Object.keys(p).length) {
    box.appendChild(el('h3', null, '本会话上下文压力'))
    for (const [lane, x] of Object.entries(p)) {
      const pct = Math.min(1, x.ratio || 0)
      const cls = pct > 0.85 ? 'bad' : pct > 0.6 ? 'warn' : ''
      box.appendChild(el('div', 'usage-lane', `<div class="ulabel"><span>${esc(lane)}${x.estimated ? '（估算）' : ''}</span><span>${fmtTok(x.tokens)} / 预算 ${fmtTok(Math.round(x.budget))}（窗口 ${fmtTok(x.window)}）</span></div><div class="meter"><i class="${cls}" style="width:${(pct * 100).toFixed(1)}%"></i></div>`))
    }
  }
  if (s.memoryDue) box.appendChild(el('p', 'uerr', `待整理：${esc(s.memoryDue)}（本回合结束后自动执行）`))
  box.appendChild(el('h3', null, m.version ? `关键记忆 v${m.version}` : '关键记忆（尚未生成）'))
  if (m.file) box.appendChild(el('p', 'dim tiny', `Obsidian：${esc(m.file)}　·　${m.savedAt ? new Date(m.savedAt).toLocaleString('zh-CN') : ''}　·　${esc(m.reason || '')}`))
  if (m.stageFile) box.appendChild(el('p', 'dim tiny', `阶段反馈：${esc(m.stageFile)}`))
  const btn = el('button', 'ghost wide', '现在让 Claude 整理并保存到 Obsidian')
  btn.onclick = async () => { try { await api('memory', { id: state.sid }); toast('Claude 正在整理关键记忆…'); openSession(state.sid) } catch (err) { toast(err.message) } }
  box.appendChild(btn)
  if (m.text) box.appendChild(el('div', 'turn-say md', md(m.text)))
  // 最近回合的阶段反馈
  const t = [...(s.turns || [])].reverse().find((x) => (x.ledger || []).length)
  if (t) {
    box.appendChild(el('h3', null, `阶段反馈 · ${t.id}`))
    for (const x of t.ledger) {
      const card = el('div', 'scorecard')
      card.appendChild(el('div', 'turn-who', `${esc(x.taskId)} · ${esc(x.worker)} · ${esc(x.status)}${x.score != null ? ` · ${x.score}/10` : ''}`))
      card.appendChild(el('div', 'dim tiny', esc(String(x.task).slice(0, 120))))
      card.appendChild(el('div', 'turn-say md', md(x.stage || '（无阶段反馈）')))
      box.appendChild(card)
    }
    if ((t.carryOver || []).length) {
      box.appendChild(el('h4', null, '遗留到下一回合'))
      const ul = el('ul')
      for (const c of t.carryOver) ul.appendChild(el('li', null, esc(c)))
      box.appendChild(ul)
    }
  }
}

async function renderMission(box) {
  if (box.querySelector('.mission-ed')) return
  box.innerHTML = '<p class="dim">读取中…</p>'
  try {
    const m = await api(`mission${state.sid ? `?id=${encodeURIComponent(state.sid)}` : ''}`)
    if (state.tab !== 'mission') return
    box.innerHTML = ''
    const wrap = el('div', 'mission-ed statusbox')
    wrap.appendChild(el('p', 'dim tiny', '科研目标与核心要义会放在每个 Agent 每次调用的提示词最前面（派活、执行、互审、裁决、综合、贡献评审、续航）。修改后下一次调用立即生效。'))
    wrap.appendChild(el('h3', null, '全局（所有会话默认）'))
    const g = el('textarea')
    g.rows = 14
    g.value = m.global
    const gb = el('button', 'primary wide', '保存全局目标')
    gb.onclick = async () => { try { await api('mission', { scope: 'global', text: g.value }); toast('已保存，所有会话下一次调用生效') } catch (err) { toast(err.message) } }
    const reset = el('button', 'ghost wide', '恢复默认文本')
    reset.onclick = () => { g.value = m.default }
    wrap.append(g, gb, reset)
    if (state.sid) {
      wrap.appendChild(el('h3', null, '本会话覆盖（留空则用全局）'))
      const s = el('textarea')
      s.rows = 6
      s.value = m.session
      s.placeholder = '例：本会话比较两种公开算法的误差与成本'
      const sb = el('button', 'ghost wide', '保存本会话目标')
      sb.onclick = async () => { try { await api('mission', { scope: 'session', id: state.sid, text: s.value }); toast('本会话目标已更新') } catch (err) { toast(err.message) } }
      wrap.append(s, sb)
    }
    box.appendChild(wrap)
  } catch (err) { box.innerHTML = `<p class="dim">${esc(err.message)}</p>` }
}

async function renderKb(box) {
  box.innerHTML = '<p class="dim">读取中…</p>'
  try {
    const k = await api('knowledge')
    if (state.tab !== 'kb') return
    box.innerHTML = ''
    box.appendChild(el('p', 'dim tiny', `来源：${k.sources.map((s) => `${s.exists ? '✓' : '✗'} ${s.title}`).join('；')}`))
    box.appendChild(el('p', 'dim tiny', `skill 库 ${k.skills} 个，精读 ${(k.deepSkills || []).length} 个：${(k.deepSkills || []).join(', ')}`))
    if (k.building) box.appendChild(el('p', 'dim', '正在重读：' + esc((k.log || []).slice(-1)[0] || '')))
    box.appendChild(el('div', null, k.text ? md(k.text) : '<p class="dim">手册还没生成，第一个回合开始时自动生成。</p>'))
  } catch (err) { box.innerHTML = `<p class="dim">${esc(err.message)}</p>` }
}

function renderStatus(box) {
  if (box.querySelector('.statusbox')) return
  box.innerHTML = ''
  const wrap = el('div', 'statusbox')
  wrap.appendChild(el('p', 'dim tiny', '随时问 Claude 任何会话现在的状态。命令行也可以：curl \'http://127.0.0.1:8788/ask?q=现在在干嘛\''))
  const ta = el('textarea')
  ta.rows = 3
  ta.placeholder = '例：所有会话现在谁在干什么？卡在哪？贡献评审几票了？'
  const scope = el('label', 'inline', '<input type="checkbox" checked /> 只问当前会话')
  const btn = el('button', 'primary wide', '问 Claude')
  const ans = el('div', 'turn-say md')
  ans.innerHTML = state.statusAnswer ? md(state.statusAnswer) : ''
  btn.onclick = async () => {
    if (state.statusBusy) return
    state.statusBusy = true
    btn.disabled = true
    ans.innerHTML = '<p class="dim">Claude 正在查看实时状态…</p>'
    try {
      const only = scope.querySelector('input').checked
      const r = await api('ask', { question: ta.value || '现在进展如何？', id: only ? state.sid : '' })
      state.statusAnswer = r.answer
      ans.innerHTML = md(r.answer)
    } catch (err) { ans.innerHTML = `<p class="dim">${esc(err.message)}</p>` }
    state.statusBusy = false
    btn.disabled = false
  }
  wrap.append(ta, scope, btn, ans)
  box.appendChild(wrap)
}

/* ── 用量余额 · 上下文 ── */
const fmtTok = (n) => n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 2 : 0)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n)
const fmtWhen = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const h = (d - Date.now()) / 3.6e6
  return h > 0 && h < 48 ? `${Math.round(h)} 小时后` : d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function meter(fraction, label, right) {
  const p = Math.max(0, Math.min(1, fraction || 0))
  const cls = p > 0.85 ? 'bad' : p > 0.6 ? 'warn' : ''
  return `<div class="ulabel"><span>${label}</span><span>${right}</span></div><div class="meter"><i class="${cls}" style="width:${(p * 100).toFixed(1)}%"></i></div>`
}

function contextMeter(u) {
  const c = u.context
  if (!c?.window) return '<div class="ulabel"><span>上下文</span><span>窗口未知</span></div>'
  if (c.lastInput == null) return meter(0, '上下文余量', `${fmtTok(c.window)} 全部可用（本服务还没调用）`)
  return meter(c.lastInput / c.window, `上下文余量${c.estimated ? '（估算）' : ''}`, `剩 ${fmtTok(c.remaining)} / ${fmtTok(c.window)}　上次用 ${fmtTok(c.lastInput)}`)
}

function sessionLine(u) {
  const s = u.session
  if (!s) return ''
  return `<div class="ulabel"><span>本服务累计</span><span>${s.calls} 次${s.failures ? `（失败 ${s.failures}）` : ''} · 入 ${fmtTok(s.inputTokens)} · 出 ${fmtTok(s.outputTokens)}</span></div>`
}

function renderUsage(data) {
  const box = $('#usageBox')
  const L = data?.lanes || {}
  const parts = []
  const ds = L.deepseek
  if (ds) {
    const b = ds.balance
    parts.push(`<div class="usage-lane"><div class="uhead"><b>DeepSeek</b><span class="big">${b ? `¥${b.total.toFixed(2)}` : '–'}</span></div>
      ${b ? `<div class="ulabel"><span>账户余额${b.available ? '' : '（不可用！）'}</span><span>充值 ¥${b.toppedUp.toFixed(2)} · 赠送 ¥${b.granted.toFixed(2)}</span></div>` : ''}
      ${ds.balanceError ? `<div class="uerr">余额：${esc(ds.balanceError)}</div>` : ''}
      ${contextMeter(ds)}${sessionLine(ds)}</div>`)
  }
  const cl = L.claude
  if (cl) {
    const q = cl.quota
    parts.push(`<div class="usage-lane"><div class="uhead"><b>Claude</b><span class="big">${q ? `${fmtTok(q.availableTokens)}` : '–'}</span></div>
      ${q ? meter(q.todayUsedTokens / q.dailyLimitTokens, '今日额度', `已用 ${fmtTok(q.todayUsedTokens)} / ${fmtTok(q.dailyLimitTokens)}（≈¥${q.todayUsedAmount} / ¥${q.dailyLimitAmount}）`) : ''}
      ${q?.subscriptionExpiresAt ? `<div class="ulabel"><span>订阅到期</span><span>${fmtWhen(q.subscriptionExpiresAt)}${q.rechargeAvailableAmount ? ` · 充值余额 ¥${q.rechargeAvailableAmount}` : ''}</span></div>` : ''}
      ${cl.balanceError ? `<div class="uerr">额度：${esc(cl.balanceError)}</div>` : ''}
      ${contextMeter(cl)}${sessionLine(cl)}</div>`)
  }
  const cg = L.chatgpt
  if (cg) {
    const r = cg.rateLimits
    const win = (w, name) => w ? meter(w.usedPercent / 100, `${name}（${w.windowMinutes >= 1440 ? `${Math.round(w.windowMinutes / 1440)} 天` : `${Math.round(w.windowMinutes / 60)} 小时`}窗口）`, `已用 ${w.usedPercent}% · ${fmtWhen(w.resetsAt)}重置`) : ''
    parts.push(`<div class="usage-lane"><div class="uhead"><b>ChatGPT · codex</b><span class="big">${r?.primary ? `剩 ${Math.max(0, 100 - r.primary.usedPercent)}%` : '–'}</span></div>
      ${r ? win(r.primary, '订阅额度') + win(r.secondary, '短窗口') : ''}
      ${r?.credits && !r.credits.unlimited ? `<div class="ulabel"><span>credits</span><span>${r.credits.balance.toLocaleString()}${r.credits.hasCredits ? '' : '（已用完）'}</span></div>` : ''}
      ${r?.reached ? `<div class="uerr">已触发限额：${esc(r.reached)}</div>` : ''}
      ${r ? `<div class="ulabel"><span>数据来自</span><span>codex 日志 · ${fmtWhen(r.observedAt)}</span></div>` : ''}
      ${cg.balanceError ? `<div class="uerr">${esc(cg.balanceError)}</div>` : ''}
      ${contextMeter(cg)}${sessionLine(cg)}</div>`)
  }
  parts.push(`<p class="dim tiny">余额每 60 秒更新；上下文余量 = 模型窗口 − 本服务最近一次发给它的提示词。${data?.fetchedAt ? ` 更新于 ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN')}` : ''}</p>`)
  box.innerHTML = parts.join('')
}

async function loadUsage(force = false) {
  try { renderUsage(await api(`usage${force ? '?refresh=1' : ''}`)) } catch (err) { $('#usageBox').innerHTML = `<p class="uerr">${esc(err.message)}</p>` }
}

/* ── 交互 ── */
function selectedWorkers() {
  return [$('#wDeepseek').checked && 'deepseek', $('#wChatgpt').checked && 'chatgpt'].filter(Boolean)
}

async function newSession(firstMessage = '') {
  const r = await api('session', {
    title: $('#title').value, venue: $('#venue').value, field: $('#field').value,
    constraints: $('#constraints').value, deadline: $('#deadline').value,
    background: $('#background').value, materials: $('#materials').value, message: firstMessage,
  })
  const bad = (r.session.materials || []).filter((m) => m.error)
  if (bad.length) toast('部分材料没读到：\n' + bad.map((m) => `${m.path}：${m.error}`).join('\n'), 8000)
  state.sid = r.session.id
  state.rendered = ''
  await loadMeta()
  return r.session.id
}

async function send(ev) {
  ev?.preventDefault()
  const text = $('#msg').value.trim()
  if (!text) return
  const workers = selectedWorkers()
  if (!workers.length) { toast('至少选一个执行者'); return }
  $('#sendBtn').disabled = true
  try {
    const sid = state.sid || await newSession(text)
    await api('message', {
      id: sid, message: text, template: state.template, workers,
      maxSteps: Number($('#maxSteps').value), maxRevise: Number($('#maxRevise').value),
      cross: $('#cross').checked, oral: $('#oral').checked, debate: $('#debate').checked,
      autopilot: $('#autopilot').checked,
    })
    $('#msg').value = ''
    openSession(sid)
    loadMeta()
  } catch (err) {
    toast(err.message)
    $('#sendBtn').disabled = false
  }
}

$('#composer').addEventListener('submit', send)
$('#msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e) })
$('#newBtn').onclick = async () => {
  try { const id = await newSession(); openSession(id); toast('已新建会话，背景与材料已绑定') } catch (err) { toast(err.message) }
}
$('#stopBtn').onclick = async () => {
  if (!state.sid) return
  await api('cancel', { id: state.sid }).catch(() => {})
  toast('已请求停止（同时关闭自动续航）')
  poll()
}
$('#apToggle').onclick = async () => {
  if (!state.sid) return toast('先选一个会话')
  const on = !state.session?.autopilot?.enabled
  try {
    await api('autopilot', { id: state.sid, enabled: on })
    $('#autopilot').checked = on
    toast(on ? '已开启：当前回合结束后 Claude 会自动决定下一回合' : '已关闭自动续航')
    openSession(state.sid)
  } catch (err) { toast(err.message) }
}
$('#kbRebuild').onclick = async () => {
  try { await api('knowledge', {}); toast('Claude 开始重读经验库（几分钟）'); setTimeout(loadMeta, 2000) } catch (err) { toast(err.message) }
}
document.querySelectorAll('.tab').forEach((btn) => {
  btn.onclick = () => {
    state.tab = btn.dataset.tab
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn))
    $('#tabbody').innerHTML = ''
    renderTab(state.session)
    if (!state.session && state.tab === 'mission') renderMission($('#tabbody'))
  }
})

$('#usageRefresh').onclick = () => loadUsage(true)

loadMeta()
loadUsage()
setInterval(() => { if (!state.timer) loadMeta() }, 10000)
setInterval(() => loadUsage(), 20000)
