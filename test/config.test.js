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

test('normalizeConfig：v0.3.5 selfPublishRandomLines 默认开、可显式关闭', () => {
  const d = normalizeConfig({})
  assert.equal(d.selfPublishRandomLines, true)
  const off = normalizeConfig({ selfPublishRandomLines: false })
  assert.equal(off.selfPublishRandomLines, false)
  // 显式 true / 非布尔缺省都归 true
  assert.equal(normalizeConfig({ selfPublishRandomLines: true }).selfPublishRandomLines, true)
  assert.equal(normalizeConfig({ selfPublishRandomLines: 'no' }).selfPublishRandomLines, true)
})

test('schema：Config 导出可校验且不吞未知键（mode/targets 等保留）', () => {
  const { Config } = require('../lib/schema')
  assert.notEqual(Config, null)
  const result = Config['~standard'].validate({ mode: 'listen', targets: [{ url: 'http://a/hook' }] })
  assert.equal('then' in result, false) // 同步校验
  assert.equal(result.issues, undefined)
  // 未声明键合并保留（schemastery object 非 strict 解析）
  assert.equal(result.value.mode, 'listen')
  assert.deepEqual(result.value.targets, [{ url: 'http://a/hook' }])
  // 缺省出默认值
  const empty = Config['~standard'].validate({})
  assert.equal(empty.value.selfPublishRandomLines, true)
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

test('buildPayload：五字段契约不变 + v0.3.3 可选 text（protocol 3）', () => {
  const p = buildPayload('pre', 'bash', { command: 'ls' })
  assert.deepEqual(Object.keys(p).sort(), ['agent_source', 'caller_pid', 'kind', 'text', 'tool_input', 'tool_name'])
  assert.equal(p.agent_source, 'dsh')
  assert.equal(p.kind, 'pre')
  assert.equal(p.tool_name, 'bash')
  assert.deepEqual(p.tool_input, { command: 'ls' })
  assert.equal(p.caller_pid, process.pid)
  assert.equal(p.text, null) // 缺省归一为 null：旧 App 忽略未知字段，向后兼容
  assert.equal(buildPayload('user').tool_name, null)
  assert.equal(buildPayload('user').tool_input, null)
  assert.equal(buildPayload('user', null, null, '整理依赖').text, '整理依赖')
  assert.equal(buildPayload('user', null, null, '').text, null) // 空串归一 null
})
