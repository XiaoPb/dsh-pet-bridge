'use strict'

/**
 * bridgeState：桥内统一发布状态 —— 对外发布的**唯一**数据源。
 *
 * 形状对齐 dsh-pet 的 PollState 设计（counter = 最后一次写入的编号，顶层全局单点递增）：
 *   {
 *     counter: 1760000000007,          // 整份发布状态的版本 = 最后一次写入的编号
 *     workStatus: { counter, data },   // data = dsh-pet 兼容快照 {state, task, ts}
 *     events:   { counter, data },     // data = 最近事件环形缓冲（数组，新在后）
 *   }
 *
 * counter 语义与 dsh-pet 一致：取值 Date.now() 并保证严格递增（同毫秒连写 +1 兜底）；
 * 前端/消费端拿 counter 当 ?since= 回传，变了就有新东西。内存态，重启即空。
 */

const MAX_EVENTS = 200 // 事件环形缓冲上限
const MAX_WAIT_MS = 10 * 1000 // 长轮询挂起封顶（与 dsh-pet MAX_STATE_WAIT_MS 同值同因）

const emptyLeaf = () => ({ counter: 0, data: null })

function createBridgeState() {
  let last = 0
  const workStatus = emptyLeaf()
  const eventsLeaf = emptyLeaf()
  const events = [] // 环形缓冲（新事件 push 到尾部）
  const waiters = new Set()

  const next = () => {
    last = Math.max(Date.now(), last + 1)
    return last
  }

  const wakeWaiters = () => {
    if (waiters.size === 0) return
    for (const w of [...waiters]) {
      if (w.since === last) continue
      if (w.timer !== undefined) {
        clearTimeout(w.timer)
        w.timer = undefined
      }
      waiters.delete(w)
      w.onWake()
    }
  }

  return {
    /** 当前发布状态（leaf 整体替换写入，消费端不会读到半新半旧的叶子） */
    read() {
      return {
        counter: last,
        workStatus: { ...workStatus },
        events: { ...eventsLeaf },
      }
    },

    /** 写工作状态快照（dsh-pet 兼容形状 {state, task, ts}） */
    writeWorkStatus(data) {
      workStatus.counter = next()
      workStatus.data = data
      wakeWaiters()
    },

    /** 追加一条原始事件到环形缓冲（对齐 dsh-pet 事件源；超上限淘汰最旧） */
    pushEvent(entry) {
      events.push(entry)
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
      eventsLeaf.counter = next()
      eventsLeaf.data = events
      wakeWaiters()
    },

    /** 最近 n 条事件（默认 50，上限 MAX_EVENTS）；新在后 */
    recentEvents(n = 50) {
      const limit = Math.max(1, Math.min(Number(n) || 50, MAX_EVENTS))
      return events.slice(-limit)
    },

    /** 事件缓冲条数 */
    eventCount() {
      return events.length
    },

    /**
     * 挂起等待：直到 last !== since 或超时。onWake 后调用方去 read() 拿最新状态。
     * 返回取消函数。参数非法（since<0 / timeout 越界）返回 null，由路由回 400。
     */
    wait(since, timeoutMs, onWake) {
      if (!Number.isFinite(since) || since < 0) return null
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) return null
      const w = { since, timer: undefined, onWake }
      waiters.add(w)
      w.timer = setTimeout(() => {
        waiters.delete(w)
        onWake()
      }, Math.max(0, timeoutMs))
      if (w.timer && typeof w.timer.unref === 'function') w.timer.unref()
      return () => {
        if (w.timer !== undefined) {
          clearTimeout(w.timer)
          w.timer = undefined
        }
        waiters.delete(w)
      }
    },

    /** 结束所有挂起等待（插件卸载路径）：唤醒不带区分标志，调用方去 read() 收尾 */
    cancelAll() {
      for (const w of [...waiters]) {
        if (w.timer !== undefined) {
          clearTimeout(w.timer)
          w.timer = undefined
        }
        waiters.delete(w)
        w.onWake()
      }
    },

    /** 当前等待者数（观测用：验证不泄漏） */
    waiterCount() {
      return waiters.size
    },

    MAX_EVENTS,
    MAX_WAIT_MS,
  }
}

module.exports = { createBridgeState }
