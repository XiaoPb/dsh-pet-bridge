# dsh-pet-bridge（token 版）

DSH 服务端插件：把 DSH 会话状态实时推给 DSH Mobile 的系统级桌宠（`127.0.0.1:7779`）。

基于 npm 上游 `dsh-pet-bridge@0.1.0`（[wsxwj123/dsh-plugins](https://github.com/wsxwj123/dsh-plugins)，MIT）精简适配。**唯一协议变更**：每个 `POST /bubble` 请求携带 `X-DSH-Pet-Token` 头，值从引擎环境变量 `DSH_PET_BRIDGE_TOKEN` 读取。

## 为什么需要 token

DSH Mobile v1.4.21 起（PR #48 评审结论），App 侧 `/bubble` 强制鉴权（fail-closed，缺失/不匹配一律 403）：桥 token 由 App 每进程随机生成、不落盘，只经引擎环境变量 `DSH_PET_BRIDGE_TOKEN` 交给引擎内的插件 —— 同设备第三方 App 拿不到，无法再伪造桌宠表情/气泡。上游 0.1.0 不带 token，会被 403 拒绝，因此本插件是 0.1.x 用户的必需升级。

## 事件映射（与上游一致）

| DSH 事件 | kind | 备注 |
|---|---|---|
| `turn/start` | `user` | |
| `tool/call` | `pre` | `tool_name` = 原始工具名，`tool_input` = 精简摘要（≤24 字符） |
| `tool/result` | `post` | |
| `turn/end` | `stop` | |
| `agent/disposed` | `stop` | 补发一条后停用该 agent 的 watcher |

## 配置（cordis config）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `7779` | 仅回环 127.0.0.1 生效 |
| `pollInterval` | `250` | 事件轮询间隔（ms），必须 >0 |
| `enabled` | `true` | `false` 时装载但零推送 |
| `auth` | `auto` | `auto`=带 `X-DSH-Pet-Token`（值取 `DSH_PET_BRIDGE_TOKEN`）；`off`=刻意不带 token，模拟上游 0.1.0 旧行为。也可用环境变量 `DSH_PET_BRIDGE_AUTH=off` 覆盖 |

## 验证 APK（假数据框架）

`tools/verify-apk.mjs` 用假事件（read_file / bash / stop）对 APK 的 PetBridgeServer 做四项校验：

```sh
adb forward tcp:17779 tcp:7779
node tools/verify-apk.mjs --token <DSH_PET_BRIDGE_TOKEN> --port 17779
# 或不提供 --token：仅验证免鉴权 /ping 与 fail-closed 403 面
```

预期：`/ping` 200；无 token 403；错 token 403；对 token 204。
`auth: "off"` 模式下，插件的正式推送也会被 APK 拒绝（403），桌宠停在「等待桥」——这正是验证 token 可行性的对照组。

## 安装（本地路径）

```sh
dsh plugin --profile web add /path/to/dsh-pet-bridge
# 之后重启引擎（bundle 插件不热加载）
```

App 侧：设置 → 扩展 → 桌面宠物 → 授予「显示在其他应用上层」→ 开启。
未看到事件时先确认引擎重启过、`process.env.DSH_PET_BRIDGE_TOKEN` 非空（引擎日志可查）。

## 许可

MIT。源自上游 dsh-pet-bridge（MIT）。
