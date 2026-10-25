'use strict'

/**
 * agentWatcher：观察单个 agent 的事件流，按「位置游标」增量轮询。
 *
 * 与上游 0.1.0 一致的契约要点：
 *   - 以数组位置（index）为增量游标，忠于 events 的追加顺序处理；
 *   - 每 tick 快照 sess.events 引用再遍历，游标只增；
 *   - 事件映射：turn/start -> user；tool/call -> pre（tool_name + 摘要）；
 *     tool/result -> post；turn/end -> stop；其余不推送；
 *   - session.events 缺失/为空 -> 该 tick 跳过；
 *   - dispose 后停 interval、置 dead，不再产生任何推送。
 *   - 可选 onRawEvent(agent, ev)：在游标推进处回传原始事件（v0.3.0 轮询兜底用，
 *     仅当宿主 session/event 不可用时启用）。
 */

const { summarizeToolInput } = require('./toolLabels')

function createWatcher(agent, cfg, emit, debug, onRawEvent) {
  const safeDebug = (...args) => {
    try {
      if (typeof debug === 'function') return debug(...args)
    } catch (_) {
      /* 静默 */
    }
  }
  let position = 0 // 位置游标：下一个待处理事件的数组下标
  let dead = false
  let interval = null

  if (!agent) return { dispose: () => {}, finalStop: () => {} }

  const tick = () => {
    if (dead) return
    const sess = agent.session
    if (!sess || !Array.isArray(sess.events)) return
    const events = sess.events // 快照引用
    let i = position
    for (; i < events.length; i++) {
      const ev = events[i]
      if (!ev || typeof ev.type !== 'string') continue
      switch (ev.type) {
        case 'turn/start':
          emit('user')
          break
        case 'tool/call': {
          const name = ev.data && typeof ev.data.name === 'string' ? ev.data.name : undefined
          const argsJSON = ev.data && typeof ev.data.arguments === 'string' ? ev.data.arguments : undefined
          const summary = summarizeToolInput(name, argsJSON)
          emit('pre', name, summary)
          break
        }
        case 'tool/result':
          emit('post')
          break
        case 'turn/end':
          emit('stop')
          break
      default:
        break
      }
      // 轮询兜底的原始事件回传（仅宿主不支持 session/event 时由调用方启用）
      if (onRawEvent) {
        try {
          onRawEvent(agent, ev)
        } catch (_) {
          /* 静默 */
        }
      }
    }
    position = events.length
  }

  if (cfg.enabled !== false) {
    try {
      interval = setInterval(tick, cfg.pollInterval)
      if (interval && typeof interval.unref === 'function') interval.unref()
    } catch (err) {
      safeDebug(`dsh-pet-bridge: setInterval failed ${err.message}`)
    }
  }

  const stopPolling = () => {
    if (interval) {
      try {
        clearInterval(interval)
      } catch (e) {
        /* no-op */
      }
      interval = null
    }
  }

  return {
    dispose() {
      if (dead) return
      dead = true
      stopPolling()
    },
    /** agent/disposed：补发一条 stop（幂等无害），随后彻底停用 */
    finalStop() {
      if (dead) return
      emit('stop')
      dead = true
      stopPolling()
    },
  }
}

module.exports = { createWatcher }
