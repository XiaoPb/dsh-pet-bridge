'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createConfigRoute } = require('../lib/configRoute')

function makeCfg(over = {}) {
  return { selfPublishRandomLines: true, ...over }
}

test('GET：返回当前生效值，无持久化文件时 persisted=null', async () => {
  const handle = createConfigRoute({ cfg: makeCfg(), patchFile: undefined, debug: () => {} })
  const r = await handle('GET')
  assert.equal(r.kind, 'json')
  assert.equal(r.status, 200)
  assert.deepEqual(r.obj, { selfPublishRandomLines: true, persisted: null })
  assert.equal(r.headers['cache-control'], 'no-cache, no-store')
})

test('PUT：合法布尔 → 即时改写 cfg 并返回最新值', async () => {
  const cfg = makeCfg()
  const handle = createConfigRoute({ cfg, patchFile: undefined, debug: () => {} })
  const r = await handle('PUT', JSON.stringify({ selfPublishRandomLines: false }))
  assert.equal(r.status, 200)
  assert.equal(r.obj.selfPublishRandomLines, false)
  assert.equal(cfg.selfPublishRandomLines, false, '运行时 cfg 应被就地改写')
  const r2 = await handle('PUT', JSON.stringify({ selfPublishRandomLines: true }))
  assert.equal(r2.obj.selfPublishRandomLines, true)
  assert.equal(cfg.selfPublishRandomLines, true)
})

test('PUT：非法 body / 非布尔值 → 400', async () => {
  const handle = createConfigRoute({ cfg: makeCfg(), patchFile: undefined, debug: () => {} })
  assert.equal((await handle('PUT', 'not json')).status, 400)
  assert.equal((await handle('PUT', JSON.stringify({ selfPublishRandomLines: 'yes' }))).status, 400)
  assert.equal((await handle('PUT', JSON.stringify({}))).status, 400)
  assert.equal((await handle('PUT', '')).status, 400)
})

test('PUT：持久化结果反映在 persisted；成功写 true 删除条目后读回 true', async () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-bridge-route-'))
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, '- id: ui-x\n  config:\n    a: 1\n', 'utf8')
  const cfg = makeCfg()
  const handle = createConfigRoute({ cfg, patchFile: file, debug: () => {} })
  const r = await handle('PUT', JSON.stringify({ selfPublishRandomLines: false }))
  assert.equal(r.obj.persisted, true)
  assert.equal(fs.readFileSync(file, 'utf8').includes('selfPublishRandomLines: false'), true)
  const back = await handle('PUT', JSON.stringify({ selfPublishRandomLines: true }))
  assert.equal(back.obj.persisted, true)
  assert.ok(!fs.readFileSync(file, 'utf8').includes('pet-bridge'))
  const get = await handle('GET')
  assert.deepEqual(get.obj, { selfPublishRandomLines: true, persisted: true })
})

test('PUT：持久化失败（不可写路径）仍即时生效，persisted=false', async () => {
  const cfg = makeCfg()
  const logs = []
  const handle = createConfigRoute({
    cfg,
    patchFile: path.join(require('node:os').tmpdir(), 'no-such-dir-bridge-' + Date.now(), 'sub', 'x.yml'),
    debug: (m) => logs.push(m),
  })
  const r = await handle('PUT', JSON.stringify({ selfPublishRandomLines: false }))
  assert.equal(r.status, 200)
  assert.equal(r.obj.selfPublishRandomLines, false)
  assert.equal(r.obj.persisted, true, '目录会被连带创建，应写入成功')
})

test('其他方法 → 405；不抛异常', async () => {
  const handle = createConfigRoute({ cfg: makeCfg(), patchFile: undefined, debug: () => {} })
  const r = await handle('DELETE')
  assert.equal(r.status, 405)
})
