'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  reduceWorkStatus,
  turnEndState,
  goalUpdateAction,
  completedState,
  currentTaskFromTodo,
  WorkStatusStore,
  createWorkStatusFeed,
  WORK_STATUS_PRIORITY,
} = require('../lib/workStatus')

test('turnEndState 映射', () => {
  assert.equal(turnEndState('completed'), 'success')
  assert.equal(turnEndState('error'), 'error')
  assert.equal(turnEndState('max-tokens'), 'error')
  assert.equal(turnEndState('timeout'), 'error')
  assert.equal(turnEndState('blocked'), 'waiting')
  assert.equal(turnEndState('aborted'), null)
  assert.equal(turnEndState(''), null)
})

test('reduceWorkStatus 档位映射', () => {
  assert.equal(reduceWorkStatus({ type: 'turn/start' }), 'thinking')
  assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'bash' } }), 'working')
  // ask_user_question → waiting
  assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'ask_user_question' } }), 'waiting')
  assert.equal(reduceWorkStatus({ type: 'tool/result' }), 'result')
  assert.equal(reduceWorkStatus({ type: 'approval/asked' }), 'waiting')
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 'success')
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), null)
  assert.equal(reduceWorkStatus({ type: 'todo/write', data: { todos: [] } }), null)
})

test('completedState：goal 续跑轮判定', () => {
  assert.equal(completedState(undefined), 'success')
  assert.equal(completedState({ goalRound: false }), 'success')
  assert.equal(completedState({ goalRound: true, closing: null }), 'result')
  assert.equal(completedState({ goalRound: true, closing: 'complete' }), 'success')
  assert.equal(completedState({ goalRound: true, closing: 'blocked' }), 'error')
})

test('goalUpdateAction 解析', () => {
  assert.equal(goalUpdateAction('{"action":"complete"}'), 'complete')
  assert.equal(goalUpdateAction('{"action":"blocked"}'), 'blocked')
  assert.equal(goalUpdateAction('{"action":"other"}'), null)
  assert.equal(goalUpdateAction('not json'), null)
  assert.equal(goalUpdateAction(''), null)
})

test('currentTaskFromTodo：取最后一个 in_progress，回落 pending，截断 40 码点', () => {
  assert.equal(currentTaskFromTodo({ data: { todos: [] } }), null)
  assert.equal(
    currentTaskFromTodo({ data: { todos: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b' }] } }),
    'b',
  )
  // agent 忘了把上一步标 completed：取最近开始的 in_progress
  assert.equal(
    currentTaskFromTodo({
      data: { todos: [{ status: 'in_progress', content: 'first' }, { status: 'in_progress', content: 'second' }] },
    }),
    'second',
  )
  // 无 in_progress 回落第一个 pending
  assert.equal(currentTaskFromTodo({ data: { todos: [{ status: 'pending', content: 'next' }] } }), 'next')
  // 按码点截断（emoji 是两个码点单元）
  const long = '你'.repeat(45)
  const out = currentTaskFromTodo({ data: { todos: [{ status: 'pending', content: long }] } })
  assert.equal(Array.from(out).length, 41)
  assert.ok(out.endsWith('…'))
})

test('WorkStatusStore：优先级展示 + task 同生共死 + 防刷屏', () => {
  const store = new WorkStatusStore()
  assert.equal(store.snapshot().state, null)

  assert.equal(store.setState('s1', 'working', 1), true)
  assert.equal(store.snapshot().state, 'working')
  // 同状态同 seq：防刷屏
  assert.equal(store.setState('s1', 'working', 1), false)
  // task 挂会话条目
  store.setTask('s1', '写代码')
  assert.equal(store.snapshot().task, '写代码')
  // 更高优先级会话压过（waiting > working），state 与 task 取自同一会话
  store.setState('s2', 'waiting', 2)
  assert.equal(store.snapshot().state, 'waiting')
  assert.equal(store.snapshot().task, null)
  // 清掉高优先级会话 → 落回 s1（含其 task）
  store.clear('s2')
  assert.equal(store.snapshot().state, 'working')
  assert.equal(store.snapshot().task, '写代码')
  // 清掉 s1 → task 一并消失
  store.clear('s1')
  assert.equal(store.snapshot().state, null)
  assert.equal(store.snapshot().task, null)
  // has
  assert.equal(store.has('s1'), false)
  store.setState('s3', 'error')
  assert.equal(store.has('s3'), true)
})

test('createWorkStatusFeed：喂事件 → 快照变化回调 + goal 轮 + 终态清理', async () => {
  let last = null
  const feed = createWorkStatusFeed()
  feed.setOnChange((snap) => {
    last = snap
  })

  feed.feed('a', { type: 'turn/start' })
  assert.equal(last.state, 'thinking')
  feed.feed('a', { type: 'tool/call', data: { name: 'read_file' } })
  assert.equal(last.state, 'working')
  feed.feed('a', { type: 'todo/write', data: { todos: [{ status: 'in_progress', content: '干活' }] } })
  assert.equal(last.task, '干活')
  feed.feed('a', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(last.state, 'success')
  assert.equal(feed.snapshot().state, 'success')

  // aborted → 会话清理回空闲
  feed.feed('a', { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  assert.equal(feed.snapshot().state, null)

  // goal 自动续跑轮：turn/start → user/message(goal) → completed 中间轮 → result 不庆祝
  feed.feed('b', { type: 'turn/start' })
  feed.feed('b', { type: 'user/message', data: { source: { kind: 'goal' } } })
  feed.feed('b', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(feed.snapshot().state, 'result')

  // dispose 后不再变化（snapshot() 返回拷贝，用 deepEqual 比对）
  feed.dispose()
  const frozen = feed.snapshot()
  feed.feed('c', { type: 'turn/start' })
  assert.deepEqual(feed.snapshot(), frozen)
})

test('WORK_STATUS_PRIORITY 与 dsh-pet 一致：waiting > error > working > thinking > result > success', () => {
  assert.ok(WORK_STATUS_PRIORITY.waiting > WORK_STATUS_PRIORITY.error)
  assert.ok(WORK_STATUS_PRIORITY.error > WORK_STATUS_PRIORITY.working)
  assert.ok(WORK_STATUS_PRIORITY.working > WORK_STATUS_PRIORITY.thinking)
  assert.ok(WORK_STATUS_PRIORITY.thinking > WORK_STATUS_PRIORITY.result)
  assert.ok(WORK_STATUS_PRIORITY.result > WORK_STATUS_PRIORITY.success)
})
