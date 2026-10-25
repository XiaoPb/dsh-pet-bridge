'use strict'

/**
 * collector：会话收集器，管理对所有 agent 的观察，并把每 agent 的事件推送给 bubble。
 *
 * 与上游 0.1.0 一致：接口层事件里没有「会话级时间戳/age」，多会话并发落实为
 * 每 agent 独立位置游标、按事件 append 序独立外发，不重放、不串扰、不合并。
 */

const { createWatcher } = require('./agentWatcher')

function createCollector(cfg, send, debug) {
  const watchers = new Map() // agent -> watcher 句柄

  return {
    /** 已有/新 agent 注册观察；幂等（重复注册同一 agent 不建第二个 watcher） */
    watch(agent) {
      if (!agent || watchers.has(agent)) return
      const w = createWatcher(agent, cfg, (kind, toolName, toolInput) => send(kind, toolName, toolInput), debug)
      watchers.set(agent, w)
    },

    /** agent 销毁：补发一条 stop 并彻底停用该 agent 的 watcher */
    unwatch(agent) {
      const w = watchers.get(agent)
      if (w) {
        w.finalStop()
        watchers.delete(agent)
      }
    },

    /** 卸载全部 watcher（不补发 stop） */
    dispose() {
      for (const w of watchers.values()) w.dispose()
      watchers.clear()
    },
  }
}

module.exports = { createCollector }
