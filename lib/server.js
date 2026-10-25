'use strict'

const http = require('node:http')
const crypto = require('node:crypto')

/**
 * server：回环 HTTP 发布服务 —— 把 dsh-pet 的信息以**拉取**方式对外发布。
 *
 * 端点（仅绑定 127.0.0.1）：
 *   GET /ping                       存活探针（免鉴权，不泄露任何数据）
 *   GET /work-status                dsh-pet 工作状态快照 {state, task, ts}
 *   GET /events?limit=N             最近原始会话事件（环形缓冲，新在后）
 *   GET /state?since=&timeout=      统一发布状态（长轮询，语义对齐 dsh-pet /state）
 *
 * 鉴权（fail-closed）：除 /ping 外全部要求 `X-DSH-Bridge-Token` 头或
 * `Authorization: Bearer <token>` 与 token 严格相等（timingSafe 恒时比较）。
 * 缺失/不匹配一律 403。token 来源见 config（config.token ?? 环境变量 ?? 进程内
 * 随机生成并在启动日志打一次）。
 *
 * 与 bubble.js 同因：所有失败静默降级，绝不上抛。
 */

function safeEqual(a, b) {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(String(a ?? ''))
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b ?? ''))
  if (ab.length !== bb.length) return false
  try {
    return crypto.timingSafeEqual(ab, bb)
  } catch (_) {
    return false
  }
}

function extractToken(req) {
  const h = req.headers || {}
  const direct = h['x-dsh-bridge-token']
  if (typeof direct === 'string' && direct.length > 0) return direct
  const auth = h.authorization
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim()
  return null
}

function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  } catch (_) {
    try {
      res.destroy()
    } catch (_e) {
      /* 静默 */
    }
  }
}

function readQuery(url) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams
  } catch (_) {
    return new URLSearchParams()
  }
}

/**
 * 创建发布服务。
 * @param {object} opts { port, token, state } state = createBridgeState() 实例
 * @returns {{ port: number|null, token: string, close: () => void }}
 */
function createServer(opts = {}) {
  const state = opts.state
  let token = opts.token || process.env.DSH_PET_BRIDGE_TOKEN || ''
  if (!token) {
    // 无配置 token：进程内随机生成（不落盘），由调用方负责在启动日志里打一次
    token = crypto.randomBytes(24).toString('hex')
  }

  const handler = (req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    } catch (_) {
      /* 保持默认 */
    }

    if (req.method === 'GET' && pathname === '/ping') {
      return sendJson(res, 200, { ok: true, service: 'dsh-pet-bridge' })
    }

    // 鉴权门（fail-closed）：缺失与不匹配同为 403，不区分（与 App 侧 /bubble 语义一致）
    const provided = extractToken(req)
    if (!provided || !safeEqual(provided, token)) {
      return sendJson(res, 403, { error: 'unauthorized' })
    }

    if (req.method === 'GET' && pathname === '/work-status') {
      const data = state.read().workStatus.data
      // 未写入过 → 回明确空闲快照（与 dsh-pet 的档位空态一致），而不是裸 null
      return sendJson(res, 200, data && typeof data === 'object' ? data : { state: null, task: null, ts: 0 })
    }

    if (req.method === 'GET' && pathname === '/events') {
      const q = readQuery(req.url)
      const limit = Number(q.get('limit') || 50)
      return sendJson(res, 200, { events: state.recentEvents(limit) })
    }

    if (req.method === 'GET' && pathname === '/state') {
      const q = readQuery(req.url)
      const sinceRaw = q.get('since')
      const timeoutRaw = q.get('timeout')
      if (sinceRaw === null && timeoutRaw === null) {
        return sendJson(res, 200, state.read())
      }
      // 成对必填、范围校验（与 dsh-pet parseStateWaitQuery 同一套约定）
      if (sinceRaw === null || timeoutRaw === null) {
        return sendJson(res, 400, { error: 'since and timeout must be used together' })
      }
      const since = Number(sinceRaw)
      const timeoutMs = Number(timeoutRaw)
      if (!Number.isInteger(since) || since < 0) {
        return sendJson(res, 400, { error: 'invalid since (expect a non-negative integer)' })
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > state.MAX_WAIT_MS) {
        return sendJson(res, 400, { error: `invalid timeout (expect 0..${state.MAX_WAIT_MS})` })
      }
      const current = state.read()
      if (current.counter !== since) return sendJson(res, 200, current)
      const cancel = state.wait(since, timeoutMs, () => sendJson(res, 200, state.read()))
      if (!cancel) return sendJson(res, 400, { error: 'invalid wait parameters' })
      res.on('close', () => cancel())
      return undefined
    }

    return sendJson(res, 404, { error: 'not found' })
  }

  let server = null
  let boundPort = null
  let readyResolve
  const ready = new Promise((r) => (readyResolve = r))
  try {
    server = http.createServer(handler)
    server.on('error', () => {
      /* 端口占用等：静默降级，推送通道不受影响 */
      server = null
      boundPort = null
      readyResolve(false)
    })
    server.listen(opts.port || 0, '127.0.0.1')
    server.once('listening', () => {
      const addr = server && server.address()
      boundPort = addr && typeof addr === 'object' ? addr.port : null
      readyResolve(boundPort !== null)
    })
  } catch (e) {
    server = null
    boundPort = null
    readyResolve(false)
  }

  return {
    /** listening 就绪信号（resolve true=已监听；false=失败） */
    ready,
    /** 真实监听端口（未起来时为 null） */
    serverPort: () => boundPort,
    token,
    close: () => {
      if (server) {
        try {
          server.close()
        } catch (_) {
          /* 静默 */
        }
        server = null
        boundPort = null
      }
    },
  }
}

module.exports = { createServer, extractToken, safeEqual }
