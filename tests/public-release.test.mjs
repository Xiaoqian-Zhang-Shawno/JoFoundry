import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtime = mkdtempSync(join(tmpdir(), 'foundry-release-test-'))
process.env.FOUNDRY_HOME = runtime
process.env.FOUNDRY_MOCK = '1'
delete process.env.FOUNDRY_SKILLS_DIR
delete process.env.DEEPSEEK_API_KEY
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
const config = await import('../lib/engine/config.mjs')
const knowledge = await import('../lib/engine/knowledge.mjs')
const command = await import('../lib/engine/command.mjs')
const usage = await import('../lib/engine/usage.mjs')
after(() => rmSync(runtime, { recursive: true, force: true }))

test('explicit credentials are redacted and environment keys are not persisted', async () => {
  process.env.DEEPSEEK_API_KEY = 'fixture-only-deepseek'
  process.env.ANTHROPIC_API_KEY = 'fixture-only-anthropic'
  const oldFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('unexpected discovery request') }
  try {
    const cfg = await config.resolveConfig()
    assert.equal(cfg.lanes.deepseek.apiKey, process.env.DEEPSEEK_API_KEY)
    assert.equal(cfg.lanes.claude.apiKey, process.env.ANTHROPIC_API_KEY)
    assert.equal(config.maskConfig(cfg).lanes.claude.apiKey, '[REDACTED]')
    assert.equal(existsSync(config.CONFIG_PATH), false)
    const stats = await usage.getUsage(cfg)
    assert.equal(stats.lanes.claude.quota, undefined)
    assert.equal(stats.lanes.chatgpt.rateLimits, undefined)
  } finally {
    globalThis.fetch = oldFetch
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.ANTHROPIC_API_KEY
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
    { workers: ['deepseek', 'chatgpt'], cross: true, oral: false, autopilot: false, maxSteps: 1 })
  const deadline = Date.now() + 15000
  while (session.status === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 30))
  assert.notEqual(session.status, 'running')
  assert.equal(turn.error, null)
  assert.ok(turn.final.length > 0)
  assert.ok(turn.tasks.length >= 2)
  assert.ok(turn.tasks.every(t => t.report.length > 0))
  assert.ok(turn.ledger.length >= 2)
  assert.equal(session.autopilot.enabled, false)
  const file = join(cfg.vault, 'sessions', session.id, 'session.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.turns[0].final, turn.final)
  command.loadSessions(cfg.vault)
  assert.ok(command.listSessions().some(s => s.id === session.id))
})
