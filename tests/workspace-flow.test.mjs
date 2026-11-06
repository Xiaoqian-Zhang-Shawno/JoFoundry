import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const runtime = mkdtempSync(join(tmpdir(), 'foundry-workspace-test-'))
process.env.FOUNDRY_HOME = runtime
process.env.FOUNDRY_MOCK = '1'
const cmd = await import('../lib/engine/command.mjs')
const { handle, ROUTE, initCommand } = await import('../lib/runtime.mjs')
const { getUsage } = await import('../lib/engine/usage.mjs')
after(() => rmSync(runtime, { recursive: true, force: true }))

async function waitFor(check) {
  for (let i = 0; i < 150; i++) {
    const result = await check()
    if (result) return result
    await sleep(20)
  }
  throw new Error('Expected session transition did not occur')
}

test('projects and goals work through HTTP and an interrupted turn retains completed reports', async () => {
  const cfg = await initCommand({})
  const server = createServer((req, res) => handle(req, res, {}).catch(() => res.writeHead(500).end()))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}${ROUTE}/api/cmd/`
  async function request(path, body, status = 200) {
    const response = await fetch(base + path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : {})
    assert.equal(response.status, status)
    return response.json()
  }
  try {
    const { project } = await request('projects', { name: 'Example replication' })
    await request('projects', { name: project.name }, 409)
    const { session } = await request('session', { title: 'Evidence check' })
    const { id } = session
    await request('session/project', { id, projectId: 'invalid' }, 400)
    await request('session/project', { id, projectId: project.id })
    const objective = 'Deliver a traceable evidence checklist'
    await request('autopilot', { id, enabled: true, objective })
    const complete = async () => {
      const { session } = await request(`session?id=${id}`)
      return session.autopilot.state === 'complete' && session
    }
    const result = await waitFor(complete)
    assert.equal(result.projectId, project.id)
    assert.equal(result.autopilot.objective, objective)
    assert.equal(result.turns[0].user, objective)
    assert.ok(result.mainline.progress.history[0].reason)
    assert.ok(result.turns[0].tasks[0].report)

    const original = cmd.sessions.get(id)
    const turn = original.turns[0]
    const initialCalls = turn.calls.length
    const report = turn.tasks[0].report
    Object.assign(turn, { final: '', finishedAt: null, next: null })
    Object.assign(original, { status: 'running', phase: 'final' })
    Object.assign(original.autopilot, { enabled: true, state: 'active' })
    cmd.persist(original)
    cmd.sessions.clear()
    cmd.loadSessions(cfg.vault)
    cmd.resumeInterrupted(cfg)

    const resumed = await waitFor(complete)
    assert.equal(resumed.turns.length, 1)
    assert.equal(resumed.turns[0].tasks[0].report, report)
    assert.ok(resumed.turns[0].calls.slice(initialCalls).every(call => !/^(plan|task|judge)/.test(call.tag)))
    assert.deepEqual((await request('meta')).projects, [project])
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('saved retry time resumes a failed goal after reload', async () => {
  const cfg = await initCommand({})
  const session = cmd.createSession({ vault: cfg.vault, title: 'Retry fixture' })
  const original = cmd.sendMessage(session, 'Check reference evidence', cfg, { oral: false })
  await waitFor(() => session.status === 'idle')
  original.error = 'Temporary failure'
  original.next = null
  session.autopilot = { enabled: true, state: 'retrying', cycles: 0, failures: 1,
    retryAt: new Date(Date.now() - 100).toISOString(), objective: 'Check reference evidence' }
  cmd.persist(session)
  cmd.sessions.delete(session.id)
  cmd.loadSessions(cfg.vault)
  cmd.resumeInterrupted(cfg)
  const restored = cmd.sessions.get(session.id)
  await waitFor(() => restored.autopilot.state === 'complete')
  assert.equal(restored.turns.length, 2)
  assert.equal(restored.turns[1].user, original.user)
})

test('quota uses only the opted-in active provider key and keeps balances out of model context', async () => {
  const saved = globalThis.fetch
  const calls = []
  process.env.FOUNDRY_MOCK = '0'
  process.env.FIXTURE_BALANCE_A = 'fixture-balance-a'
  process.env.FIXTURE_BALANCE_B = 'fixture-balance-b'
  globalThis.fetch = async (url, options) => {
    calls.push({ url, auth: options.headers.authorization, redirect: options.redirect })
    return Response.json(url.includes('lmuai') ? { balance: 0, is_active: false } :
      { data: { usage: 2.5, limit_remaining: 7.5 } })
  }
  try {
    const lane = { label: 'Controller', kind: 'anthropic', active: 'first', providers: [
      { id: 'first', baseUrl: 'https://api.lmuai.ai', model: 'example-a', apiKeyEnv: 'FIXTURE_BALANCE_A' },
      { id: 'second', baseUrl: 'https://openrouter.ai/api/v1', model: 'example-b', apiKeyEnv: 'FIXTURE_BALANCE_B', balance: true },
    ] }
    const cfg = { lanes: { lead: lane } }
    assert.equal((await getUsage(cfg)).lanes.lead.balance, undefined)
    assert.equal(calls.length, 0)
    lane.providers[0].balance = true
    assert.deepEqual((await getUsage(cfg)).lanes.lead.balance, { total: 0, unit: 'USD', available: false })
    await getUsage(cfg)
    assert.equal(calls.length, 1)
    lane.active = 'second'
    assert.equal((await getUsage(cfg, { includeBalance: false })).lanes.lead.balance, undefined)
    assert.equal(calls.length, 1)
    assert.equal((await getUsage(cfg)).lanes.lead.balance.total, 7.5)
    assert.deepEqual(calls, [
      { url: 'https://api.lmuai.ai/v1/user/balance', auth: 'Bearer fixture-balance-a', redirect: 'error' },
      { url: 'https://openrouter.ai/api/v1/key', auth: 'Bearer fixture-balance-b', redirect: 'error' },
    ])
  } finally {
    globalThis.fetch = saved
    process.env.FOUNDRY_MOCK = '1'
    delete process.env.FIXTURE_BALANCE_A
    delete process.env.FIXTURE_BALANCE_B
  }
})
