#!/usr/bin/env node
/**
 * 独立本地服务：同一套引擎 + 同一个 GUI，不依赖 DSH 插件装载。
 *   node lib/server.mjs [--port 8787] [--host 127.0.0.1]
 * 打开 http://127.0.0.1:8787/ 即多模型圆桌看板。
 */
import { createServer } from 'node:http'
import { resolveConfig, CONFIG_PATH } from './engine/config.mjs'
import { handle, ROUTE, initCommand } from './runtime.mjs'
import { statusSnapshot, askStatus } from './engine/command.mjs'
import { getUsage } from './engine/usage.mjs'

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = Number(argOf('port', process.env.FOUNDRY_PORT || 8787))
const HOST = argOf('host', '127.0.0.1')

const cfg = await resolveConfig({})

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(302, { location: `${ROUTE}/` })
    return res.end()
  }
  // 让根路径下的静态资源也能取到（万一有人直接开 /app.js）
  if (url.pathname === '/app.js' || url.pathname === '/app.css') {
    req.url = `${ROUTE}${url.pathname}`
  }
  // 任何不认识的 GET 都送回看板（这是专用服务，不是通用文件服务器）
  if (req.method === 'GET'
    && !url.pathname.startsWith(ROUTE) && !url.pathname.startsWith('/api/')
    && url.pathname !== '/app.js' && url.pathname !== '/app.css') {
    res.writeHead(302, { location: `${ROUTE}/` })
    return res.end()
  }
  // 兼容 /api/* 直接访问（本服务根路径即应用根）
  if (url.pathname.startsWith('/api/')) {
    req.url = `${ROUTE}${req.url}`
  }
  handle(req, res, {}).catch((err) => {
    try {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
    } catch { /* ignore */ }
  })
})

/* 状态端口：只读，随时问总控 任何会话的状态。
 *   curl 127.0.0.1:8788/            → 全部会话快照（JSON）
 *   curl '127.0.0.1:8788/ask?q=现在在干嘛'  → 总控用中文回答
 */
const STATUS_PORT = Number(argOf('status-port', process.env.FOUNDRY_STATUS_PORT || PORT + 1))
const statusServer = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`)
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  try {
    const c = await initCommand({})
    const id = url.searchParams.get('id') || undefined
    if (url.pathname === '/' || url.pathname === '/status') return send(200, { now: new Date().toISOString(), sessions: statusSnapshot({ sessionId: id }) })
    if (url.pathname === '/usage') return send(200, await getUsage(c, { force: url.searchParams.get('refresh') === '1' }))
    if (url.pathname === '/ask') {
      const q = url.searchParams.get('q') || '现在各会话进展如何？卡在哪？'
      const r = await askStatus(c, q, { sessionId: id })
      return url.searchParams.get('format') === 'json' ? send(200, r) : send(200, r.answer + '\n', 'text/plain; charset=utf-8')
    }
    return send(404, { error: 'use / or /ask?q=...' })
  } catch (err) { return send(500, { error: String(err?.message || err) }) }
})
statusServer.on('error', (err) => console.log(`status port ${STATUS_PORT} unavailable: ${err.message}`))
statusServer.listen(STATUS_PORT, HOST, () => console.log(`status: http://${HOST}:${STATUS_PORT}/  ·  /ask?q=...`))

server.listen(PORT, HOST, () => {
  void initCommand({})
  console.log(`JoFoundry GUI: http://${HOST}:${PORT}/`)
  console.log(`config: ${CONFIG_PATH}`)
  console.log(`vault : ${cfg.vault}`)
  console.log(`lanes : ${Object.entries(cfg.lanes).map(([k, v]) => `${k}=${v.model || v.kind}`).join(' · ')}`)
})
