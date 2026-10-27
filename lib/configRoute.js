'use strict'

/**
 * 设置页配置路由的业务处理器（host 半侧 webServer 路由的唯一业务实现）。
 *
 * 路由：GET  → { selfPublishRandomLines, persisted, persistedReadable }
 *       PUT  → body {selfPublishRandomLines: boolean}
 *            → 即时生效（改写运行时 cfg）+ 持久化到 profile patch 文件
 *
 * 返回 RouteResult（与 dsh-pet 同款形状）：{kind:'json', status, obj}。
 * 任何失败都不抛出：业务错误一律落成 4xx/5xx JSON。
 */

function createConfigRoute({ cfg, patchFile, debug } = {}) {
  if (!cfg || typeof cfg !== 'object') throw new TypeError('cfg object required')

  const readPersisted = () => {
    try {
      return require('./patchConfig').readSelfPublish(patchFile)
    } catch (_) {
      return null
    }
  }

  return async function handle(method, body) {
    if (method === 'GET') {
      return {
        kind: 'json',
        status: 200,
        obj: {
          selfPublishRandomLines: cfg.selfPublishRandomLines !== false,
          persisted: readPersisted(),
        },
        headers: { 'cache-control': 'no-cache, no-store' },
      }
    }
    if (method === 'PUT') {
      let parsed
      try {
        parsed = body && typeof body === 'object' ? body : JSON.parse(body || '')
      } catch (_) {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } }
      }
      const value = parsed ? parsed.selfPublishRandomLines : undefined
      if (typeof value !== 'boolean') {
        return {
          kind: 'json',
          status: 400,
          obj: { error: 'selfPublishRandomLines must be a boolean' },
        }
      }
      // 即时生效：bubbleText 每次推送现读 cfg.selfPublishRandomLines
      cfg.selfPublishRandomLines = value
      let persisted
      try {
        const result = require('./patchConfig').writeSelfPublish(patchFile, value)
        persisted = result && result.ok
        if (!result || !result.ok) {
          debug(
            'dsh-pet-bridge: 配置持久化失败（' +
              ((result && result.reason) || 'unknown') +
              '）——本次运行内已生效，重启后回落'
          )
        }
      } catch (e) {
        persisted = false
        debug('dsh-pet-bridge: 配置持久化异常：' + (e && e.message ? e.message : String(e)))
      }
      return {
        kind: 'json',
        status: 200,
        obj: {
          selfPublishRandomLines: cfg.selfPublishRandomLines !== false,
          persisted,
        },
      }
    }
    return { kind: 'json', status: 405, obj: { error: 'method not allowed' } }
  }
}

module.exports = { createConfigRoute }
