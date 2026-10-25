'use strict'

/**
 * petSource：直连 dsh-pet 0.3.x 的工作状态监听器 —— 桥的**主数据源**。
 *
 * dsh-pet 把聚合好的状态发布在自己的 HTTP 路由上（桌面 Helper 消费同一份）：
 *   GET {origin}/dsh-pet-7340/state?since=<counter>&timeout=<ms>
 * 响应 PollState：{ counter, sections: { workStatus: {counter, data}, notify, ... },
 * pets: {...} }，workStatus.data = { state, task }（state ∈ 6 档或 null）。
 * 长轮询语义：since === 当前 counter 时挂起，变化/超时即返回（≤10s）。
 *
 * 本模块不做任何状态归约 —— 数据就是 dsh-pet 自己算的，桥只搬运。连续失败达到
 * 阈值上报 onError('unhealthy')（调用方据此切回退引擎），恢复后上报 onRecover。
 * 全路径静默降级：网络错/JSON 错/路由 404 都不算致命，只计入失败计数。
 */

const ROUTE_PREFIX = '/dsh-pet-7340'
const DEFAULT_ORIGIN = 'http://127.0.0.1:3080'
const POLL_TIMEOUT_MS = 8 * 1000 // < dsh-pet MAX_STATE_WAIT_MS(10s)，留网络余量

function createPetSource(options = {}) {
  const origin = String(options.origin || process.env.DSH_PET_BRIDGE_PET_URL || DEFAULT_ORIGIN).replace(/\/+$/, '')
  const pollTimeoutMs = Number.isFinite(options.pollTimeoutMs) && options.pollTimeoutMs > 0 ? options.pollTimeoutMs : POLL_TIMEOUT_MS
  const failureThreshold = Number.isFinite(options.failureThreshold) && options.failureThreshold > 0 ? options.failureThreshold : 3
  const debug = typeof options.debug === 'function' ? options.debug : () => {}
  const onWorkStatus = typeof options.onWorkStatus === 'function' ? options.onWorkStatus : null
  const onSection = typeof options.onSection === 'function' ? options.onSection : null
  const onError = typeof options.onError === 'function' ? options.onError : null
  const onRecover = typeof options.onRecover === 'function' ? options.onRecover : null

  let since = 0 // dsh-pet 侧 counter 基线：0 = 首拉全量
  let seenWorkStatusCounter = 0
  let failures = 0
  let healthy = false // 是否已成功拉到过且未跌破阈值
  let unhealthyReported = false // 'unhealthy' 只上报一次，恢复成功后复位
  let stopping = false
  let controller = null // 进行中请求的 AbortController

  const noteSuccess = () => {
    failures = 0
    unhealthyReported = false
    if (!healthy) {
      healthy = true
      if (onRecover) {
        try {
          onRecover()
        } catch (_) {
          /* 静默 */
        }
      }
    }
  }

  const noteFailure = (reason) => {
    failures += 1
    debug(`dsh-pet-bridge: petSource poll failed (${failures}/${failureThreshold}): ${reason}`)
    if (failures >= failureThreshold) {
      healthy = false
      if (!unhealthyReported) {
        unhealthyReported = true
        if (onError) {
          try {
            onError('unhealthy')
          } catch (_) {
            /* 静默 */
          }
        }
      }
    }
  }

  const consume = (state) => {
    if (!state || typeof state !== 'object') return
    const sections = state.sections && typeof state.sections === 'object' ? state.sections : {}
    const ws = sections.workStatus
    if (ws && typeof ws === 'object' && ws.counter !== seenWorkStatusCounter) {
      seenWorkStatusCounter = ws.counter
      const data = ws.data && typeof ws.data === 'object' ? ws.data : null
      if (onWorkStatus && data) {
        try {
          // dsh-pet 0.3.8 写入形状：{ state, task }（ts 由桥补上，供消费端判新鲜度）
          onWorkStatus({ state: data.state ?? null, task: data.task ?? null, ts: Date.now() })
        } catch (_) {
          /* 静默 */
        }
      }
    }
    // 其他 section（notify 等）按需透传（onSection(sectionName, data)）
    if (onSection) {
      for (const name of Object.keys(sections)) {
        if (name === 'workStatus') continue
        const leaf = sections[name]
        if (leaf && typeof leaf === 'object') {
          try {
            onSection(name, leaf.data ?? null)
          } catch (_) {
            /* 静默 */
          }
        }
      }
    }
  }

  const loop = async () => {
    while (!stopping) {
      controller = new AbortController()
      const ac = controller
      try {
        const url = `${origin}${ROUTE_PREFIX}/state?since=${encodeURIComponent(String(since))}&timeout=${pollTimeoutMs}`
        const resp = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } })
        if (!resp.ok) {
          noteFailure(`HTTP ${resp.status}`)
          await sleep(stopping ? 0 : backoffMs(failures), ac.signal)
          continue
        }
        const body = await resp.json()
        noteSuccess()
        if (typeof body.counter === 'number') since = body.counter
        consume(body)
      } catch (err) {
        if (stopping) break
        noteFailure(err && err.name === 'AbortError' ? 'aborted' : err.code || err.message)
        await sleep(backoffMs(failures), ac.signal)
      } finally {
        if (controller === ac) controller = null
      }
    }
  }

  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      if (ms <= 0 || stopping) return resolve()
      const t = setTimeout(resolve, ms)
      if (t && typeof t.unref === 'function') t.unref()
      if (signal) {
        const onAbort = () => {
          clearTimeout(t)
          resolve()
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })

  const backoffMs = (n) => Math.min(1000 * Math.max(0, n - 1), 10 * 1000)

  return {
    start() {
      if (!stopping) {
        stopping = false
        loop()
      }
    },
    stop() {
      stopping = true
      if (controller) {
        try {
          controller.abort()
        } catch (_) {
          /* 静默 */
        }
      }
    },
    get healthy() {
      return healthy
    },
    get origin() {
      return origin
    },
  }
}

module.exports = { createPetSource, ROUTE_PREFIX, DEFAULT_ORIGIN, POLL_TIMEOUT_MS }
