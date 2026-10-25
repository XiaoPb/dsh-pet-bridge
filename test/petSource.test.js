'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPetSource, ROUTE_PREFIX, DEFAULT_ORIGIN } = require('../lib/petSource')
const http = require('node:http')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 模拟 dsh-pet 的 /dsh-pet-7340/state 长轮询路由 */
function startFakePet() {
  let counter = 100
  const waiters = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== `${ROUTE_PREFIX}/state`) {
      res.statusCode = 404
      return res.end()
    }
    const since = Number(url.searchParams.get('since') || 0)
    const respond = () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          counter,
          sections: {
            workStatus: { counter, data: { state: 'working', task: '干活' } },
            notify: { counter, data: { frames: [] } },
          },
          pets: {},
        }),
      )
    }
    if (since === counter) {
      const w = { respond, timer: setTimeout(() => { waiters.delete(w); respond() }, 800) }
      waiters.add(w)
      res.on('close', () => {
        clearTimeout(w.timer)
        waiters.delete(w)
      })
    } else {
      respond()
    }
  })
  return {
    server,
    bump: () => {
      counter += 1
      for (const w of [...waiters]) {
        clearTimeout(w.timer)
        waiters.delete(w)
        w.respond()
      }
    },
    close: () => {
      server.close()
    },
  }
}

test('createPetSource：直连拉取 workStatus 并在变化时回调', async () => {
  const fake = startFakePet()
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${fake.server.address().port}`
  const received = []
  const workSnaps = []
  let healthyEvents = 0
  const src = createPetSource({
    origin,
    onWorkStatus: (snap) => {
      received.push(snap)
      workSnaps.push(snap)
    },
    onSection: (name, data) => {
      if (name === 'notify') received.push({ section: name, data })
    },
    onRecover: () => healthyEvents++,
    pollTimeoutMs: 300,
    failureThreshold: 2,
  })
  src.start()
  await sleep(150)
  assert.equal(workSnaps.length, 1) // 首拉基线（notify 透传另计）
  assert.deepEqual(workSnaps[0], { state: 'working', task: '干活', ts: workSnaps[0].ts })
  assert.ok(src.healthy)
  assert.equal(healthyEvents, 1)

  fake.bump() // counter 变化 → 长轮询返回 → 新快照
  await sleep(200)
  assert.ok(workSnaps.length >= 2)
  assert.equal(workSnaps[workSnaps.length - 1].state, 'working')
  const notify = received.find((r) => r.section === 'notify')
  assert.ok(notify, 'notify section 透传')

  src.stop()
  fake.close()
})

test('createPetSource：不可达时计入失败并上报 unhealthy', async () => {
  const src = createPetSource({
    origin: 'http://127.0.0.1:1', // 不可达端口
    pollTimeoutMs: 200,
    failureThreshold: 2,
  })
  const errors = []
  // 直接构造：onError 在 options 里
  const src2 = createPetSource({
    origin: 'http://127.0.0.1:1',
    pollTimeoutMs: 200,
    failureThreshold: 2,
    onError: (r) => errors.push(r),
  })
  src2.start()
  await sleep(900)
  assert.ok(!src2.healthy)
  assert.deepEqual(errors, ['unhealthy'])
  src2.stop()
  src.stop()
  assert.equal(DEFAULT_ORIGIN, 'http://127.0.0.1:3080')
})
