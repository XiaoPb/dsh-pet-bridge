'use strict'

/**
 * workStatus：dsh-pet 0.3.8 工作状态聚合逻辑的宿主侧移植（CommonJS）。
 *
 * 对接 dsh-pet 的核心：dsh-pet 通过 ctx.on("session/event") 把 DSH 会话事件
 * 压缩成 6 档工作状态（thinking/working/result/waiting/success/error）+ todo
 * 任务详情，浏览器与桌面两端轮询 /state 后按 counter 变化渲染。本桥按**同一
 * 事件源、同一归约语义**独立维护一份快照，把 dsh-pet「看到的东西」原样对外
 * 发布 —— 桥不依赖 dsh-pet 装没装、跑没跑，协议级兼容。
 *
 * 移植自 dsh-pet src/host/work-status.ts（MIT，PC2005-cloud/dsh-pet），
 * 语义保持一致；纯逻辑无 IO，全部降级路径不抛错。
 *
 * 档位与 dsh-pet animations.events.workStatus 数组索引严格一致（顺序勿在中间插入）：
 *   0 thinking / 1 working / 2 result / 3 waiting / 4 success / 5 error
 */

/** 工作状态档位（与 dsh-pet shared/host 两侧一致） */
const HOST_WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error']

/**
 * turn/end reason.kind → 状态：
 *   completed → success、错误系（error/max-tokens/timeout）→ error、blocked → waiting；
 *   其余（aborted 等）→ null ＝ 该会话回合已结束，由调用方清理会话回空闲。
 */
function turnEndState(kind) {
  if (kind === 'completed') return 'success'
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error'
  if (kind === 'blocked') return 'waiting'
  return null
}

/** ask_user_question 工具名：模型在等用户选择题答复 → waiting */
const USER_QUESTION_TOOL = 'ask_user_question'

/** update_goal 工具名：action=complete/blocked = 本轮是该目标任务的收尾轮 */
const GOAL_UPDATE_TOOL = 'update_goal'

/** 解析 update_goal 的 arguments（原始 JSON 字符串）→ 收尾动作；解析失败/非收尾动作 → null */
function goalUpdateAction(args) {
  try {
    const o = JSON.parse(args)
    const action = String((o && o.action) ?? '')
    if (action === 'complete' || action === 'blocked') return action
  } catch (_) {
    /* 非法 JSON：按未收尾处理 */
  }
  return null
}

/**
 * turn/end reason=completed 的终局判定（与 dsh-pet 一致）：
 *   - 非 goal 轮（默认）→ success；
 *   - 自动续跑轮中间轮（goalRound && 未收尾）→ result：本轮完成 ≠ 整个任务完成；
 *   - 收尾轮 complete → success；收尾轮 blocked → error。
 */
function completedState(turn) {
  if (!turn || !turn.goalRound) return 'success'
  if (turn.closing === 'blocked') return 'error'
  if (turn.closing === 'complete') return 'success'
  return 'result'
}

/** 从会话事件归约出工作状态；无变化/不关心返回 null（turn 为当前回合上下文） */
function reduceWorkStatus(event, turn) {
  switch (event && event.type) {
    case 'turn/start':
      return 'thinking'
    case 'tool/call': {
      if (String((event.data && event.data.name) ?? '') === USER_QUESTION_TOOL) return 'waiting'
      return 'working'
    }
    case 'tool/result':
      return 'result'
    case 'approval/asked':
      return 'waiting'
    case 'turn/end': {
      const reason = turnEndState(String(((event.data && event.data.reason) || {}).kind ?? ''))
      if (reason === 'success') return completedState(turn)
      return reason
    }
    default:
      return null // todo/write 等：不切动画（详情文案由调用方另行处理）
  }
}

/** 任务详情文案长度上限（按码点计）——气泡最大宽度只有 0.5×宠物宽，过长撑爆气泡 */
const TASK_TEXT_MAX = 40

/**
 * todo/write 的 in_progress/pending 项文本 → 任务详情；null = 无（清单已全部完成）。
 * 取最后一个 in_progress（agent 常忘把上一步标 completed）；无则回落第一个 pending。
 */
function currentTaskFromTodo(event) {
  const todos = (event && event.data && Array.isArray(event.data.todos)) ? event.data.todos : []
  let current
  for (const t of todos) {
    if (t && t.status === 'in_progress') current = t
  }
  if (!current) current = todos.find((t) => t && t.status === 'pending')
  const content = String((current && current.content) ?? '').trim()
  if (!content) return null
  // 按码点切，避免把代理对（emoji 等）截成半个字符
  const points = Array.from(content)
  return points.length > TASK_TEXT_MAX ? points.slice(0, TASK_TEXT_MAX).join('') + '…' : content
}

/** 展示优先级：waiting > error > working > thinking > result > success */
const WORK_STATUS_PRIORITY = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
}

/** 展示用条目：所有会话里优先级最高者（同优先级取 seq 更大者）；无会话 → undefined */
function pickDisplayed(entries) {
  let best
  for (const entry of entries) {
    if (
      !best ||
      WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] ||
      (WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq)
    ) {
      best = entry
    }
  }
  return best
}

/** 每会话聚合条目：state + seq + task（任务详情文案） */

/**
 * 工作状态聚合（与 dsh-pet WorkStatusStore 同语义）：按会话维护 state/task，
 * 对外只暴露一个展示快照 {state, task, ts}。task 挂在会话条目上，与它的会话
 * 同生共死，不会残留到后续无关活动。
 */
class WorkStatusStore {
  constructor() {
    this.sessions = new Map()
    this.snap = { state: null, task: null, ts: 0 }
  }

  has(sessionId) {
    return this.sessions.has(sessionId)
  }

  stateOf(sessionId) {
    const e = this.sessions.get(sessionId)
    return e ? e.state : undefined
  }

  taskOf(sessionId) {
    const e = this.sessions.get(sessionId)
    return e ? e.task : null
  }

  /** 写会话状态（保留该会话已有 task）；同状态且 seq 不更新 → false（防刷屏） */
  setState(sessionId, state, seq = 0) {
    const prev = this.sessions.get(sessionId)
    if (prev && prev.state === state && prev.seq >= seq) return false
    this.sessions.set(sessionId, { state, seq, task: prev ? prev.task : null })
    this.refresh()
    return true
  }

  /** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动 */
  setTask(sessionId, task) {
    const prev = this.sessions.get(sessionId)
    if (!prev || prev.task === task) return false
    this.sessions.set(sessionId, { ...prev, task })
    this.refresh()
    return true
  }

  /** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失 */
  clear(sessionId) {
    if (!this.sessions.delete(sessionId)) return false
    this.refresh()
    return true
  }

  /** 展示快照（对象引用稳定，供 /work-status 直接序列化） */
  snapshot() {
    return this.snap
  }

  /** 重算展示：state 与 task 任一变化才更新 ts（轮询侧据此触发） */
  refresh() {
    const best = pickDisplayed(this.sessions.values())
    const nextState = best ? best.state : null
    const nextTask = best ? best.task : null
    if (nextState === this.snap.state && nextTask === this.snap.task) return
    this.snap.state = nextState
    this.snap.task = nextTask
    this.snap.ts = Date.now()
  }
}

/** 终态（success/error）展示窗口：到点自动清会话条目，陈旧完成态不再浮上来（与 dsh-pet 一致 60s） */
const TERMINAL_KEEP_MS = 60 * 1000

/**
 * 会话事件喂食器：把 (sessionId, event) 流喂进 WorkStatusStore，并维护
 * dsh-pet 同款的 turn 级标志（goal 续跑轮 / update_goal 收尾）与终态清理。
 *
 * onChange(change) 在快照可能变化后被调用（change = {state, task, ts}）；
 * 调用方据此决定是否对外发布。全路径不抛错。
 */
function createWorkStatusFeed(debug) {
  const safeDebug = (...args) => {
    try {
      if (typeof debug === 'function') debug(...args)
    } catch (_) {
      /* 静默降级 */
    }
  }
  const store = new WorkStatusStore()
  const turnFlags = new Map() // sessionId -> {goalRound, closing}
  const terminalTimers = new Map()
  let onChange = null
  let dead = false

  const publish = () => {
    if (!onChange) return
    try {
      onChange({ ...store.snapshot() })
    } catch (e) {
      safeDebug(`dsh-pet-bridge: workStatus onChange failed: ${e.message}`)
    }
  }

  const cancelTerminalCleanup = (sessionId) => {
    const t = terminalTimers.get(sessionId)
    if (t) {
      clearTimeout(t)
      terminalTimers.delete(sessionId)
    }
  }

  const scheduleTerminalCleanup = (sessionId) => {
    if (terminalTimers.has(sessionId)) return
    const t = setTimeout(() => {
      terminalTimers.delete(sessionId)
      if (store.clear(sessionId)) publish()
    }, TERMINAL_KEEP_MS)
    if (t && typeof t.unref === 'function') t.unref()
    terminalTimers.set(sessionId, t)
  }

  const feed = (sessionId, event) => {
    if (dead || !sessionId || !event || typeof event.type !== 'string') return
    const type = event.type
    const data = event.data && typeof event.data === 'object' ? event.data : {}

    if (type === 'todo/write') {
      // 任务详情文案：只写有活动条目的会话，否则会成为「幽灵文案」
      if (store.has(sessionId)) {
        store.setTask(sessionId, currentTaskFromTodo({ data }))
        publish()
      }
      return
    }
    if (type === 'user/message') {
      // 目标续跑轮判定：source.kind==='goal' 的自动轮，其 completed 只是「本轮完成」
      const source = data.source
      if (source && source.kind === 'goal') {
        const flags = turnFlags.get(sessionId) || { goalRound: false, closing: null }
        flags.goalRound = true
        turnFlags.set(sessionId, flags)
      }
      return
    }
    if (type === 'turn/start') {
      turnFlags.set(sessionId, { goalRound: false, closing: null })
      // 新一轮清掉上一轮的任务详情文案，否则它会一直挂着
      store.setTask(sessionId, null)
      publish()
    }
    if (type === 'tool/call' && String(data.name ?? '') === GOAL_UPDATE_TOOL) {
      const action = goalUpdateAction(typeof data.arguments === 'string' ? data.arguments : '')
      if (action) {
        const flags = turnFlags.get(sessionId) || { goalRound: false, closing: null }
        flags.closing = action
        turnFlags.set(sessionId, flags)
      }
    }

    const next = reduceWorkStatus({ type, data }, turnFlags.get(sessionId))
    if (!next) {
      // turn/end 的 null（aborted/未知 kind）＝回合已结束：清会话回空闲，防永久卡档
      if (type === 'turn/end') {
        turnFlags.delete(sessionId)
        cancelTerminalCleanup(sessionId)
        if (store.clear(sessionId)) publish()
      }
      return
    }
    const seq = Number(event.seq ?? 0)
    if (!store.setState(sessionId, next, seq)) return
    publish()
    // 终态只展示短暂窗口后自动清理；回到非终态则取消待执行的清理
    if (next === 'success' || next === 'error') scheduleTerminalCleanup(sessionId)
    else cancelTerminalCleanup(sessionId)
  }

  return {
    feed,
    /** 当前展示快照（引用稳定） */
    snapshot: () => ({ ...store.snapshot() }),
    setOnChange(fn) {
      onChange = typeof fn === 'function' ? fn : null
    },
    dispose() {
      dead = true
      onChange = null
      for (const t of terminalTimers.values()) clearTimeout(t)
      terminalTimers.clear()
      turnFlags.clear()
      // 不清 store：dispose 后 snapshot() 仍可读最后状态（测试/观测用）
    },
  }
}

module.exports = {
  HOST_WORK_STATUS_STATES,
  WORK_STATUS_PRIORITY,
  TASK_TEXT_MAX,
  TERMINAL_KEEP_MS,
  USER_QUESTION_TOOL,
  GOAL_UPDATE_TOOL,
  turnEndState,
  goalUpdateAction,
  completedState,
  reduceWorkStatus,
  currentTaskFromTodo,
  pickDisplayed,
  WorkStatusStore,
  createWorkStatusFeed,
}
