'use strict'

const http = require('node:http')

/**
 * bubble 推送：POST http://127.0.0.1:{port}/bubble，fire-and-forget，全静默降级。
 *
 * v0.2.0 鉴权适配：从 process.env.DSH_PET_BRIDGE_TOKEN 读取桥 token，
 * 以 X-DSH-Pet-Token 头随请求发送。token 缺失时仍发送（由 App 侧 403，
 * debug 留痕）——插件不持有 token 的生成职责，只负责透传环境变量。
 *
 * 其余契约与上游 0.1.0 一致：
 *   - 仅回环 127.0.0.1；agent_source 恒 "dsh"；caller_pid = process.pid；
 *   - tool_input 仅含精简安全摘要对象（≤24 字符）或 null；
 *   - fire-and-forget：发送即返回，收到响应 res.destroy() 关闭连接；
 *   - 所有失败静默降级：不重试、不上抛，绝不打断 dsh 事件处理。
 */

/** 构造推送 payload（contract 固定的五个字段；缺失值归一为 null） */
function buildPayload(kind, toolName, toolInput) {
  return {
    kind,
    agent_source: 'dsh',
    tool_name: toolName === undefined ? null : toolName,
    tool_input: toolInput === undefined ? null : toolInput,
    caller_pid: process.pid,
  }
}

function push(port, kind, toolName, toolInput, debug, auth) {
  const safeDebug = (...args) => {
    try {
      if (typeof debug === 'function') return debug(...args)
    } catch (_) {
      /* 静默降级 */
    }
  }
  const url = `http://127.0.0.1:${port}/bubble`
  const payload = JSON.stringify(buildPayload(kind, toolName, toolInput))

  const headers = { 'Content-Type': 'application/json' }
  const token = process.env.DSH_PET_BRIDGE_TOKEN
  // auth："auto"（默认）带 token；"off" 刻意不带（模拟 0.1.0，验证 APK 403 fail-closed）
  if (auth !== 'off' && token) headers['X-DSH-Pet-Token'] = token

  let req
  try {
    req = http.request(url, { method: 'POST', headers }, (res) => {
      if (!(res.statusCode >= 200 && res.statusCode < 300)) {
        safeDebug(`dsh-pet-bridge: POST /bubble ${kind} -> non-2xx ${res.statusCode}`)
      }
      res.destroy()
    })
    req.on('error', (err) => {
      safeDebug(`dsh-pet-bridge: POST /bubble ${kind} failed: ${err.code || err.message}`)
    })
    req.write(payload)
    req.end()
  } catch (err) {
    safeDebug(`dsh-pet-bridge: POST /bubble ${kind} threw: ${err.message}`)
  }
}

module.exports = { push, buildPayload }
