'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeConfig, normalizeTargets, DEFAULT_PET_BASE_URL } = require('../lib/config')
const { buildPayload } = require('../lib/bubble')

test('normalizeConfig：v0.2.0 既有键默认值不变', () => {
  const c = normalizeConfig({})
  assert.equal(c.enabled, true)
  assert.equal(c.port, 7779)
  assert.equal(c.pollInterval, 250)
  assert.equal(c.auth, 'auto')
})

test('normalizeConfig：v0.3.0 新增键默认值', () => {
  delete process.env.DSH_PET_BRIDGE_TOKEN
  delete process.env.DSH_PET_BRIDGE_MODE
  delete process.env.DSH_PET_BRIDGE_PET_URL
  const c = normalizeConfig({})
  assert.equal(c.mode, 'auto')
  assert.equal(c.petBaseUrl, DEFAULT_PET_BASE_URL)
  assert.equal(c.serverEnabled, true)
  assert.equal(c.serverPort, 7780)
  assert.equal(c.token, undefined)
  assert.deepEqual(c.targets, [])
})

test('normalizeConfig：环境变量覆盖', () => {
  process.env.DSH_PET_BRIDGE_MODE = 'replay'
  process.env.DSH_PET_BRIDGE_PET_URL = 'http://127.0.0.1:9999/'
  process.env.DSH_PET_BRIDGE_AUTH = 'off'
  process.env.DSH_PET_BRIDGE_TOKEN = 'env-token'
  try {
    const c = normalizeConfig({ mode: 'listen', petBaseUrl: 'http://x' })
    assert.equal(c.mode, 'replay') // 环境变量优先
    assert.equal(c.petBaseUrl, 'http://127.0.0.1:9999')
    assert.equal(c.auth, 'off')
    assert.equal(c.token, 'env-token')
  } finally {
    delete process.env.DSH_PET_BRIDGE_MODE
    delete process.env.DSH_PET_BRIDGE_PET_URL
    delete process.env.DSH_PET_BRIDGE_AUTH
    delete process.env.DSH_PET_BRIDGE_TOKEN
  }
})

test('normalizeConfig：config.token 优先于环境变量；非法 mode 归 auto', () => {
  process.env.DSH_PET_BRIDGE_TOKEN = 'env-token'
  try {
    const c = normalizeConfig({ token: 'cfg-token', mode: 'bogus' })
    assert.equal(c.token, 'cfg-token')
    assert.equal(c.mode, 'auto')
  } finally {
    delete process.env.DSH_PET_BRIDGE_TOKEN
  }
})

test('normalizeTargets：过滤非法项并归一字段', () => {
  const t = normalizeTargets([
    { url: 'http://a/hook', token: 'x', events: true, timeoutMs: 1234 },
    { url: '' },
    null,
    'string',
    { header: 'X-Custom' }, // 无 url → 过滤
  ])
  assert.equal(t.length, 1)
  assert.equal(t[0].events, true)
  assert.equal(t[0].timeoutMs, 1234)
  assert.equal(t[0].header, undefined)
})

test('buildPayload：五字段契约不变（v0.2.0 /bubble 协议）', () => {
  const p = buildPayload('pre', 'bash', { command: 'ls' })
  assert.deepEqual(Object.keys(p).sort(), ['agent_source', 'caller_pid', 'kind', 'tool_input', 'tool_name'])
  assert.equal(p.agent_source, 'dsh')
  assert.equal(p.kind, 'pre')
  assert.equal(p.tool_name, 'bash')
  assert.deepEqual(p.tool_input, { command: 'ls' })
  assert.equal(p.caller_pid, process.pid)
  assert.equal(buildPayload('user').tool_name, null)
  assert.equal(buildPayload('user').tool_input, null)
})
