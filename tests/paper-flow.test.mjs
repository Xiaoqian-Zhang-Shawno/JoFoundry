// Isolated: real paper.mjs pipeline with mocked model calls; nothing touches real sessions or Obsidian.
// Run: node --test scripts/test-paper-flow.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const dir = mkdtempSync(join(tmpdir(), 'foundry-paper-'))
process.env.FOUNDRY_HOME = dir
const calls = []
const originalFetch = globalThis.fetch
after(() => {
  globalThis.fetch = originalFetch
  rmSync(dir, { recursive: true, force: true })
})
globalThis.fetch = async (url, { body }) => {
    const lane = new URL(url).pathname.split('/')[1]
    const req = { user: JSON.parse(body).messages.find(message => message.role === 'user').content }
    const tag = req.user.includes('输出（最多') ? 'outline' : req.user.includes('"sections": [ { "id": "节 id"') ? 'review'
      : req.user.includes('"action": "revise / experiment / rebut", "why"') ? 'decide' : req.user.includes('"action": "revise / experiment / rebut", "reason"') ? 'propose'
      : req.user.includes('【对应英文版') ? 'zh' : req.user.includes('【总控修改意见】') ? 'revise' : 'en'
    calls.push(`${lane}:${tag}`)
    const r = text => Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })
    if (tag === 'outline') return r(JSON.stringify({ title_en: 'T', title_zh: '题', one_sentence_claim: 'c', sections: [
      { id: 'introduction', title_en: 'Introduction', title_zh: '引言', purpose: 'p', key_points: [], evidence: [], writer: 'writer-a' },
      { id: 'method', title_en: 'Method', title_zh: '方法', purpose: 'p', key_points: [], evidence: [], writer: 'writer-b' }] }))
    if (tag === 'en') return r('We observe 12/16 successes. A made-up value 0.987 appears.')
    if (tag === 'zh') return r('我们观察到 12/16 次成功。')
    if (tag === 'review') return r(JSON.stringify({ sections: [{ id: 'introduction', verdict: 'revise', score: 5, issues: ['0.987 无出处'], instruction: '删除无出处数字' }, { id: 'method', verdict: 'ok', score: 8 }], overall: 'ok' }))
    if (tag === 'revise') return r('We observe 12/16 successes.')
    if (tag === 'propose') return r(JSON.stringify({ action: 'revise', reason: 'r', revised_en: 'x', evidence: ['T1.1'] }))
    if (tag === 'decide') return r(JSON.stringify({ action: 'revise', why: 'w', final_en: 'We observe 12/16 successes in four development worlds (single seed).', reply_to_user: '已收窄' }))
    throw new Error('unexpected ' + tag)
}
const cmd = await import('../lib/engine/command.mjs')
const paper = await import('../lib/engine/paper.mjs')
const settle = async (p) => { const end = Date.now() + 5000; while (p.running) { assert.ok(Date.now() < end, 'paper job did not settle'); await new Promise((r) => setTimeout(r, 5)) } }

test('draft → number trace → review → revise → bilingual save; comment → discuss → decide → revise', async () => {
  const lanes = Object.fromEntries(['lead-model', 'writer-b', 'writer-a'].map(id => [
    id, { kind: 'openai', baseUrl: `https://example.invalid/${id}`, model: 'fixture-model' },
  ]))
  const cfg = { lanes, protocol: { controller: 'lead-model', retries: 0 }, memory: { obsidianDir: join(dir, 'obs') } }
  const s = cmd.createSession({ vault: join(dir, 'vault'), title: 'Example manuscript' })
  s.turns.push({ id: 'T1', user: 'u', final: '结果 12/16', tasks: [{ id: 'T1.1', report: 'rollout 12/16 success', crosses: {} }], entries: [], calls: [] })
  paper.startDraft(s, cfg)
  const p = paper.paperState(s)
  await settle(p)
  assert.equal(p.version, 1)
  assert.equal(p.sections.introduction.en, 'We observe 12/16 successes.', 'flagged section revised')
  assert.deepEqual(p.sections.introduction.trace.missing, [], 'fabricated number removed after revision')
  assert.ok(p.sections.method.trace.missing.includes('0.987'), 'untraceable number detected')
  assert.ok(existsSync(join(p.dir, 'latest_en.md')) && existsSync(join(p.dir, 'latest_zh.md')) && existsSync(join(p.dir, 'v1', 'REVIEW.md')))
  assert.ok(readFileSync(join(p.dir, 'latest_zh.md'), 'utf8').includes('12/16'))
  assert.ok(calls.includes('writer-a:en') && calls.includes('writer-b:zh'), 'cross-model bilingual writing')

  paper.addComment(s, { sectionId: 'introduction', quote: '12/16', text: '单 seed，主张太满' })
  paper.startResolve(s, cfg)
  await settle(p)
  const c = p.comments[0]
  assert.equal(c.status, 'revised')
  assert.equal(c.thread.length, 4, 'two proposals × two persuasion rounds')
  assert.match(p.sections.introduction.en, /single seed/)
  assert.equal(p.version, 2)
})
