'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { publish, buildEnvelope, DEFAULT_HEADER } = require('../lib/publisher')

/** 起一个一次性接收器：resolve({headers, body, url, status}) */
function startReceiver() {
  return new Promise((resolve) => {
    const hits = []
    let resolveFirst
    const first = new Promise((r) => (resolveFirst = r))
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hits.push({ headers: req.headers, body, url: req.url })
        res.statusCode = 204
        res.end()
        resolveFirst(hits[0])
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        first,
        hits,
        close: () => server.close(),
      })
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('buildEnvelope 形状', () => {
  const env = buildEnvelope('work-status', { workStatus: { state: 'working', task: null, ts: 1 } })
  assert.equal(env.version, 1)
  assert.equal(env.source, 'dsh-pet-bridge')
  assert.equal(env.kind, 'work-status')
  assert.ok(typeof env.sentAt === 'number')
  assert.deepEqual(env.workStatus, { state: 'working', task: null, ts: 1 })
})

test('publish：携带默认鉴权头 + 显式 Content-Length + 事件目标过滤', async () => {
  const rx = await startReceiver()
  try {
    const targets = [
      { url: `http://127.0.0.1:${rx.port}/hook`, token: 'tok-1' },
      { url: `http://127.0.0.1:${rx.port}/events`, token: 'tok-2', events: true },
    ]
    publish(targets, 'work-status', { workStatus: { state: 'thinking', task: null, ts: 9 } }, () => {})
    await sleep(50)
    assert.equal(rx.hits.length, 2) // work-status 推给全部目标
    const hit = rx.hits.find((h) => h.url === '/hook')
    assert.ok(hit, '未订阅 events 的目标照收 work-status')
    assert.equal(hit.headers[DEFAULT_HEADER.toLowerCase()], 'tok-1')
    assert.equal(hit.headers['content-length'], String(Buffer.byteLength(hit.body)))
    const parsed = JSON.parse(hit.body)
    assert.equal(parsed.kind, 'work-status')
    assert.equal(parsed.workStatus.state, 'thinking')

    // kind=event：只有 events=true 的目标收到
    publish(targets, 'event', { sessionId: 's', event: { type: 'turn/start' } }, () => {})
    await sleep(100)
    const hookHits = rx.hits.filter((h) => h.url === '/hook')
    const eventHits = rx.hits.filter((h) => h.url === '/events')
    assert.equal(hookHits.length, 1) // /hook 未订阅 events：只收 work-status
    assert.equal(eventHits.length, 2) // /events 订阅了：work-status + event 各一条
    const eventHit = eventHits[1]
    assert.equal(eventHit.headers[DEFAULT_HEADER.toLowerCase()], 'tok-2')
    assert.equal(JSON.parse(eventHit.body).kind, 'event')
  } finally {
    rx.close()
  }
})

test('publish：非法 URL / 非 http(s) 静默跳过，不抛', () => {
  assert.doesNotThrow(() => {
    publish([{ url: 'not a url' }], 'work-status', {}, () => {})
    publish([{ url: 'ftp://example.com/x' }], 'work-status', {}, () => {})
    publish([null, {}], 'work-status', {}, () => {})
    publish(undefined, 'work-status', {}, () => {})
  })
})
