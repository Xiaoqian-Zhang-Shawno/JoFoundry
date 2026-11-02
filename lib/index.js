/**
 * @dsh-external/dsh-research-foundry — 宿主侧插件。
 *
 * 注册 4 个工具 + /.research-foundry/ 的 GUI 路由；逻辑与独立服务共用 lib/runtime.mjs。
 */
import { join } from 'node:path'
import { maskConfig, CONFIG_PATH } from './engine/config.mjs'
import { probeLanes } from './engine/lanes.mjs'
import { readIndex } from './engine/store.mjs'
import { resolveVenue } from './engine/roundtable.mjs'
import { jobs, startRun, getConfig, handle, ROUTE } from './runtime.mjs'

export const name = '@dsh-external/dsh-research-foundry'
export const inject = ['tools']

const text = (s) => [{ type: 'text', text: String(s) }]

export function apply(ctx, pluginConfig = {}) {
  const register = (definition) => ctx.tools.register(definition)

  register({
    name: 'foundry_run',
    description:
      '召集配置的模型开一场「CCF-A 选题圆桌」：' +
      '主持人先立问题陈述 → 三方依次发言且互相看得见 → 倒序反驳并要求裁决实验 → 三种审稿人原型各写一份模拟审稿 → ' +
      '最终产出投稿作战计划（故事线/实验矩阵/时间线/rebuttal 预案/红线）。' +
      '后台运行（约 6-15 分钟），立刻返回 jobId；用 foundry_status 看进度、foundry_read 读产物。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '研究方向或论文想法（越具体越好）' },
        venue: { type: 'string', description: '目标会议，如 neurips / icml / cvpr / acl / osdi / ccs（默认 neurips）' },
        field: { type: 'string', description: '学科领域' },
        constraints: { type: 'string', description: '资源约束，如"1 张 A100、3 个月、无合作者"' },
        deadline: { type: 'string', description: '投稿截止时间' },
        goal: { type: 'string', description: '你的目标，如"今年冲一篇 CCF-A"' },
        anchors: { type: 'string', description: '已有材料：前期结果/数据/关键文献摘要' },
        mode: { type: 'string', description: 'paper（圆桌+模拟审稿，默认）或 ideate（发散+盲评找 idea）' },
        lead: { type: 'string', description: '主持人：已配置的线路 ID' },
      },
      required: ['topic'],
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args) => {
      const topic = String(args?.topic || '').trim()
      if (!topic) throw new Error('foundry_run 需要 topic')
      const cfg = await getConfig(pluginConfig)
      const venue = args?.venue ? resolveVenue(String(args.venue)).name : resolveVenue(cfg.venue || 'neurips').name
      const job = startRun({
        topic,
        field: args?.field ? String(args.field) : '',
        constraints: args?.constraints ? String(args.constraints) : '',
        goal: args?.goal ? String(args.goal) : '',
        deadline: args?.deadline ? String(args.deadline) : '',
        anchors: args?.anchors ? String(args.anchors) : '',
        venue,
        mode: args?.mode === 'ideate' ? 'ideate' : 'paper',
        lead: args?.lead ? String(args.lead) : '',
      }, pluginConfig)
      return [
        `圆桌已开始：jobId=${job.id}`,
        `主题：${topic}　会议：${venue}　模式：${job.mode}`,
        `阵容：${Object.entries(cfg.lanes).filter(([, v]) => v.enabled !== false).map(([k, v]) => `${v.label}(${v.model || 'default'})`).join(' · ')}`,
        '',
        `看板：${ROUTE}/　进度：foundry_status { jobId: "${job.id}" }`,
      ].join('\n')
    },
  })

  register({
    name: 'foundry_status',
    description: '查看圆桌进度（阶段/发言/审稿）。不传 jobId 时列出全部任务与历史运行。',
    parameters: { type: 'object', properties: { jobId: { type: 'string', description: 'jobId（可留空）' } } },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args) => {
      const id = args?.jobId ? String(args.jobId) : ''
      if (id) {
        const job = jobs.get(id)
        if (!job) throw new Error(`找不到 jobId=${id}`)
        return [
          `jobId: ${job.id}　状态: ${job.status}　阶段: ${job.phase}`,
          `主题: ${job.input?.topic}　会议: ${job.venue || '–'}　模式: ${job.mode}`,
          job.runId ? `runId: ${job.runId}` : '',
          job.dir ? `产物: ${job.dir}` : '',
          job.error ? `错误: ${job.error}` : '',
          '',
          '## 已发言',
          ...(job.transcript || []).slice(-6).map((t) => `- [${t.phase}] ${t.role}：${String(t.text).split('\n')[0].slice(0, 100)}`),
          '',
          '## 事件',
          ...job.events.slice(-6).map((e) => '  ' + e),
        ].filter(Boolean).join('\n')
      }
      const lines = []
      if (jobs.size) {
        lines.push('## 本进程任务')
        for (const job of [...jobs.values()].reverse().slice(0, 10)) {
          lines.push(`- ${job.id} [${job.status}] ${job.phase} · ${job.input?.topic}${job.runId ? ` → ${job.runId}` : ''}`)
        }
      } else lines.push('本进程还没有任务。')
      const cfg = await getConfig(pluginConfig)
      const idx = readIndex(cfg.vault)
      if (idx.length) {
        lines.push('', '## 历史运行')
        for (const e of idx.slice(0, 10)) lines.push(`- ${e.id} [${e.mode || 'paper'}] ${e.topIdea}`)
      }
      return lines.join('\n')
    },
  })

  register({
    name: 'foundry_read',
    description: '读取一次圆桌的产物：plan.md（作战计划，默认）、transcript.md（完整讨论）、reviews.json（模拟审稿）、brief.json、run.json。',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '运行 id（可留空 = 最近一次）' },
        file: { type: 'string', description: 'plan.md | transcript.md | reviews.json | brief.json | run.json' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args) => {
      const cfg = await getConfig(pluginConfig)
      const file = String(args?.file || 'plan.md')
      if (!/^[\w.-]+$/.test(file)) throw new Error('非法文件名')
      const { readFileSync, existsSync } = await import('node:fs')
      let runId = args?.runId ? String(args.runId) : ''
      if (!runId) {
        const latest = [...jobs.values()].reverse().find((j) => j.runId)?.runId
        runId = latest || readIndex(cfg.vault)[0]?.id || ''
      }
      if (!runId) throw new Error('还没有任何运行记录')
      const dir = join(cfg.vault, 'runs', runId)
      for (const f of [file, file === 'plan.md' ? 'proposals.md' : ''].filter(Boolean)) {
        const p = join(dir, f)
        if (existsSync(p)) {
          const content = readFileSync(p, 'utf8')
          return `# ${runId}/${f}\n\n${content.length > 60000 ? content.slice(0, 60000) + '\n…（已截断）' : content}`
        }
      }
      throw new Error(`没有这个产物：${dir}/${file}`)
    },
  })

  register({
    name: 'foundry_probe',
    description: '探查已配置的模型线路是否可用。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    timeoutMs: 240000,
    execute: async () => {
      const cfg = await getConfig(pluginConfig)
      const res = await probeLanes(cfg)
      const lines = [`配置文件：${CONFIG_PATH}`, `vault：${cfg.vault}`, '']
      for (const [lane, v] of Object.entries(res)) {
        lines.push(`${v.ok ? '✓' : '✗'} ${lane.padEnd(9)} ${v.ok ? `${v.model} · ${v.ms}ms` : v.error}`)
      }
      lines.push('', '配置（密钥脱敏）：', JSON.stringify(maskConfig(cfg).lanes, null, 2))
      return lines.join('\n')
    },
  })

  const ws = ctx.get ? ctx.get('webServer') : ctx.webServer
  if (ws && typeof ws.register === 'function') {
    ws.register({ kind: 'prefix', path: ROUTE, handler: (req, res) => handle(req, res, pluginConfig) })
    ctx.logger?.info?.(`[research-foundry] GUI: ${ROUTE}/`)
  } else {
    ctx.logger?.warn?.('[research-foundry] webServer 不可用，GUI 未注册（工具仍可用）')
  }
}

export function dispose() {
  for (const job of jobs.values()) { try { job.controller.abort() } catch { /* ignore */ } }
  jobs.clear()
}
