import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtime = mkdtempSync(join(tmpdir(), 'foundry-release-test-'))
process.env.FOUNDRY_HOME = runtime
process.env.FOUNDRY_MOCK = '1'
delete process.env.FOUNDRY_SKILLS_DIR
delete process.env.FOUNDRY_WORKER_API_KEY
delete process.env.FOUNDRY_CONTROLLER_API_KEY
delete process.env.UNUSED_LEGACY_TOKEN
const config = await import('../lib/engine/config.mjs')
const knowledge = await import('../lib/engine/knowledge.mjs')
const command = await import('../lib/engine/command.mjs')
const usage = await import('../lib/engine/usage.mjs')
after(() => rmSync(runtime, { recursive: true, force: true }))

test('explicit credentials are redacted and environment keys are not persisted', async () => {
  process.env.FOUNDRY_WORKER_API_KEY = 'fixture-only-worker'
  process.env.FOUNDRY_CONTROLLER_API_KEY = 'fixture-only-controller'
  const oldFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('unexpected discovery request') }
  try {
    const cfg = await config.resolveConfig()
    assert.equal(cfg.lanes.worker.apiKey, process.env.FOUNDRY_WORKER_API_KEY)
    assert.equal(cfg.lanes.controller.apiKey, process.env.FOUNDRY_CONTROLLER_API_KEY)
    assert.equal(config.maskConfig(cfg).lanes.controller.apiKey, '[REDACTED]')
    assert.equal(existsSync(config.CONFIG_PATH), false)
    const stats = await usage.getUsage(cfg)
    assert.equal(stats.lanes.controller.quota, undefined)
    assert.equal(stats.lanes.worker.rateLimits, undefined)
  } finally {
    globalThis.fetch = oldFetch
    delete process.env.FOUNDRY_WORKER_API_KEY
    delete process.env.FOUNDRY_CONTROLLER_API_KEY
  }
})

test('default knowledge is empty and explicitly listed sources are selected', () => {
  assert.deepEqual(knowledge.knowledgeSources(config.defaultConfig()), [])
  assert.deepEqual(knowledge.listSkills(), [])
  const sources = knowledge.knowledgeSources({ knowledge: { extraSources: [join(runtime, 'approved.md')] } })
  assert.equal(sources.length, 1)
  assert.equal(sources[0].path, join(runtime, 'approved.md'))
})

test('mock controller dispatches, reviews, finishes and reloads a persisted session', { timeout: 20000 }, async () => {
  const cfg = config.defaultConfig()
  const session = command.createSession({ vault: cfg.vault, title: 'Public algorithm comparison', context: {}, materialPaths: [] })
  const turn = command.sendMessage(session, 'Compare two example algorithms and list evidence gaps.', cfg,
    { workers: ['worker'], cross: true, oral: false, autopilot: false, maxSteps: 1 })
  const deadline = Date.now() + 15000
  while (session.status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 30))
  assert.notEqual(session.status, 'running')
  assert.equal(turn.error, null)
  assert.ok(turn.final.length > 0)
  assert.ok(turn.tasks.length >= 1)
  assert.ok(turn.tasks.every(t => t.report.length > 0))
  assert.ok(turn.ledger.length >= 1)
  assert.equal(session.autopilot.enabled, false)
  const file = join(cfg.vault, 'sessions', session.id, 'session.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.turns[0].final, turn.final)
  command.loadSessions(cfg.vault)
  assert.ok(command.listSessions().some(s => s.id === session.id))
})

const waitForIdle = async session => {
  const deadline = Date.now() + 15000
  while ((session.status === 'running' || session.phase !== 'idle') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
  assert.equal(session.status, 'idle')
  assert.equal(session.phase, 'idle')
}

function roster(count) {
  return config.loadConfig({
    lanes: Object.fromEntries(['boss-X', ...Array.from({ length: count - 1 }, (_, i) => `agent_${i + 1}`)].map(id => [id,
      { kind: 'openai', label: id, model: 'example-model', enabled: true }])),
    protocol: { controller: 'boss-X', reviewRounds: 2, reviewPassRatio: 0.8 },
  })
}

for (const count of [2, 3, 4]) test(`custom ${count}-participant roster routes all controller phases and workers`, { timeout: 20000 }, async () => {
  const cfg = roster(count)
  assert.equal(Object.keys(cfg.lanes).length, count)
  const session = command.createSession({ vault: cfg.vault, title: `Custom ${count}`, context: {}, materialPaths: [] })
  const turn = command.sendMessage(session, 'Mock evidence comparison', cfg, { oral: true, maxSteps: 2, autopilot: false })
  await waitForIdle(session)
  assert.equal(turn.error, null)
  assert.ok(turn.final)
  assert.deepEqual([...new Set(turn.tasks.map(t => t.worker))].sort(), config.workerLanes(cfg).sort())
  assert.ok(turn.entries.filter(e => ['plan', 'judge', 'final', 'knowledge'].includes(e.kind)).every(e => e.lane === 'boss-X'))
  const controllerCalls = turn.calls.filter(c => /mainline|moderate/.test(c.tag || ''))
  assert.ok(controllerCalls.some(c => c.tag === 'mainline'))
  assert.ok(controllerCalls.some(c => c.tag.startsWith('moderate')))
  assert.ok(controllerCalls.every(c => c.lane === 'boss-X'))
  assert.ok(turn.disputes.length > 0)
  assert.ok(turn.disputes.every(d => d.done && d.history?.some(h => h.lane === 'boss-X')))
  const result = session.oral[0]
  assert.equal(result.planned, count * 2)
  assert.equal(result.votes.length, count * 2)
  assert.equal(result.threshold, Math.ceil(count * 2 * 0.8))
  assert.equal(result.complete, true)
  assert.equal(result.passed, result.positives >= result.threshold)
  const reused = await command.runOralPanel(session, cfg, result.contribution)
  assert.equal(reused.reused, true)
  const changed = await command.runOralPanel(session, { ...cfg, protocol: { ...cfg.protocol, reviewers: ['agent_1'], reviewRounds: 1 } }, result.contribution)
  assert.notEqual(changed.versionHash, result.versionHash)
  assert.equal(changed.planned, 1)
  const newModel = { ...cfg, lanes: { ...cfg.lanes, agent_1: { ...cfg.lanes.agent_1, model: 'other-model' } } }
  const reconfigured = await command.runOralPanel(session, newModel, result.contribution)
  assert.notEqual(reconfigured.versionHash, result.versionHash)
})

test('invalid/disabled roles fail clearly and legacy controller IDs remain supported', () => {
  const cfg = roster(2)
  assert.throws(() => config.workerLanes(cfg, ['boss-X']))
  assert.throws(() => config.workerLanes(cfg, ['missing']))
  assert.throws(() => config.workerLanes(cfg, []))
  cfg.lanes['boss-X'].enabled = false
  assert.throws(() => config.controllerLane(cfg))
  const old = config.loadConfig({ lanes: { claude: { kind: 'anthropic' }, chatgpt: { kind: 'codex' } }, protocol: { lead: 'claude' } })
  assert.equal(config.controllerLane(old), 'claude')
  assert.deepEqual(config.workerLanes(old), ['chatgpt'])
})

test('generic HTTP adapter uses custom endpoint/model and allows keyless local endpoints', async () => {
  const { callLane } = await import('../lib/engine/lanes.mjs')
  const oldFetch = globalThis.fetch
  let observed
  globalThis.fetch = async (url, init) => {
    observed = { url, headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'example answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }), { status: 200 })
  }
  try {
    const cfg = { lanes: { local: { kind: 'openai', baseUrl: 'http://localhost:1234/v1/', model: 'custom-model' } }, protocol: { retries: 0 } }
    const result = await callLane('local', cfg, { system: 'role', user: 'task', maxTokens: 23 })
    assert.equal(result.text, 'example answer')
    assert.equal(observed.url, 'http://localhost:1234/v1/chat/completions')
    assert.equal(observed.body.model, 'custom-model')
    assert.equal(observed.body.max_tokens, 23)
    assert.equal(observed.headers.authorization, undefined)
  } finally { globalThis.fetch = oldFetch }
})

test('provider failover isolates keys and keeps response bodies out of diagnostics', async () => {
  const { callLane, providerStatus } = await import('../lib/engine/lanes.mjs')
  const originalFetch = globalThis.fetch
  const seen = []
  process.env.FOUNDRY_TEST_PROVIDER_ONE = 'fixture-one'
  process.env.FOUNDRY_TEST_PROVIDER_TWO = 'fixture-two'
  globalThis.fetch = async (url, { headers }) => {
    seen.push([new URL(url).hostname, headers.authorization])
    if (seen.length === 1) return new Response('private-response-body', { status: 503 })
    return Response.json({ choices: [{ message: { content: 'fallback answer' } }] })
  }
  const cfg = { lanes: { lead: { kind: 'openai', model: 'fixture-model', providers: [
    { id: 'one', baseUrl: 'https://one.example.invalid/v1', apiKeyEnv: 'FOUNDRY_TEST_PROVIDER_ONE' },
    { id: 'two', baseUrl: 'https://two.example.invalid/v1', apiKeyEnv: 'FOUNDRY_TEST_PROVIDER_TWO' },
  ] } }, protocol: { retries: 0 } }
  try {
    const result = await callLane('lead', cfg, { system: 'role', user: 'task' })
    assert.equal(result.provider, 'two')
    assert.deepEqual(seen, [['one.example.invalid', 'Bearer fixture-one'], ['two.example.invalid', 'Bearer fixture-two']])
    assert.equal(providerStatus('lead').one.ok, false)
    assert.equal(providerStatus('lead').two.ok, true)
    assert.ok(!JSON.stringify(providerStatus('lead')).includes('private-response-body'))
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.FOUNDRY_TEST_PROVIDER_ONE
    delete process.env.FOUNDRY_TEST_PROVIDER_TWO
  }
})
