/* 人机审稿窗（无框架、无构建） */
const API = './api/cmd'
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ST = { open: '未决', discussing: '讨论中', revised: '已改稿', experiment: '已排实验方案', rebutted: '已回复' }
const ACT = { revise: '改稿', experiment: '补实验', rebut: '带证据回复' }
let state = { sid: new URLSearchParams(location.search).get('id') || '', paper: null, sec: null, timer: null }

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 4000) }
async function api(path, body) {
  const r = await fetch(`${API}/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined).then((x) => x.json())
  if (!r.ok) throw new Error(r.error || 'request failed')
  return r
}

function md(src, missing = []) {
  let html = esc(src)
    .replace(/^#{3,6}\s+(.*)$/gm, '<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  for (const n of missing) html = html.split(esc(n)).join(`<span class="missing" title="证据里找不到这个数字">${esc(n)}</span>`)
  return html.split(/\n{2,}/).map((p) => (p.startsWith('<h4>') ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('')
}

async function loadSessions() {
  const r = await api('meta')
  const sel = $('#sess')
  sel.innerHTML = r.sessions.map((s) => `<option value="${s.id}">${esc(s.title)}（CCF-A ${s.progress ?? 0}%）</option>`).join('')
  if (!state.sid && r.sessions.length) state.sid = r.sessions[0].id
  sel.value = state.sid
  sel.onchange = () => { state.sid = sel.value; state.sec = null; history.replaceState(null, '', `?id=${state.sid}`); refresh() }
  refresh()
}

async function refresh() {
  if (!state.sid) return
  try {
    const r = await api(`paper?id=${encodeURIComponent(state.sid)}`)
    state.paper = r.paper
    render()
    clearTimeout(state.timer)
    state.timer = setTimeout(refresh, r.paper.running ? 3000 : 15000)
  } catch (err) { toast(err.message) }
}

function render() {
  const p = state.paper
  const secs = p.outline?.sections || []
  $('#draftBtn').disabled = Boolean(p.running)
  $('#cResolve').disabled = Boolean(p.running) || !p.comments.some((c) => c.status === 'open')
  $('#pmeta').textContent = p.version ? `v${p.version}${p.savedAt ? ` · ${new Date(p.savedAt).toLocaleString('zh-CN')}` : ''}${p.dir ? ` · Obsidian：${p.dir}` : ''}${p.running ? ` · 进行中：${p.running === 'draft' ? '成稿' : '处理意见'}` : ''}` : (p.running ? '成稿进行中…' : '')
  $('#toc').innerHTML = secs.map((s) => {
    const x = p.sections[s.id] || {}
    const miss = (x.trace?.missing || []).length
    return `<li data-id="${s.id}" class="${state.sec === s.id ? 'active' : ''}">${esc(s.title_zh || s.id)}${x.verdict === 'revise' ? ' <span class="bad">待改</span>' : ''}${miss ? ` <span class="bad">${miss} 个数字无出处</span>` : ''}</li>`
  }).join('')
  document.querySelectorAll('#toc li').forEach((li) => { li.onclick = () => { state.sec = li.dataset.id; render(); document.getElementById(`sec-${li.dataset.id}`)?.scrollIntoView({ behavior: 'smooth' }) } })
  $('#cSec').innerHTML = `<option value="general">整篇</option>` + secs.map((s) => `<option value="${s.id}">${esc(s.title_zh || s.id)}</option>`).join('')
  if (state.sec) $('#cSec').value = state.sec
  if (!secs.length) {
    $('#paper').innerHTML = `<p class="dim">${p.running ? '三个模型正在写初稿，几分钟后刷新。' : '还没有初稿。点右上角「生成 / 重写初稿」：总控 定大纲，配置的执行者 分节写英文、互相写对齐的中文，系统核对每个数字的出处，总控 审稿并修订一轮。'}</p>`
  } else {
    $('#paper').innerHTML = `<h2>${esc(p.outline.title_en || '')}</h2><p class="dim">${esc(p.outline.title_zh || '')}</p><div class="quote">${esc(p.outline.one_sentence_claim || '')}</div>` +
      secs.map((s) => {
        const x = p.sections[s.id] || {}
        const miss = x.trace?.missing || []
        return `<section id="sec-${s.id}" data-sec="${s.id}"><h3>${esc(s.title_en)} · ${esc(s.title_zh)}</h3>
        <div class="meta">英文：${esc(x.writer || '')} · 中文：${esc(x.translator || '')}${x.score != null ? ` · 总控 审稿 ${x.score}/10` : ''}${x.revised ? ` · 已修订 ${x.revised} 次` : ''}${(x.issues || []).length ? ` · 问题：${esc(x.issues.join('；'))}` : ''}</div>
        <div class="pane"><div class="col"><h4>English</h4><div class="body">${md(x.en || '（待写）', miss)}</div></div>
        <div class="col"><h4>中文</h4><div class="body">${md(x.zh || '（待写）', miss)}</div></div></div></section>`
      }).join('')
  }
  $('#cmts').innerHTML = [...p.comments].reverse().map((c) => `<div class="cmt"><b>${c.id}</b> · ${esc(c.sectionId)} <span class="st">${ST[c.status] || c.status}</span>
    ${c.quote ? `<div class="q">${esc(c.quote)}</div>` : ''}<div>${esc(c.text)}</div>
    ${c.decision ? `<div class="thread"><b>总控 决断：${ACT[c.decision.action] || c.decision.action}</b><br>${esc(c.decision.reply || '')}<br><span class="dim">${esc(c.decision.why || '')}</span></div>` : ''}
    ${(c.thread || []).length ? `<details class="thread"><summary class="dim">模型讨论（${c.thread.length} 条）</summary>${c.thread.map((t) => `<div><b>${esc(t.lane)} 第${t.round}轮 → ${ACT[t.action] || esc(t.action)}</b>：${esc(t.reason)}${t.rebuttal ? `<br>${esc(t.rebuttal)}` : ''}${t.experiment ? `<br>实验：${esc(t.experiment)}` : ''}${(t.evidence || []).length ? `<br><span class="dim">依据：${esc(t.evidence.join('；'))}</span>` : ''}</div>`).join('')}</details>` : ''}
  </div>`).join('')
  $('#plog').innerHTML = (p.log || []).map((l) => `<div>${esc(l)}</div>`).join('')
}

document.addEventListener('mouseup', () => {
  const sel = window.getSelection()
  const txt = sel?.toString().trim()
  if (!txt || txt.length < 4) return
  const secEl = sel.anchorNode?.parentElement?.closest('section[data-sec]')
  if (!secEl) return
  $('#cQuote').value = txt.slice(0, 1200)
  $('#cSec').value = secEl.dataset.sec
})
$('#draftBtn').onclick = async () => {
  if (state.paper?.outline && !confirm('将基于当前所有证据重写整篇初稿（旧版本保存在 Obsidian 历史版本里）。继续？')) return
  try { await api('paper/draft', { id: state.sid }); toast('三个模型开始写初稿'); refresh() } catch (err) { toast(err.message) }
}
$('#cAdd').onclick = async () => {
  try {
    await api('paper/comment', { id: state.sid, sectionId: $('#cSec').value, quote: $('#cQuote').value, text: $('#cText').value })
    $('#cText').value = ''; $('#cQuote').value = ''
    toast('意见已添加'); refresh()
  } catch (err) { toast(err.message) }
}
$('#cResolve').onclick = async () => {
  try { await api('paper/resolve', { id: state.sid }); toast('两名模型开始讨论，总控 决断后自动改稿或派实验'); refresh() } catch (err) { toast(err.message) }
}
loadSessions()
