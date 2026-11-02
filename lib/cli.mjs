#!/usr/bin/env node
/**
 * 命令行入口：不经过 DSH 也能跑。
 *   node lib/cli.mjs probe
 *   node lib/cli.mjs run --topic "..." [--field 领域] [--constraints "..."] [--anchors 文件]
 *   node lib/cli.mjs list
 *   node lib/cli.mjs show <runId>
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolveConfig, maskConfig, CONFIG_PATH, FOUNDRY_HOME, saveConfig, defaultConfig } from './engine/config.mjs'
import { probeLanes } from './engine/lanes.mjs'
import { runFoundry } from './engine/protocol.mjs'
import { runRoundtable } from './engine/roundtable.mjs'
import { readIndex } from './engine/store.mjs'
import { join } from 'node:path'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i += 1 } else out[key] = true
    } else out._.push(a)
  }
  return out
}

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const args = parseArgs(argv.slice(1))

async function main() {
  if (cmd === 'help' || cmd === '--help') {
    console.log(readFileSync(new URL('./CLI_HELP.txt', import.meta.url), 'utf8').trim())
    return
  }

  if (cmd === 'init') {
    saveConfig(defaultConfig())
    console.log(`已写入默认配置：${CONFIG_PATH}`)
    return
  }

  const cfg = await resolveConfig(args.lead ? { protocol: { controller: args.lead } } : {})

  if (cmd === 'probe') {
    console.log(`DSH_HOME=${FOUNDRY_HOME}`)
    console.log(JSON.stringify(maskConfig(cfg).lanes, null, 2))
    console.log('探针结果：')
    const r = await probeLanes(cfg)
    for (const [lane, v] of Object.entries(r)) {
      console.log(`  ${v.ok ? '✓' : '✗'} ${lane.padEnd(9)} ${v.ok ? `${v.model} · ${v.ms}ms` : v.error}`)
    }
    process.exitCode = Object.values(r).every((v) => v.ok) ? 0 : 1
    return
  }

  if (cmd === 'run') {
    if (!args.topic) throw new Error('缺少 --topic')
    const anchors = args.anchors && !args.anchors.startsWith?.('--')
      ? safeRead(args.anchors)
      : (typeof args.anchors === 'string' ? args.anchors : '')
    const input = {
      topic: String(args.topic),
      field: args.field ? String(args.field) : '',
      constraints: args.constraints ? String(args.constraints) : '',
      anchors,
      goal: args.goal ? String(args.goal) : '',
    }
    const t0 = Date.now()
    const mode = args.mode === 'ideate' ? 'ideate' : 'paper'
    const onEvent = (ev) => {
      const t = ((Date.now() - t0) / 1000).toFixed(1)
      if (ev.type === 'lane-start') console.log(`  [${t}s] → ${ev.phase || ev.stage}/${ev.lane}`)
      else if (ev.type === 'lane-done') console.log(`  [${t}s] ✓ ${ev.phase || ev.stage}/${ev.lane} ${ev.ms ? Math.round(ev.ms / 1000) + 's' : ''}`)
      else if (ev.type === 'lane-error') console.log(`  [${t}s] ✗ ${ev.phase || ev.stage}/${ev.lane}: ${ev.error}`)
      else if (ev.type === 'phase') console.log(`\n[${t}s] ${ev.phase}: ${ev.message}`)
      else if (ev.type === 'stage') console.log(`\n[${t}s] ${ev.stage}: ${ev.message}`)
      else if (ev.type === 'stage-degraded') console.log(`  ⚠ ${ev.message}`)
      else if (ev.type === 'transcript') console.log(`\n—— ${ev.entry.role}（${ev.entry.phase}）——\n${String(ev.entry.text).slice(0, 700)}`)
    }
    const run = mode === 'paper' ? await runRoundtable({
      input: { ...input, venue: args.venue || cfg.venue, mode },
      cfg, onEvent,
    }) : await runFoundry({
      input,
      cfg,
      cfg, onEvent,
    })
    console.log(`\n产物目录：${run.dir}`)
    if (run.degraded?.length) console.log(`降级：${run.degraded.join(', ')}`)
    const main = mode === 'paper' ? 'plan.md' : 'proposals.md'
    const p2 = join(run.dir, main)
    if (existsSync(p2)) console.log('\n' + readFileSync(p2, 'utf8').split('\n').slice(0, 60).join('\n'))
    return
  }

  if (cmd === 'list') {
    const idx = readIndex(cfg.vault)
    if (!idx.length) { console.log('还没有运行记录。'); return }
    for (const e of idx.slice(0, 20)) {
      console.log(`${e.id}  ${e.seedCount} 想法 / ${e.proposalCount} 提案  ${e.topIdea}`)
    }
    return
  }

  if (cmd === 'show') {
    const id = args._[0]
    if (!id) throw new Error('缺少 runId')
    console.log(readFileSync(join(cfg.vault, 'runs', id, args.file || 'proposals.md'), 'utf8'))
    return
  }

  throw new Error(`未知命令 ${cmd}`)
}

function safeRead(p) {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

main().catch((err) => {
  console.error('错误：' + (err?.stack || err))
  process.exitCode = 1
})
