'use strict'

/**
 * 插件设置 schema（dsh 设置界面自动渲染）。
 *
 * dsh 的 settings 服务（SettingsForms.describe）遍历活跃插件条目，读取插件
 * 导出的 `Config`（schemastery schema）生成设置表单；用户改开关 → 写入 profile
 * patch → loader 以新配置重新 apply 本插件。
 *
 * 引擎内置的 @deepseek-ai/* 模块对第三方插件代码不可解析（插件目录不在引擎
 * node_modules 的祖先链上），因此 schemastery 以 vendor 形式随包携带
 * （lib/vendor/，npm schemastery@3.18.0 + cosmokit@1.8.1，均为 MIT）。
 * 任何加载失败都降级为 Config=null：设置界面不出现本插件页，行为等同
 * selfPublishRandomLines=true（默认开）。
 */

let Config = null
try {
  const z = require('./vendor/schemastery.cjs')
  Config = z
    .object({
      selfPublishRandomLines: z
        .boolean()
        .default(true)
        .description(
          '随机词句自发布：开启后 /bubble 推送在没有 dsh-pet 任务详情时，由桥端从 dsh-pet workStatusTexts 同款台词中随机抽一句放进 text；' +
            '关闭后 text 只携带真实任务详情，手机桌宠改用它自己的台词库（App 端桌宠设置 → 台词库，可编辑六档工作状态台词）。',
        ),
    })
    .description('dsh-pet-bridge 桥接设置')
} catch (_) {
  Config = null // 静默降级：无设置界面，默认行为不变
}

module.exports = { Config }
