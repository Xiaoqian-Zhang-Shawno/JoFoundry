#!/usr/bin/env node
// Run with Node.js 22 or newer. All prompts and replies are synthetic and stay on loopback.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const host = '127.0.0.1'
const workspace = fileURLToPath(new URL('../lib/server.mjs', import.meta.url))
const firstInput = 'First synthetic review. Required result A-17 has not arrived.'
const evidenceInput = 'Fresh evidence A-17: expected result now available.'
const objective = 'Check the synthetic result A-17 before advancing.'
const followUp = 'Run the fixture continuation without additional evidence.'
const reviewScript = []

async function listen(server) {
  server.listen(0, host)
  await once(server, 'listening')
  return server.address().port
}

async function freePort() {
  const listener = createServer()
  const port = await listen(listener)
  await new Promise((done) => listener.close(done))
  return port
}

function fixtureResponse(system, user) {
  if (system.startsWith('你是总控，本次多 Agent')) {
    return JSON.stringify({ understanding: 'Synthetic control-flow check', tasks: {} })
  }
  if (system.startsWith('你是总控，给用户写最终答复')) {
    const turnInput = user.split('【用户本轮消息】').at(-1).split('【你的理解】')[0]
    const marker = turnInput.includes(firstInput) ? 'FIXTURE_PENDING'
      : turnInput.includes(evidenceInput) ? 'FIXTURE_DELIVERED' : 'FIXTURE_CONTINUED'
    return '## 结论\n' + marker
  }
  if (system.startsWith('你是主持人，用户让你协助')) {
    const finalBlock = user.split('【本回合结论】').at(-1)
    const marker = finalBlock.match(/FIXTURE_(?:PENDING|DELIVERED|CONTINUED)/)?.[0]
    assert.ok(marker, 'fixture marker missing')
    reviewScript.push(marker)
    const pending = marker === 'FIXTURE_PENDING'
    return JSON.stringify({
      direction: objective,
      stage: 'explore',
      decision: pending ? 'continue' : 'finish',
      reason: 'Scripted fixture response',
      next_message: pending ? followUp : '',
      evidence_review: {
        stage: 'minimal_check',
        disposition: pending ? 'wait' : 'advance',
        evidence: pending ? [] : [marker],
        next_trigger: pending ? 'Wait for A-17 from its owner.' : 'Record the fixture result.',
      },
    })
  }
  throw new Error('Unexpected prompt in validation fixture')
}

const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/chat/completions')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { model, messages } = JSON.parse(Buffer.concat(chunks))
    const content = fixtureResponse(messages[0].content, messages[1].content)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content } }] }))
  } catch (err) {
    res.writeHead(422).end(String(err))
  }
})

async function until(read, label) {
  const deadline = Date.now() + 6000
  do {
    const result = await read()
    if (result) return result
    await sleep(20)
  } while (Date.now() < deadline)
  throw new Error('Timed out: ' + label)
}

const home = await mkdtemp(join(tmpdir(), 'jofoundry-validation-'))
let app
async function stop() {
  if (!app) return
  const running = app
  app = null
  if (running.exitCode === null && running.signalCode === null) {
    const closed = once(running, 'exit')
    running.kill('SIGTERM')
    await closed
  }
}

async function start(providerPort) {
  const port = await freePort()
  let statusPort
  do { statusPort = await freePort() } while (statusPort === port)
  const apiBase = 'http://' + host + ':' + port + '/.research-foundry/api/cmd/'
  const statusBase = 'http://' + host + ':' + statusPort
  const endpoint = 'http://' + host + ':' + providerPort + '/v1'
  app = spawn(process.execPath, [workspace, '--port', String(port), '--status-port', String(statusPort)], {
    env: {
      FOUNDRY_HOME: home, DSH_HOME: home,
      FOUNDRY_CONTROLLER_BASE_URL: endpoint, FOUNDRY_CONTROLLER_MODEL: 'fixture-controller',
      FOUNDRY_WORKER_BASE_URL: endpoint, FOUNDRY_WORKER_MODEL: 'fixture-worker',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  async function request(path, body, status = 200) {
    const response = await fetch(apiBase + path, {
      signal: AbortSignal.timeout(1500),
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
    })
    assert.equal(response.status, status)
    return response.json()
  }
  await until(async () => {
    try {
      return await request('meta')
    } catch (err) {
      if (app.exitCode !== null) throw err
      return false
    }
  }, 'app startup')
  return { request, statusBase }
}

function summary(session) {
  return {
    turns: session.turns.length,
    automatic_turns: session.turns.filter((turn) => turn.auto).length,
    goal_state: session.autopilot.state,
    objective_retained: session.autopilot.objective === objective,
    latest_disposition: session.turns.at(-1)?.next?.evidenceReview?.disposition ?? null,
    next_trigger: session.turns.at(-1)?.next?.evidenceReview?.nextTrigger ?? null,
  }
}

try {
  const providerPort = await listen(provider)
  let { request } = await start(providerPort)
  const { project } = await request('projects', { name: 'Synthetic project A' })
  const { project: other } = await request('projects', { name: 'Synthetic project B' })
  const newSession = async (workflow) => (await request('session', {
    title: 'Fixture ' + workflow, projectId: project.id, mission: objective, workflow,
  })).session
  const get = async (id) => (await request('session?id=' + id)).session
  const submitInitial = async ({ id }) => request('message', {
    id, projectId: project.id, message: firstInput, oral: false, autopilot: true,
  })
  const atState = async (id, state) => until(async () => {
    const session = await get(id)
    return session.status === 'idle' && session.autopilot.state === state && session
  }, state)

  const standard = await newSession('standard')
  await submitInitial(standard)
  const comparison = summary(await atState(standard.id, 'complete'))
  assert.equal(comparison.turns, 2)
  assert.equal(comparison.automatic_turns, 1)

  const evidence = await newSession('evidence')
  const id = evidence.id
  await submitInitial(evidence)
  const beforeRestart = summary(await atState(id, 'waiting'))
  assert.equal(beforeRestart.turns, 1)
  assert.equal(beforeRestart.automatic_turns, 0)
  assert.equal(beforeRestart.objective_retained, true)
  assert.equal(beforeRestart.latest_disposition, 'wait')
  await stop()
  const restarted = await start(providerPort)
  request = restarted.request
  // The application staggers scheduled restart continuations by 300 ms.
  await sleep(700)
  const afterRestart = summary(await atState(id, 'waiting'))
  assert.deepEqual(afterRestart, beforeRestart)
  const statusResponse = await fetch(restarted.statusBase + '/status?id=' + id, { signal: AbortSignal.timeout(1500) })
  assert.equal(statusResponse.status, 200)
  const status = await statusResponse.json()
  assert.equal(status.sessions[0].mainline.last.evidenceReview.disposition, 'wait')

  const beforeWrongRoute = await get(id)
  await request('queue', { id, projectId: other.id, message: evidenceInput, idleOnly: true }, 409)
  const afterWrongRoute = await get(id)
  assert.deepEqual(afterWrongRoute.turns, beforeWrongRoute.turns)
  assert.deepEqual(afterWrongRoute.pending, beforeWrongRoute.pending)

  const accepted = await request('queue', { id, projectId: project.id, message: evidenceInput, idleOnly: true })
  assert.equal(accepted.started, true)
  assert.equal(accepted.turn.id, 'T2')
  const completed = await atState(id, 'complete')
  assert.equal(completed.projectId, project.id)
  assert.equal(completed.turns.at(-1).user, evidenceInput)
  assert.equal(completed.turns.at(-1).next.evidenceReview.disposition, 'advance')
  assert.equal(completed.turns.length, 2)
  const transcript = await readFile(join(home, 'vault', 'sessions', id, 'transcript.md'), 'utf8')
  assert.match(transcript, /Wait for A-17 from its owner/)
  assert.deepEqual(reviewScript, ['FIXTURE_PENDING', 'FIXTURE_CONTINUED', 'FIXTURE_PENDING', 'FIXTURE_DELIVERED'])
  console.log(JSON.stringify({
    fixture: 'one paired synthetic workflow with a scripted loopback provider',
    standard_before_new_input: comparison,
    evidence_first_before_restart: beforeRestart,
    evidence_first_after_restart: afterRestart,
    cross_project_queue: { http_status: 409, turns_unchanged: true, pending_unchanged: true },
    same_project_delivery: { original_session: true, turn: 'T2', ...summary(completed) },
    external_model_calls: 0,
  }, null, 2))
} finally {
  await stop()
  await new Promise((done) => provider.close(done))
  await rm(home, { recursive: true, force: true })
}
