'use strict'

/**
 * dsh-pet-bridge v0.2.0（token 版）插件入口：cordis 插件（inject + apply）。
 *
 * 基于 npm dsh-pet-bridge@0.1.0（wsxwj123/dsh-plugins，MIT）精简适配：
 * 唯一协议变更是 POST /bubble 必须带 `X-DSH-Pet-Token` 头，值取
 * `process.env.DSH_PET_BRIDGE_TOKEN`（由 DSH Mobile App 在引擎环境变量里
 * 注入，每次进程启动随机生成、不落盘）。不带 token 的 0.1.0 会被 App 侧
 * 403 拒绝（v1.4.21 起 /bubble 强制鉴权，fail-closed）。
 *
 * 契约：
 *   - inject 恒为 []；apply(ctx, config) 装载，返回卸载函数；
 *   - 订阅 ctx.on("agent/created" / "agent/disposed")，对已存在 agent 逐个建观察；
 *   - 每 agent 位置游标轮询 session.events，映射：
 *       turn/start -> user, tool/call -> pre, tool/result -> post, turn/end -> stop；
 *   - 全部降级路径绝不出 apply。
 */

const { normalizeConfig } = require('./config')
const { createCollector } = require('./collector')
const { push } = require('./bubble')

function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  // cordis 的 ctx.logger 是「可调用服务」，.debug 依赖 fiber 上下文（this 绑定）；
  // 每次调用现取 ctx.logger，任何异常吞掉（日志丢失不影响主流程）。
  const debug = (...args) => {
    try {
      const lg = ctx && ctx.logger
      if (lg && typeof lg.debug === 'function') return lg.debug(...args)
    } catch (_) {
      /* 静默降级 */
    }
  }

  const send = (kind, toolName, toolInput) => {
    if (cfg.enabled === false) return // enabled=false：零推送
    push(cfg.port, kind, toolName, toolInput, debug, cfg.auth)
  }

  const collector = createCollector(cfg, send, debug)

  const onCreated = (payload) => {
    if (payload && payload.agent) collector.watch(payload.agent)
  }
  const onDisposed = (payload) => {
    if (payload && payload.agent) collector.unwatch(payload.agent)
  }

  // 对已存在 agent 逐个建观察（ctx.get 可选读：agents 未注入时返回 undefined，不抛）
  const existing = (ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null) || null
  if (existing && typeof existing === 'object') {
    const values = existing.store && existing.store.values ? existing.store.values() : null
    if (values) {
      for (const a of values) if (a && a.agent) collector.watch(a.agent)
    } else if (Array.isArray(existing)) {
      for (const a of existing) if (a && a.agent) collector.watch(a.agent)
    }
  }

  const offs = []
  if (ctx && typeof ctx.on === 'function') {
    offs.push(ctx.on('agent/created', onCreated))
    offs.push(ctx.on('agent/disposed', onDisposed))
  }

  return function dispose() {
    collector.dispose()
    for (const off of offs) {
      try {
        if (typeof off === 'function') off()
      } catch (e) {
        /* no-op */
      }
    }
    offs.length = 0
  }
}

module.exports = { inject: [], apply }
