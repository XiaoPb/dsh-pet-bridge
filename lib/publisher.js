'use strict'

const http = require('node:http')
const https = require('node:https')

/**
 * publisher：webhook 推送 —— 把 dsh-pet 的信息**主动推**给外部消费端。
 *
 * 两类载荷（payload.kind 区分）：
 *   - "work-status"：dsh-pet 官方聚合的工作状态快照 {state, task, ts}
 *     （直连模式下来自 dsh-pet /state，replay 模式下来自本地归约，形状一致）；
 *   - "event"：DSH 原始会话事件（session/event 源，dsh-pet 对外未暴露，桥补齐）。
 *
 * 鉴权：每个请求携带目标配置的头部（默认 `X-DSH-Bridge-Token`），
 * token 取 target.token ?? 全局 token（见 config）。fire-and-forget：
 * 发送即返回、失败不重试不上抛，绝不打断 DSH 事件处理。
 * ⚠️ 必须显式 Content-Length：App 侧按定长读 body，缺头 400（与 bubble.js 同因）。
 */

const DEFAULT_HEADER = 'X-DSH-Bridge-Token'

/** 构造推送信封（版本化，消费端可按 version 演进解析） */
function buildEnvelope(kind, body, extra) {
  return {
    version: 1,
    source: 'dsh-pet-bridge',
    kind,
    ...body,
    sentAt: Date.now(),
    ...extra,
  }
}

function postJson(target, envelope, debug) {
  const safeDebug = (...args) => {
    try {
      if (typeof debug === 'function') debug(...args)
    } catch (_) {
      /* 静默降级 */
    }
  }
  let url
  try {
    url = new URL(target.url)
  } catch (e) {
    safeDebug(`dsh-pet-bridge: target url invalid: ${target.url}`)
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    safeDebug(`dsh-pet-bridge: target protocol unsupported: ${url.protocol}`)
    return
  }

  const payload = JSON.stringify(envelope)
  const headers = { 'Content-Type': 'application/json' }
  const token = target.token
  if (token) headers[target.header || DEFAULT_HEADER] = token
  headers['Content-Length'] = Buffer.byteLength(payload)

  const mod = url.protocol === 'https:' ? https : http
  let req
  try {
    req = mod.request(
      url,
      { method: 'POST', headers, timeout: target.timeoutMs || 5000 },
      (res) => {
        if (!(res.statusCode >= 200 && res.statusCode < 300)) {
          safeDebug(`dsh-pet-bridge: webhook ${envelope.kind} -> ${url.origin} non-2xx ${res.statusCode}`)
        }
        res.destroy()
      },
    )
    req.on('timeout', () => {
      try {
        req.destroy()
      } catch (_) {
        /* 静默 */
      }
    })
    req.on('error', (err) => {
      safeDebug(`dsh-pet-bridge: webhook ${envelope.kind} failed: ${err.code || err.message}`)
    })
    req.write(payload)
    req.end()
  } catch (err) {
    safeDebug(`dsh-pet-bridge: webhook ${envelope.kind} threw: ${err.message}`)
  }
}

/** 推给全部目标；eventsOnly=true 时只推订阅了原始事件的目标 */
function publish(targets, kind, body, debug) {
  for (const target of targets || []) {
    if (!target || !target.url) continue
    if (kind === 'event' && !target.events) continue
    postJson(target, buildEnvelope(kind, body), debug)
  }
}

module.exports = { publish, buildEnvelope, DEFAULT_HEADER }
