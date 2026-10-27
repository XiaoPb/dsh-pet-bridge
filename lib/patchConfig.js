'use strict'

/**
 * patch 覆写条目（profile cordis.patch.yml）里 pet-bridge 的 selfPublishRandomLines 读写。
 *
 * 官方机制（DeepSeek Harness 文档「Plugin Composition: Profiles, Bundles & Configuration」）：
 * 配置树按层叠加，profile 自己的 cordis.patch.yml 在所有 bundle 层之后，patch 条目
 * 按 id 定位覆盖（整行替换，不是字段合并）。桥插件 bundle 层的 insert 行没有 config，
 * 所以这里写入的最小条目就是该行生效的完整 config。
 *
 * YAML 只做行级最小操作，绝不重排用户的其他条目：
 *  - 开（默认）：删除 pet-bridge 覆盖条目（缺省即 true，文件保持干净）；
 *  - 关：条目存在就把 `selfPublishRandomLines: false` 写进其 config 块，
 *    不存在就在文件末尾追加一个最小条目。
 *
 * 条目格式（与装载契约一致）：
 *   - id: pet-bridge
 *     name: '@xiaopb/dsh-pet-bridge'
 *     config:
 *       selfPublishRandomLines: false
 *
 * 定位：环境变量 DSH_HOME（Android 宿主恒有；桌面 DSH 也设置它）→
 * $DSH_HOME/profiles/web/cordis.patch.yml。找不到文件时返回 null / 写入失败，
 * 调用方降级为「仅本次运行内生效」。
 */

const fs = require('node:fs')
const path = require('node:path')

const ENTRY_ID = 'pet-bridge'
const PLUGIN_NAME = '@xiaopb/dsh-pet-bridge'
const KEY = 'selfPublishRandomLines'

/** profile patch 文件路径；解析不出（无 DSH_HOME/HOME）返回 null。 */
function resolvePatchFile(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME ? env.DSH_HOME : null
  if (!home) return null
  return path.join(home, 'profiles', 'web', 'cordis.patch.yml')
}

/** 读当前持久化的值；文件缺失/无条目/无键 = 默认 true；读失败返回 null（未知）。 */
function readSelfPublish(file) {
  if (!file) return null
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (_) {
    return null
  }
  const range = entryRange(text.split('\n'))
  if (!range) return true
  const block = text.split('\n').slice(range.start, range.end + 1)
  const m = block
    .map((l) => l.match(/^[ \t]*-?[ \t]*selfPublishRandomLines[ \t]*:[ \t]*(true|false)[ \t]*(?:#.*)?$/))
    .find(Boolean)
  return m ? m[1] === 'true' : true
}

/**
 * 写入开关值。返回 {ok, reason?}；文件不存在时按默认值语义处理：
 *  - 写 true：无需文件，视为成功（缺省即 true）；
 *  - 写 false：需要落盘，文件缺失则先创建（含目录）。
 */
function writeSelfPublish(file, enabled) {
  if (!file) return { ok: false, reason: 'no-dsh-home' }
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code !== 'ENOENT') return { ok: false, reason: 'read-failed' }
    if (enabled) return { ok: true } // 无文件 = 默认开，无需写
    text = ''
  }
  const lines = text.split('\n')
  const range = entryRange(lines)
  let out
  if (enabled) {
    if (!range) return { ok: true } // 本来就是默认开
    out = lines.slice(0, range.start).concat(lines.slice(range.end + 1))
    // 全部条目被移空时回写空数组占位：空文档对加载器不是合法的 patch 层
    if (out.every((l) => l.trim() === '')) out = ['[]', '']
  } else if (!range) {
    out = trimTrailingBlank(lines).concat([
      '- id: ' + ENTRY_ID,
      "  name: '" + PLUGIN_NAME + "'",
      '  config:',
      '    ' + KEY + ': false',
      '',
    ])
  } else {
    const block = lines.slice(range.start, range.end + 1)
    const keyIdx = block.findIndex((l) => /^[ \t]*-?[ \t]*selfPublishRandomLines[ \t]*:/.test(l))
    const cfgIdx = block.findIndex((l) => l.trimEnd() === '  config:')
    let newBlock
    if (keyIdx >= 0) {
      newBlock = block.map((l, i) => (i === keyIdx ? '    ' + KEY + ': false' : l))
    } else if (cfgIdx >= 0) {
      newBlock = block.slice()
      newBlock.splice(cfgIdx + 1, 0, '    ' + KEY + ': false')
    } else {
      newBlock = block.concat(['  config:', '    ' + KEY + ': false'])
    }
    out = lines.slice(0, range.start).concat(newBlock, lines.slice(range.end + 1))
  }
  return writeAtomic(file, out.join('\n'))
}

// ------------------------------------------------------------ 行级解析（与条目格式契约对齐）

/**
 * 找 `- id: pet-bridge`（或 name 指向本插件）条目的行区间；null = 不存在。
 * 条目头是 "- xxx"，后续同级/更深的内容都属于这个条目，直到下一个顶层 "- "。
 */
function entryRange(lines) {
  const start = lines.findIndex(isEntryHead)
  if (start < 0) return null
  const bodyIndent = indentOf(lines[start])
  let end = start
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') {
      end = i
      continue
    }
    const indent = indentOf(l)
    const trimmed = l.trimStart()
    if (indent <= bodyIndent && trimmed.startsWith('- ')) break
    if (indent <= bodyIndent && !trimmed.startsWith('-')) break
    end = i
  }
  while (end > start && lines[end].trim() === '') end--
  return { start, end }
}

function isEntryHead(line) {
  const t = line.trimStart()
  if (!t.startsWith('- ')) return false
  const rest = t.slice(2).trim()
  if (rest.startsWith('id:') && rest.slice(3).trim() === ENTRY_ID) return true
  if (rest.startsWith('name:')) {
    const name = rest.slice(5).trim().replace(/^['"]|['"]$/g, '')
    if (name === PLUGIN_NAME) return true
  }
  return false
}

function indentOf(line) {
  const i = line.search(/[^ \t]/)
  return i === -1 ? line.length : i
}

function trimTrailingBlank(lines) {
  const out = lines.slice()
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

/** 原子写：先写临时文件再 rename；rename 失败退回直接覆盖。 */
function writeAtomic(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.bridge-tmp'
    fs.writeFileSync(tmp, content, 'utf8')
    try {
      fs.renameSync(tmp, file)
    } catch (_) {
      fs.writeFileSync(file, content, 'utf8')
      try {
        fs.unlinkSync(tmp)
      } catch (_) {
        /* 已被 rename 走或不存在 */
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e && e.code === 'EACCES' ? 'forbidden' : 'write-failed' }
  }
}

module.exports = { resolvePatchFile, readSelfPublish, writeSelfPublish, ENTRY_ID, KEY }
