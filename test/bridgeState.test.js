'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createBridgeState } = require('../lib/bridgeState')

test('counter 严格递增且 write 后 read 可见', () => {
  const s = createBridgeState()
  assert.equal(s.read().counter, 0)
  s.writeWorkStatus({ state: 'working', task: null, ts: 1 })
  const a = s.read()
  assert.equal(a.workStatus.data.state, 'working')
  s.pushEvent({ sessionId: 'x', type: 'turn/start' })
  const b = s.read()
  assert.ok(b.counter > a.counter)
  assert.ok(b.events.counter > a.workStatus.counter)
})

test('环形缓冲：超上限淘汰最旧，recentEvents 取尾部', () => {
  const s = createBridgeState()
  for (let i = 0; i < s.MAX_EVENTS + 50; i++) {
    s.pushEvent({ sessionId: 'x', type: 'e', i })
  }
  assert.equal(s.eventCount(), s.MAX_EVENTS)
  const recent = s.recentEvents(10)
  assert.equal(recent.length, 10)
  assert.equal(recent[9].i, s.MAX_EVENTS + 49) // 最新在尾
  assert.equal(s.recentEvents(5)[4].i, s.MAX_EVENTS + 49)
  // 上限保护：limit 超过 MAX_EVENTS 也只给 MAX_EVENTS
  assert.equal(s.recentEvents(99999).length, s.MAX_EVENTS)
})

test('wait：变化唤醒 / 超时唤醒 / since 已是最新则等到变化', async () => {
  const s = createBridgeState()
  // 已是最新：写一下就立刻返回
  let woke = 0
  const cancel = s.wait(s.read().counter, 5000, () => woke++)
  assert.ok(typeof cancel === 'function')
  s.writeWorkStatus({ state: 'thinking', task: null, ts: 2 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(woke, 1)
  cancel()

  // 超时唤醒
  let woke2 = 0
  s.wait(s.read().counter, 30, () => woke2++)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(woke2, 1)

  // 非法参数 → null
  assert.equal(s.wait(-1, 10, () => {}), null)
  assert.equal(s.wait(0, s.MAX_WAIT_MS + 1, () => {}), null)
})

test('cancelAll 结束所有等待者且 waiterCount 归零', async () => {
  const s = createBridgeState()
  let woke = 0
  s.wait(s.read().counter, 5000, () => woke++)
  s.wait(s.read().counter, 5000, () => woke++)
  assert.equal(s.waiterCount(), 2)
  s.cancelAll()
  assert.equal(woke, 2)
  assert.equal(s.waiterCount(), 0)
})
