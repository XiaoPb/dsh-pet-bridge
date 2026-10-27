'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readSelfPublish, writeSelfPublish, resolvePatchFile } = require('../lib/patchConfig')

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-bridge-patch-'))
  const file = path.join(dir, 'cordis.patch.yml')
  if (content !== undefined) fs.writeFileSync(file, content, 'utf8')
  return file
}

const BASE = [
  '# comment',
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-09-28.1',
].join('\n')

test('resolvePatchFile：无 DSH_HOME 返回 null，有则拼 profiles/web', () => {
  assert.equal(resolvePatchFile({}), null)
  assert.equal(resolvePatchFile({ DSH_HOME: '/data/x' }), path.join('/data/x', 'profiles', 'web', 'cordis.patch.yml'))
})

test('readSelfPublish：文件缺失/无条目/无键 = 默认 true', () => {
  assert.equal(readSelfPublish(undefined), null)
  assert.equal(readSelfPublish(path.join(os.tmpdir(), 'no-such-file-' + Date.now())), null)
  assert.equal(readSelfPublish(tmpFile(BASE)), true)
  assert.equal(readSelfPublish(tmpFile(BASE + '\n- id: pet-bridge\n  name: \'@xiaopb/dsh-pet-bridge\'\n')), true)
})

test('readSelfPublish：显式 false 读出 false', () => {
  const file = tmpFile(BASE + '\n- id: pet-bridge\n  config:\n    selfPublishRandomLines: false\n')
  assert.equal(readSelfPublish(file), false)
})

test('writeSelfPublish：关（无条目→追加，含其他条目保全与尾换行）', () => {
  const file = tmpFile(BASE + '\n')
  const r = writeSelfPublish(file, false)
  assert.equal(r.ok, true)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /- id: pet-bridge\n {2}name: '@xiaopb\/dsh-pet-bridge'\n {2}config:\n {4}selfPublishRandomLines: false\n/)
  assert.ok(text.includes('welcomeNoticeVersion'), '其他条目应原样保留')
  assert.ok(text.startsWith('# comment'), '头部注释保留')
  assert.ok(text.endsWith('\n'))
  assert.equal(readSelfPublish(file), false)
})

test('writeSelfPublish：关（已有条目→改值，不重复追加）', () => {
  const file = tmpFile(BASE + '\n- id: pet-bridge\n  config:\n    selfPublishRandomLines: true\n')
  const r = writeSelfPublish(file, false)
  assert.equal(r.ok, true)
  const text = fs.readFileSync(file, 'utf8')
  assert.equal((text.match(/- id: pet-bridge/g) || []).length, 1)
  assert.match(text, /selfPublishRandomLines: false/)
  assert.ok(!/selfPublishRandomLines: true/.test(text))
})

test('writeSelfPublish：关（已有条目无 config 块→补 config 键）', () => {
  const file = tmpFile(BASE + "\n- id: pet-bridge\n  name: '@xiaopb/dsh-pet-bridge'\n")
  const r = writeSelfPublish(file, false)
  assert.equal(r.ok, true)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /- id: pet-bridge\n {2}name: '@xiaopb\/dsh-pet-bridge'\n {2}config:\n {4}selfPublishRandomLines: false/)
  assert.equal(readSelfPublish(file), false)
})

test('writeSelfPublish：开（有覆盖条目→整块删除回到缺省；开（无条目）→不动文件）', () => {
  const withEntry = tmpFile(BASE + '\n- id: pet-bridge\n  config:\n    selfPublishRandomLines: false\n')
  assert.equal(writeSelfPublish(withEntry, true).ok, true)
  const t1 = fs.readFileSync(withEntry, 'utf8')
  assert.ok(!t1.includes('pet-bridge'), '覆盖条目应被移除')
  assert.ok(t1.includes('welcomeNoticeVersion'), '其他条目保留')
  assert.equal(readSelfPublish(withEntry), true)

  const noEntryBefore = fs.readFileSync(tmpFile(BASE + '\n'), 'utf8')
  const noEntry = tmpFile(BASE + '\n')
  assert.equal(writeSelfPublish(noEntry, true).ok, true)
  assert.equal(fs.readFileSync(noEntry, 'utf8'), noEntryBefore, '本来就是默认开，文件不应被改动')
})

test('writeSelfPublish：关（文件不存在→创建；目录也不存在→连带创建）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-bridge-patch-'))
  fs.rmSync(dir, { recursive: true })
  const file = path.join(dir, 'profiles', 'web', 'cordis.patch.yml')
  const r = writeSelfPublish(file, false)
  assert.equal(r.ok, true)
  assert.equal(readSelfPublish(file), false)
  assert.equal(writeSelfPublish(file, true).ok, true)
  assert.equal(readSelfPublish(file), true, '开→条目移除，读回默认 true')
})

test('writeSelfPublish：开/关反复切换幂等', () => {
  const file = tmpFile(BASE + '\n')
  for (let i = 0; i < 3; i++) {
    assert.equal(writeSelfPublish(file, false).ok, true)
    assert.equal(readSelfPublish(file), false)
    assert.equal(writeSelfPublish(file, true).ok, true)
    assert.equal(readSelfPublish(file), true)
  }
  assert.ok(!fs.readFileSync(file, 'utf8').includes('pet-bridge'))
})
