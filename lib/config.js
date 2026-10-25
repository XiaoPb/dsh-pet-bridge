'use strict'

/**
 * config 归一化：port 默认 7779（仅回环生效），pollInterval 默认 250ms 且必须 >0，
 * enabled 默认 true，auth 默认 "auto"。apply 对缺省配置宽容，不抛错。
 *
 * auth 开关（用于双向验证 APK 的 token 门控）：
 *   - "auto"（默认）：DSH_PET_BRIDGE_TOKEN 存在时随请求带 X-DSH-Pet-Token 头；
 *   - "off"：刻意不带 token，模拟上游 0.1.0 的旧行为 —— App 侧应回 403，
 *     用于验证 fail-closed 生效。也可用环境变量 DSH_PET_BRIDGE_AUTH=off 覆盖。
 */

const DEFAULT_PORT = 7779
const DEFAULT_POLL_INTERVAL = 250

function normalizeConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {}
  const authEnv = (process.env.DSH_PET_BRIDGE_AUTH || '').toLowerCase()
  return {
    enabled: raw.enabled !== false,
    port: typeof raw.port === 'number' && Number.isFinite(raw.port) ? raw.port : DEFAULT_PORT,
    pollInterval:
      typeof raw.pollInterval === 'number' && Number.isFinite(raw.pollInterval) && raw.pollInterval > 0
        ? raw.pollInterval
        : DEFAULT_POLL_INTERVAL,
    auth: (raw.auth === 'off' || authEnv === 'off') ? 'off' : 'auto',
  }
}

module.exports = { normalizeConfig, DEFAULT_PORT, DEFAULT_POLL_INTERVAL }
