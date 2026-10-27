'use strict'

/**
 * config 归一化：apply 对缺省配置宽容，不抛错。
 *
 * v0.3.0 新增（对外发布 dsh-pet 信息）：
 *   - mode：数据源模式
 *       "auto"（默认）= 直连 dsh-pet /state 长轮询，连续失败达阈值后回退本地归约（replay），
 *                       dsh-pet 恢复后自动切回直连；
 *       "listen"      = 仅直连 dsh-pet；
 *       "replay"      = 仅本地从 session/event 归约（不依赖 dsh-pet 装没装）。
 *   - petBaseUrl：dsh-pet 路由 origin（默认 http://127.0.0.1:3080，与桌面 Helper 同源；
 *     可用环境变量 DSH_PET_BRIDGE_PET_URL 覆盖）。
 *   - serverEnabled / serverPort：回环拉取服务开关与端口（默认 7780，仅 127.0.0.1）。
 *   - token：对外服务与 webhook 的默认鉴权 token。解析顺序 config.token > 环境变量
 *     DSH_PET_BRIDGE_TOKEN > 进程内随机生成（随机时由入口在启动日志打一次）。
 *   - targets：webhook 推送目标数组，每项 {url, header?, token?, events?, timeoutMs?}；
 *     events=true 的目标额外接收原始会话事件（kind="event"）。
 *
 * 保留 v0.2.0（手机桌宠 /bubble 推送）：port、pollInterval、enabled、auth。
 *
 * v0.3.5 新增：selfPublishRandomLines（默认 true）。关闭后 /bubble 的 text
 * 只携带 dsh-pet 聚合的真实任务详情，不再由桥端随机抽句兜底——手机桌宠
 * （protocol 3）此时改用它自己的台词库（App 端可编辑）。
 * 该项同时通过 lib/schema.js 的 Config schema 暴露在 dsh 设置界面（开关）。
 */

const DEFAULT_PORT = 7779 // 手机桌宠 /bubble
const DEFAULT_POLL_INTERVAL = 250
const DEFAULT_SERVER_PORT = 7780 // 回环发布服务
const DEFAULT_PET_BASE_URL = 'http://127.0.0.1:3080'

function normalizeTargets(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const t of raw) {
    if (!t || typeof t !== 'object' || typeof t.url !== 'string' || t.url.length === 0) continue
    out.push({
      url: t.url,
      header: typeof t.header === 'string' && t.header.length > 0 ? t.header : undefined,
      token: typeof t.token === 'string' && t.token.length > 0 ? t.token : undefined,
      events: t.events === true,
      timeoutMs: typeof t.timeoutMs === 'number' && Number.isFinite(t.timeoutMs) && t.timeoutMs > 0 ? t.timeoutMs : undefined,
    })
  }
  return out
}

function normalizeConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const authEnv = (process.env.DSH_PET_BRIDGE_AUTH || '').toLowerCase()
  const modeEnv = (process.env.DSH_PET_BRIDGE_MODE || '').toLowerCase()

  let mode = raw.mode
  if (mode !== 'listen' && mode !== 'replay') mode = 'auto'
  if (modeEnv === 'listen' || modeEnv === 'replay' || modeEnv === 'auto') mode = modeEnv

  const petBaseUrlEnv = process.env.DSH_PET_BRIDGE_PET_URL
  const petBaseUrlRaw =
    typeof petBaseUrlEnv === 'string' && petBaseUrlEnv.length > 0
      ? petBaseUrlEnv
      : typeof raw.petBaseUrl === 'string' && raw.petBaseUrl.length > 0
        ? raw.petBaseUrl
        : DEFAULT_PET_BASE_URL
  const petBaseUrl = petBaseUrlRaw.replace(/\/+$/, '')

  const token =
    typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : process.env.DSH_PET_BRIDGE_TOKEN || undefined

  return {
    // ---- v0.2.0 既有配置（/bubble 推送）----
    enabled: raw.enabled !== false,
    port: typeof raw.port === 'number' && Number.isFinite(raw.port) ? raw.port : DEFAULT_PORT,
    pollInterval:
      typeof raw.pollInterval === 'number' && Number.isFinite(raw.pollInterval) && raw.pollInterval > 0
        ? raw.pollInterval
        : DEFAULT_POLL_INTERVAL,
    auth: raw.auth === 'off' || authEnv === 'off' ? 'off' : 'auto',
    // ---- v0.3.5 新增（随机词句自发布开关）----
    selfPublishRandomLines: raw.selfPublishRandomLines !== false,
    // ---- v0.3.0 新增（对外发布）----
    mode,
    petBaseUrl,
    serverEnabled: raw.serverEnabled !== false,
    serverPort: typeof raw.serverPort === 'number' && Number.isFinite(raw.serverPort) ? raw.serverPort : DEFAULT_SERVER_PORT,
    token,
    targets: normalizeTargets(raw.targets),
  }
}

module.exports = {
  normalizeConfig,
  normalizeTargets,
  DEFAULT_PORT,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_SERVER_PORT,
  DEFAULT_PET_BASE_URL,
}
