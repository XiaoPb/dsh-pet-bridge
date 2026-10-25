'use strict'

/**
 * summarizeToolInput：从 tool/call 的 arguments（JSON 字符串）提取精简安全摘要。
 *
 * 与 App 侧 PetProtocol.INPUT_KEYS 对齐（file_path / command / pattern / query）：
 *   - read 前缀 / write 前缀 / edit 前缀 / insert / apply_patch
 *       → { file_path: basename(file_path 或 path) }
 *   - bash / shell / exec 前缀 → { command: (command 或 cmd) 空格切首词 }
 *   - grep / search 前缀 → { pattern: (pattern 或 query) 截断 24 }
 *   - web_search → { query: query 截断 22 }
 *   - 全部值额外截断 ≤24 字符；完整 arguments 绝不上外发路径；
 *   - 非法 JSON / 非字符串 → null（pet 兜底「运行中」）。不抛错。
 */

function cap(value, n) {
  return value.length > n ? value.slice(0, n) : value
}

function pick(args, ...keys) {
  for (const k of keys) {
    if (typeof args[k] === 'string' && args[k] !== '') return args[k]
  }
  return null
}

function summarizeToolInput(name, argsJSON) {
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof argsJSON !== 'string' || argsJSON.length === 0) return null

  let args
  try {
    args = JSON.parse(argsJSON)
  } catch (err) {
    return null
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null

  if (/^(read|write|edit|insert|apply_patch)/.test(name)) {
    const raw = pick(args, 'file_path', 'path')
    if (raw === null) return null
    const base = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    if (!base) return null
    return { file_path: cap(base, 24) }
  }
  if (/^(bash|shell|exec)/.test(name)) {
    const raw = pick(args, 'command', 'cmd')
    if (raw === null) return null
    const first = raw.trim().split(/\s+/)[0]
    if (!first) return null
    return { command: cap(first, 24) }
  }
  if (/^(grep|search)/.test(name)) {
    const raw = pick(args, 'pattern', 'query')
    return raw === null ? null : { pattern: cap(raw, 24) }
  }
  if (/^web_search/.test(name)) {
    const raw = pick(args, 'query')
    return raw === null ? null : { query: cap(raw, 22) }
  }
  return null
}

module.exports = { summarizeToolInput }
