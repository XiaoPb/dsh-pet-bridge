'use strict'

/**
 * dsh-pet-bridge v0.3.0 插件入口：cordis 插件（inject + apply）。
 *
 * 定位：把 dsh-pet（桌面宠物插件）的**事件与信息**对外发布。两条数据通道：
 *
 * 1. 工作状态（dsh-pet 官方聚合结果 {state, task}）：
 *    - listen（主）：直连长轮询 dsh-pet 的 /dsh-pet-7340/state?since=&timeout=
 *      （与桌面 Helper 同源同协议），数据就是 dsh-pet 自己算的，零重复实现；
 *    - replay（备）：dsh-pet 不可达时，从 session/event 用移植自 dsh-pet 0.3.8
 *      的 reduceWorkStatus 本地归约（lib/workStatus），恢复后自动切回 listen。
 *    mode 配置：auto（默认）/ listen / replay。
 *
 * 2. 原始会话事件（turn/start、tool/call…，dsh-pet 对外未暴露，桥补齐）：
 *    ctx.on("session/event")（宿主不支持时由 agentWatcher 轮询游标兜底）。
 *
 * 发布出口：
 *    - webhook 推送（targets，Token 鉴权，fire-and-forget）；
 *    - 回环拉取服务 GET /work-status /events /state?since=&timeout=（Token 鉴权）；
 *    - v0.2.0 既有手机桌宠 /bubble 推送（X-DSH-Pet-Token）原样保留。
 *
 * 契约：inject 恒为 []；apply(ctx, config) 装载，返回卸载函数；
 * 全部降级路径绝不出 apply。
 */

const { normalizeConfig } = require('./config')
const { createCollector } = require('./collector')
const { push } = require('./bubble')
const { createWorkStatusFeed } = require('./workStatus')
const { createBridgeState } = require('./bridgeState')
const { createPetSource } = require('./petSource')
const { createServer } = require('./server')
const { publish } = require('./publisher')
const { tapSessionEvents } = require('./sessionEvents')

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
  const info = (...args) => {
    try {
      const lg = ctx && ctx.logger
      if (lg && typeof lg.info === 'function') return lg.info(...args)
    } catch (_) {
      /* 静默降级 */
    }
  }

  if (cfg.enabled === false) {
    debug('dsh-pet-bridge: disabled (enabled=false)，装载但零推送')
    return function dispose() {}
  }

  // ---- 发布状态与出口 ----
  const state = createBridgeState()
  const publishWorkStatus = (snap) => {
    state.writeWorkStatus(snap)
    publish(cfg.targets, 'work-status', { workStatus: snap }, debug)
  }
  const publishEvent = (sessionId, event) => {
    state.pushEvent({ sessionId, seq: Number(event.seq ?? 0), ts: Date.now(), type: event.type, data: event.data })
    publish(cfg.targets, 'event', { sessionId, event: { type: event.type, data: event.data, seq: event.seq } }, debug)
  }

  // ---- 回环拉取服务（Token 鉴权）----
  let server = null
  if (cfg.serverEnabled) {
    server = createServer({ port: cfg.serverPort, token: cfg.token, state })
    if (server.serverPort() === null) {
      // 端口可能尚未 listening（异步）或已被占用：留给 error 回调处置，这里先探测一次
      debug(`dsh-pet-bridge: loopback server on 127.0.0.1:${cfg.serverPort} starting`)
    }
    info(`dsh-pet-bridge: 发布服务 http://127.0.0.1:${server.serverPort() ?? cfg.serverPort}（Token 鉴权${cfg.token ? '，使用配置 token' : '，已生成进程内随机 token'}）`)
  } else if (!cfg.token) {
    debug('dsh-pet-bridge: serverEnabled=false 且未配置 token：无对外 token')
  }

  // ---- 工作状态：replay 引擎（本地归约，回退/兜底）----
  const feed = createWorkStatusFeed(debug)
  let replayActive = cfg.mode !== 'listen' // auto 模式起步先用 replay（dsh-pet 未确认可达前不空等）
  feed.setOnChange((snap) => {
    if (replayActive) publishWorkStatus(snap)
  })

  // ---- 工作状态：listen 通道（直连 dsh-pet）----
  let petSource = null
  if (cfg.mode !== 'replay') {
    petSource = createPetSource({
      origin: cfg.petBaseUrl,
      debug,
      onWorkStatus: (snap) => {
        if (cfg.mode === 'listen' || !replayActive) publishWorkStatus(snap)
      },
      onError: (reason) => {
        if (cfg.mode === 'auto' && !replayActive) {
          replayActive = true
          info(`dsh-pet-bridge: dsh-pet 不可达（${reason}）→ 切回本地归约（replay）`)
        }
      },
      onRecover: () => {
        if (cfg.mode === 'auto' && replayActive) {
          replayActive = false
          info('dsh-pet-bridge: dsh-pet 已恢复 → 切回直连（listen）')
        }
      },
    })
    petSource.start()
    debug(`dsh-pet-bridge: listen ${petSource.origin}/dsh-pet-7340/state（mode=${cfg.mode}）`)
  }

  // ---- 原始会话事件：session/event 直采，宿主不支持则由轮询兜底 ----
  const rawHandlers = []
  const emitRaw = (sessionId, event) => {
    if (!sessionId || !event || typeof event.type !== 'string') return
    publishEvent(sessionId, event)
    if (replayActive) feed.feed(sessionId, event)
  }
  const tap = tapSessionEvents(ctx, emitRaw, debug)
  if (!tap.live && cfg.mode !== 'listen') {
    // 轮询兜底：agentWatcher 的游标顺路回传原始事件（注意模式为 listen 时不归约）
    rawHandlers.push((agent, ev) => {
      const sess = agent && agent.session
      const sessionId = String((sess && sess.header && sess.header.id) || (sess && sess.id) || 'unknown')
      emitRaw(sessionId, ev)
    })
    debug('dsh-pet-bridge: 宿主无 session/event，改用 agent 轮询兜底原始事件')
  } else if (!tap.live) {
    debug('dsh-pet-bridge: 宿主无 session/event，listen 模式下无原始事件通道')
  }

  // ---- v0.2.0 既有：手机桌宠 /bubble 推送（agent 轮询游标，行为不变）----
  const send = (kind, toolName, toolInput) => push(cfg.port, kind, toolName, toolInput, debug, cfg.auth)
  const onRaw = rawHandlers.length > 0 ? rawHandlers[0] : undefined
  const collector = createCollector(cfg, send, debug, onRaw)

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
    feed.dispose()
    if (petSource) petSource.stop()
    state.cancelAll()
    if (server) server.close()
    try {
      tap.dispose()
    } catch (_) {
      /* 静默 */
    }
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
