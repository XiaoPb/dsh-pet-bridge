#!/usr/bin/env node
'use strict'

/**
 * verify-apk.mjs —— 用假数据验证 DSH Mobile APK 的 PetBridgeServer（127.0.0.1:7779）。
 *
 * 用法（宿主机，经 adb forward 转发到设备回环）：
 *   adb forward tcp:17779 tcp:7779
 *   node tools/verify-apk.mjs [--token <DSH_PET_BRIDGE_TOKEN>] [--port 17779]
 *
 * 校验项：
 *   1. GET  /ping                 → 200（免鉴权，暴露服务存在性）
 *   2. POST /bubble（无 token）    → 403（fail-closed）
 *   3. POST /bubble（错误 token）  → 403
 *   4. POST /bubble（正确 token）  → 204（假数据：read_file pre / bash pre / stop）
 *
 * 退出码：全部符合预期 → 0；任一不符 → 1。假数据仅五字段协议，不影响宠物状态机。
 */

import http from 'node:http'

const args = process.argv.slice(2)
function argOf(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', 17779))
const TOKEN = argOf('--token', process.env.DSH_PET_BRIDGE_TOKEN || '')

function request(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    if (body) headers['Content-Length'] = Buffer.byteLength(body)
    const req = http.request(
      `http://127.0.0.1:${PORT}${path}`,
      { method, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function bubblePayload(kind, toolName, toolInput) {
  return JSON.stringify({ kind, agent_source: 'dsh', tool_name: toolName ?? null, tool_input: toolInput ?? null, caller_pid: process.pid })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function main() {
  // 1. ping 免鉴权
  const ping = await request('GET', '/ping', {})
  check('GET /ping -> 200', ping.status === 200, `got ${ping.status}`)

  // 2. 无 token → 403
  const noTok = await request('POST', '/bubble', { 'Content-Type': 'application/json' }, bubblePayload('pre', 'read_file', { file_path: '/tmp/fake.txt' }))
  check('POST /bubble without token -> 403', noTok.status === 403, `got ${noTok.status}`)

  // 3. 错误 token → 403
  const badTok = await request(
    'POST',
    '/bubble',
    { 'Content-Type': 'application/json', 'X-DSH-Pet-Token': 'deadbeef' },
    bubblePayload('stop'),
  )
  check('POST /bubble with wrong token -> 403', badTok.status === 403, `got ${badTok.status}`)

  // 4. 正确 token → 204（假数据：三条，覆盖 pre/stop 与摘要键）
  if (TOKEN) {
    const samples = [
      ['pre', 'read_file', { file_path: '/home/u/README.md' }],
      ['pre', 'bash', { command: 'git status --porcelain' }],
      ['stop', null, null],
    ]
    let allOk = true
    for (const [kind, name, input] of samples) {
      const r = await request(
        'POST',
        '/bubble',
        { 'Content-Type': 'application/json', 'X-DSH-Pet-Token': TOKEN },
        bubblePayload(kind, name, input),
      )
      const ok = r.status === 204
      allOk = allOk && ok
      check(`POST /bubble ${kind}${name ? ` ${name}` : ''} with token -> 204`, ok, `got ${r.status}`)
    }
    if (!allOk) process.exitCode = 1
  } else {
    console.log('SKIP  token tests (--token 未提供；仅验证 fail-closed 面)')
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${results.length - failed}/${results.length} checks passed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('verify-apk: 连接失败（先执行 adb forward tcp:17779 tcp:7779 并确保桌宠已开启）:', e.message)
  process.exitCode = 1
})
