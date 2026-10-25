'use strict'

/**
 * sessionEvents：DSH 原始会话事件源。
 *
 * 优先走宿主的 ctx.on("session/event")（dsh-pet 同源、实时）；宿主不支持时
 * 返回 live=false，由调用方决定是否用 agent 轮询兜底（agentWatcher 的游标
 * 顺路回传原始事件，见 agentWatcher 的 onRawEvent 参数）。
 */

/** 尝试注册 session/event 监听；返回 {live, dispose} */
function tapSessionEvents(ctx, emit, debug) {
  if (!ctx || typeof ctx.on !== 'function') return { live: false, dispose: () => {} }
  let off = null
  try {
    off = ctx.on('session/event', (session, event) => {
      if (!event || typeof event.type !== 'string') return
      const sessionId = String(
        (session && session.header && session.header.id) || (session && session.id) || 'unknown',
      )
      emit(sessionId, event)
    })
  } catch (e) {
    try {
      if (typeof debug === 'function') debug(`dsh-pet-bridge: session/event tap failed: ${e.message}`)
    } catch (_) {
      /* 静默 */
    }
    return { live: false, dispose: () => {} }
  }
  return {
    live: true,
    dispose: () => {
      try {
        if (typeof off === 'function') off()
      } catch (_) {
        /* 静默 */
      }
    },
  }
}

module.exports = { tapSessionEvents }
