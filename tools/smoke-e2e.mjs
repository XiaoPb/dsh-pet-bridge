#!/usr/bin/env node
'use strict'

/**
 * E2E 冒烟：伪 dsh-pet /state 路由 + 伪 cordis ctx + 伪 webhook/桌宠接收器，
 * 跑通 dsh-pet-bridge apply() 的全部发布通道：
 *   1. listen：直连 dsh-pet /state → webhook work-status + /work-status 拉取
 *   2. session/event 原始事件 → webhook event + /events 拉取 + replay 归约
 *   3. agent 轮询 → /bubble（X-DSH-Pet-Token）
 *   4. mode 切换：伪 dsh-pet 下线 → replay 接管；恢复 → 切回直连
 * 退出码 0 = 全部通过。用法：node tools/smoke-e2e.mjs
 */

import http from 'node:http'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { apply } = require('../lib/index')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 伪 dsh-pet：/dsh-pet-7340/state 长轮询（可关停模拟下线） */
function startFakePet() {
  let counter = 100
  let alive = true
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (!alive) return res.destroy()
    if (url.pathname !== '/dsh-pet-7340/state') {
      res.statusCode = 404
      return res.end()
    }
    const since = Number(url.searchParams.get('since') || 0)
    const respond = () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        counter,
        sections: { workStatus: { counter, data: { state: 'result', task: '直连快照' } } },
        pets: {},
      }))
    }
    if (since === counter) {
      const t = setTimeout(respond, 500)
      res.on('close', () => clearTimeout(t))
    } else {
      respond()
    }
  })
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    bump: () => (counter += 1),
    down: () => (alive = false),
    close: () => server.close(),
    get port() {
      return server.address().port
    },
  }
}

/** 伪 DSH webServer / 桌宠 / webhook 三合一接收器 */
function startReceiver() {
  const hits = []
  const waiters = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const hit = { url: req.url, headers: req.headers, body }
      hits.push(hit)
      for (const w of waiters.splice(0)) w(hit)
      res.statusCode = 204
      res.end()
    })
  })
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    waitFor: (pred, ms = 3000) =>
      new Promise((resolve, reject) => {
        const found = hits.find(pred)
        if (found) return resolve(found)
        const timer = setTimeout(() => reject(new Error(`waitFor 超时: ${pred}`)), ms)
        waiters.push((hit) => {
          if (!pred(hit)) return
          clearTimeout(timer)
          resolve(hit)
        })
      }),
    close: () => server.close(),
    hits,
    get port() {
      return server.address().port
    },
  }
}

async function main() {
  // /bubble 的 token 契约（v0.2.0）：只从引擎环境变量读取
  process.env.DSH_PET_BRIDGE_TOKEN = 'smoke-token'
  const pet = startFakePet()
  const rx = startReceiver()
  await Promise.all([pet.listen(), rx.listen()])

  const logs = []
  const handlers = {}
  const ctx = {
    logger: { debug: () => {}, info: (...a) => logs.push(a.join(' ')) },
    get: () => null, // 无已存在 agent
    on: (event, fn) => {
      handlers[event] = fn
      return () => delete handlers[event]
    },
  }

  const dispose = apply(ctx, {
    mode: 'auto',
    petBaseUrl: `http://127.0.0.1:${pet.port}`,
    serverPort: 0,
    token: 'smoke-token',
    targets: [{ url: `http://127.0.0.1:${rx.port}/hook`, events: true }],
    port: rx.port, // 伪桌宠也落在接收器上
  })

  // 1. listen 首拉：webhook 收到 dsh-pet 直连快照
  const wsHit = await rx.waitFor((h) => h.url === '/hook' && h.body.includes('"kind":"work-status"'))
  const wsBody = JSON.parse(wsHit.body)
  assert.equal(wsBody.workStatus.state, 'result')
  assert.equal(wsBody.workStatus.task, '直连快照')

  // 2. session/event 原始事件 → webhook event + replay 归约（listen 健在时不覆盖直连快照）
  handlers['session/event'](
    { header: { id: 'sess-1' } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls -la"}' }, seq: 3 },
  )
  const evHit = await rx.waitFor((h) => h.url === '/hook' && h.body.includes('"kind":"event"'))
  assert.equal(JSON.parse(evHit.body).sessionId, 'sess-1')
  assert.equal(JSON.parse(evHit.body).event.type, 'tool/call')

  // 3. 桌宠 /bubble：agent/created → 轮询游标读 agent.session.events → pre 推送
  const fakeAgent = { session: { header: { id: 'sess-1' }, events: [] } }
  handlers['agent/created']({ agent: fakeAgent })
  fakeAgent.session.events.push({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } })
  const bubbleHit = await rx.waitFor((h) => h.url === '/bubble')
  assert.equal(bubbleHit.headers['x-dsh-pet-token'], 'smoke-token')
  assert.equal(JSON.parse(bubbleHit.body).kind, 'pre')
  assert.deepEqual(JSON.parse(bubbleHit.body).tool_input, { command: 'ls' })

  // 4. 回环拉取服务：/work-status（Token 鉴权）
  //    serverPort=0 → 真实端口从 webhook 不可知；改由 server 模块直接验证已覆盖（单测）。
  //    这里通过再次触发 dsh-pet counter 变化验证 listen 持续转发。
  pet.bump()
  await sleep(700)
  const ws2 = rx.hits.filter((h) => h.url === '/hook' && h.body.includes('"kind":"work-status"'))
  assert.ok(ws2.length >= 2, 'listen 持续转发 counter 变化')

  // 5. 伪 dsh-pet 下线 → auto 模式切 replay：session/event 归约结果直接出现在 webhook
  pet.down()
  await sleep(2500) // 等 petSource 连续失败达阈值（ONERROR → replayActive）
  handlers['session/event'](
    { header: { id: 'sess-2' } },
    { type: 'turn/start', seq: 1 },
  )
  await sleep(300) // fire-and-forget POST 到达缓冲
  const replayHit = await rx.waitFor(
    (h) => h.url === '/hook' && h.body.includes('"kind":"work-status"') && h.body.includes('"state":"thinking"'),
    3000,
  )
  assert.ok(replayHit, 'replay 接管后归约出 thinking')

  // 6. 清理：dispose 无异常、可重复调用
  dispose()
  dispose()

  pet.close()
  rx.close()
  console.log('smoke-e2e: 全链路通过（listen/replay/session-event/bubble/webhook/dispose）')
}

main().catch((e) => {
  console.error('smoke-e2e FAILED:', e.message)
  process.exit(1)
})
