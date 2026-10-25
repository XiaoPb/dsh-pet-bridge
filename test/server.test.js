'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createBridgeState } = require('../lib/bridgeState')
const { createServer, extractToken, safeEqual } = require('../lib/server')

function get(port, path, headers) {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: headers || {} })
}

test('extractToken 与 safeEqual', () => {
  assert.equal(extractToken({ headers: { 'x-dsh-bridge-token': 'abc' } }), 'abc')
  assert.equal(extractToken({ headers: { authorization: 'Bearer abc' } }), 'abc')
  assert.equal(extractToken({ headers: { authorization: 'bearer abc' } }), 'abc')
  assert.equal(extractToken({ headers: {} }), null)
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual(undefined, ''), true)
})

test('server：/ping 免鉴权；其余 fail-closed 403；带 token 200', async () => {
  const state = createBridgeState()
  const srv = createServer({ port: 0, token: 'secret-token', state })
  assert.equal(await srv.ready, true)
  const port = srv.serverPort()
  assert.ok(typeof port === 'number' && port > 0)

  // /ping 免鉴权
  let resp = await get(port, '/ping')
  assert.equal(resp.status, 200)
  assert.equal((await resp.json()).service, 'dsh-pet-bridge')

  // 无 token / 错 token → 403
  assert.equal((await get(port, '/work-status')).status, 403)
  assert.equal((await get(port, '/work-status', { 'x-dsh-bridge-token': 'wrong' })).status, 403)
  assert.equal((await get(port, '/events', { authorization: 'Bearer wrong' })).status, 403)
  assert.equal((await get(port, '/state')).status, 403)

  // 对 token → 200（Bearer 亦可）
  resp = await get(port, '/work-status', { 'x-dsh-bridge-token': 'secret-token' })
  assert.equal(resp.status, 200)
  assert.equal((await resp.json()).state, null) // 未写入 → 空闲
  resp = await get(port, '/events?limit=5', { authorization: 'Bearer secret-token' })
  assert.equal(resp.status, 200)
  assert.deepEqual((await resp.json()).events, [])

  // 404
  assert.equal((await get(port, '/nope', { 'x-dsh-bridge-token': 'secret-token' })).status, 404)

  srv.close()
})

test('server：/state 无参立即返回；长轮询成对校验；写入即唤醒', async () => {
  const state = createBridgeState()
  const srv = createServer({ port: 0, token: 't', state })
  await srv.ready
  const port = srv.serverPort()
  const auth = { 'x-dsh-bridge-token': 't' }

  // 无参 → 立即返回
  let resp = await get(port, '/state', auth)
  assert.equal(resp.status, 200)
  const snap = await resp.json()
  assert.ok('counter' in snap && 'workStatus' in snap && 'events' in snap)

  // 成对必填
  assert.equal((await get(port, '/state?since=1', auth)).status, 400)
  assert.equal((await get(port, '/state?timeout=100', auth)).status, 400)
  assert.equal((await get(port, '/state?since=-1&timeout=100', auth)).status, 400)
  assert.equal((await get(port, `/state?since=${snap.counter}&timeout=${state.MAX_WAIT_MS + 1}`, auth)).status, 400)

  // since 已最新 → 挂起；写入后立刻返回新状态
  const t0 = Date.now()
  const pending = get(port, `/state?since=${snap.counter}&timeout=5000`, auth)
  await new Promise((r) => setTimeout(r, 50))
  state.writeWorkStatus({ state: 'working', task: 'x', ts: Date.now() })
  resp = await pending
  assert.equal(resp.status, 200)
  const after = await resp.json()
  assert.equal(after.workStatus.data.state, 'working')
  assert.ok(Date.now() - t0 < 5000)

  // 未变化 → 超时返回当前状态
  const t1 = Date.now()
  resp = await get(port, `/state?since=${state.read().counter}&timeout=60`, auth)
  assert.equal(resp.status, 200)
  assert.ok(Date.now() - t1 >= 50)

  srv.close()
})

test('server：未提供 token 时进程内随机生成', async () => {
  delete process.env.DSH_PET_BRIDGE_TOKEN
  const srv = createServer({ port: 0, token: undefined, state: createBridgeState() })
  await srv.ready
  assert.ok(typeof srv.token === 'string' && srv.token.length >= 32)
  assert.equal((await get(srv.serverPort(), '/ping')).status, 200)
  assert.equal((await get(srv.serverPort(), '/work-status', { 'x-dsh-bridge-token': srv.token })).status, 200)
  assert.equal((await get(srv.serverPort(), '/work-status')).status, 403)
  srv.close()
})
