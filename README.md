# dsh-pet-bridge

DSH 服务端插件：**桥接 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（桌面宠物插件），把它的会话事件与工作状态对外发布** —— webhook 主动推送 + 回环 HTTP 拉取服务，全程 Token 鉴权；同时保留 v0.2.0 的手机桌宠 `/bubble` 推送。

源自 npm 上游 `dsh-pet-bridge@0.1.0`（[wsxwj123/dsh-plugins](https://github.com/wsxwj123/dsh-plugins)，MIT）；工作状态聚合语义移植自 dsh-pet 0.3.8（MIT）。当前版本协议与 0.2.x 兼容（`/bubble` 行为不变）。

## 安装

```bash
# npm（推荐）
dsh plugin add @xiaopb/dsh-pet-bridge

# 或直接从 GitHub 装
dsh plugin add github:XiaoPb/dsh-pet-bridge
```

> 无 scope 的同名包 `dsh-pet-bridge` 只有上游 0.1.0（归原作者所有，无法发新版），**不兼容带鉴权的 DSH Mobile**。

## 与 DSH Mobile 的兼容矩阵

| DSH Mobile | 要求的本插件版本 | `/bubble` 协议 |
|---|---|---|
| ≥ v1.4.21（协议 v2） | **≥ 0.3.1** | 必带 `X-DSH-Pet-Token`（fail-closed 403），显式 `Content-Length` |
| 支持 protocol 3 的版本（未发布） | ≥ 0.3.3 | v2 基础上新增可选 `text` 字段（dsh-pet 任务详情直显） |
| < v1.4.21（协议 v1） | 0.1.x（上游） | 无 token |

0.3.1 同时修了上游 0.1.0 的真 bug：`push()` 未设 `Content-Length`（Node 走 chunked 编码），而 APK 只按定长读 body，**必然回 400** —— 这是「插件已连接但桌宠没有事件」的隐性根因。App 侧从 v1.4.21 起按版本硬门禁，低于 0.3.1 会提示「需 0.3.1+」并禁止开启桌宠。

**0.3.2（2026-10-28）**：`/bubble` 五类 kind 改为**直接从 `session/event` 事件流派生**（turn/start→user、tool/call→pre、tool/result→post、turn/end→stop），不再依赖 `agent/created` + `agent.session.events` 轮询。原因：dsh 0.2.1-rc.x（sessionFormatVersion 4，DSH Mobile v1.4.29 实测）重构了 session 对象，`events` 数组不复存在（变为 `log`/`eventsSnapshot`/`derived` 等内部结构），agentWatcher 的 `Array.isArray(sess.events)` 守卫恒 false——症状正是「App 内 dsh-pet 有状态、桥接的手机桌宠无事件」。事件流通道与 session 内部形状解耦；agent 轮询仅保留给不支持 `session/event` 的老宿主作兜底。

**0.3.3（2026-10-28）**：气泡内容与 dsh-pet 对齐。协议 v2 里没有文本字段，原生侧只能按 `kind + tool_name + tool_input` 拼固定模板（"正在运行 bash" 这类），而 dsh-pet 浏览器宠物显示的是 `workStatus.task`（todo 任务详情，≤40 字）——两端内容天然不一致。本版起：

1. `/bubble` payload 新增可选 **`text`** 字段，内容取 dsh-pet 聚合的任务详情（listen 直连快照 / replay 本地归约两路同源），净化规则与 dsh-pet 一致（去控制字符、压缩空白、`TASK_TEXT_MAX`=40 code points 截断）；`turn/start` 清空、`todo/write` 更新，与 dsh-pet `WorkStatusStore` 语义相同。旧 App 忽略未知字段，完全向后兼容。
2. kind 映射对齐 dsh-pet `reduceWorkStatus` 的 6 档语义：`tool/call` 名为 `ask_user_question` 或 `approval/asked` 事件 → `waiting`；`turn/end` 按 `reason.kind` 细分（completed→stop、error/max-tokens/timeout→error、blocked→waiting、其余→stop）。

App 侧需配套（`PetProtocol.kt` 解析 `text`、`PetActionController.kt` 优先直显，protocol 2→3），未升级的 APK 上 text 被忽略、仍走模板，无副作用。

**0.3.4（2026-10-28）**：`text` 缺失（无任务详情）时回落为 dsh-pet web `workStatusTexts` 的原文随机抽句——手机桌宠（protocol 3）据此直显，与浏览器宠物完全同款措辞；六档 kind 全带 text，前向兼容。

**0.3.5（2026-10-28）**：随机词句自发布改为可配置。新增 **`selfPublishRandomLines`**（默认 `true`），并通过插件 `Config` schema（vendor 的 schemastery）暴露在 **dsh 设置界面**——设置 → 插件 → dsh-pet-bridge，一个开关：

- **开（默认）**：行为同 0.3.4，无任务详情时由桥端随机抽 dsh-pet 同款台词放进 `text`；
- **关**：`text` 只携带真实任务详情（可为 `null`），手机桌宠改用它**自己的台词库**（DSH Mobile 桌宠设置 → 台词库，六档工作状态台词可查看、编辑、导入导出）——用户想换措辞时改台词库即可，无需动桥。

实现说明：dsh 设置服务按插件导出的 `Config` schema 自动生成表单页；引擎内置的 `@deepseek-ai/schemastery` 对第三方插件不可解析，因此随包 vendor 了 npm `schemastery@3.18.0` + `cosmokit@1.8.1`（均为 MIT，见 `lib/vendor/`）。schema 加载失败时静默降级（无设置页，开关默认开，行为不变）。

**0.3.6（2026-10-28）**：设置开关改为**自绘设置分区**（双面插件）。实测发现 Android 端的 dsh 设置（原生设置页 + webview 弹窗）不渲染第三方插件的 Config schema 表单（那是桌面 web 设置的能力），参照 dsh-pet「桌宠配置」的官方方式补了浏览器半侧：

- `package.json` 声明 `exports["./client"]` + `dsh.client: { platform: "web" }`，浏览器半侧 `lib/client.js` 经 `window.__ModuleLoader__.load` 注册 **`settings.section` slot**（id `pet-bridge-config`，label「桌宠桥接」），设置页里出现一个开关卡片，即时读写；
- 宿主半侧经 `webServer.register` 挂 **`GET/PUT /dsh-pet-bridge-7781/config`**：GET 返回当前生效值与持久化值；PUT `{selfPublishRandomLines: boolean}` **即时生效**（`bubbleText` 每次推送现读运行时 cfg）并**持久化**到 `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `id: pet-bridge` 覆盖条目（官方 patch 层按 id 覆盖机制；开=删除条目回缺省，关=写入/合并最小条目，YAML 只做行级操作，绝不重排用户其他条目），重启后依然生效，无需重启引擎；
- 0.3.5 的 `Config` schema 保留（桌面 web 设置仍可用）；webServer 缺失或路由重复注册时静默降级，主流程不受影响。

## 架构：怎么对接 dsh-pet

dsh-pet 是自包含插件，通过 `session/event` 内部监听把 DSH 会话事件聚合成 6 档工作状态（thinking / working / result / waiting / success / error）+ todo 任务详情，发布在自己的 HTTP 路由上（桌面 Helper 消费同一份）。本桥两条数据通道对接：

```
                    ┌────────────────────────────────────────────┐
 DSH 宿主 ──────────▶  dsh-pet（session/event → 官方聚合）           │
                    │        │ GET /dsh-pet-7340/state（长轮询）    │
                    ┌────────▼───────────────────────────────────┐
                    │  dsh-pet-bridge                            │
                    │  ① listen：直连 dsh-pet /state（主）        │──▶ webhook 推送
                    │  ② replay：session/event 本地归约（备）      │──▶ 回环拉取服务
                    │  ③ 原始会话事件转发（dsh-pet 未对外暴露）      │──▶ /bubble（v0.2.0）
                    └────────────────────────────────────────────┘
```

- **① listen（主，mode=auto/listen）**：直连长轮询 dsh-pet 的 `GET /dsh-pet-7340/state?since=&timeout=`（与桌面 Helper 同源同协议），转发的是 **dsh-pet 官方聚合结果** `{state, task}`——零逻辑重复，dsh-pet 升级不漂移。
- **② replay（备）**：dsh-pet 不可达（未安装/未启动/下线）时，mode=auto 自动切到本地归约——从 `session/event` 按 dsh-pet 0.3.8 同款 `reduceWorkStatus` 语义（含 goal 续跑轮、todo 任务文案、终态 60s 清理）独立算出快照，保证对外不断流；dsh-pet 恢复后自动切回直连。
- **③ 原始事件**：`turn/start`、`tool/call`、`tool/result`、`approval/asked`、`turn/end`、`todo/write`、`user/message` 等原始事件环形缓冲（200 条）+ 转发——这是 dsh-pet 对外没有暴露的部分，由桥补齐。宿主不支持 `session/event` 时回退 agent 轮询游标。

## 发布出口

| 出口 | 方向 | 鉴权 | 说明 |
|---|---|---|---|
| webhook `targets` | 推 | `X-DSH-Bridge-Token`（可按目标改头/换 token） | `kind="work-status"`（状态快照）推全部目标；`kind="event"`（原始事件）只推 `events: true` 的目标。fire-and-forget，失败不重试不上抛 |
| `GET http://127.0.0.1:7780/work-status` | 拉 | 同上 | 当前工作状态快照 `{state, task, ts}`（`/ping` 免鉴权存活探针） |
| `GET http://127.0.0.1:7780/events?limit=N` | 拉 | 同上 | 最近原始事件（新在后，上限 200） |
| `GET http://127.0.0.1:7780/state?since=&timeout=` | 拉 | 同上 | 统一发布状态 `{counter, workStatus, events}`，长轮询语义对齐 dsh-pet `/state`（since/timeout 成对必填，timeout ≤ 10s） |
| `POST http://127.0.0.1:7779/bubble` | 推 | `X-DSH-Pet-Token`（v0.2.0 契约不变） | 手机桌宠 5 类 kind：user/pre/post/stop |

webhook 信封（`version: 1`）：

```json
{
  "version": 1,
  "source": "dsh-pet-bridge",
  "kind": "work-status",
  "workStatus": { "state": "working", "task": "写代码", "ts": 1760000000000 },
  "sentAt": 1760000000000
}
```

`kind="event"` 时为 `{ "version": 1, "source": "dsh-pet-bridge", "kind": "event", "sessionId": "...", "event": { "type": "tool/call", "data": {...}, "seq": 3 }, "sentAt": ... }`。

## Token 鉴权（fail-closed）

- 回环服务：除 `/ping` 外，缺失/不匹配一律 **403**（恒时比较，不区分缺失与错误）。
- token 解析顺序：`config.token` > 环境变量 `DSH_PET_BRIDGE_TOKEN` > **进程内随机生成**（不落盘，启动时经 `logger.info` 打一次——消费端从引擎日志取）。
- webhook：每请求带 `X-DSH-Bridge-Token`（默认头，`target.header` 可改），token 取 `target.token ?? 全局 token`。
- `/bubble`：沿用 v0.2.0——`auth: "off"` 可刻意不带 token（模拟上游 0.1.0 验证 App 侧 403 fail-closed）。

## 配置（cordis config）

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto`=直连 dsh-pet，失败回退本地归约、恢复切回；`listen`=仅直连；`replay`=仅本地归约。环境变量 `DSH_PET_BRIDGE_MODE` 可覆盖 |
| `petBaseUrl` | `http://127.0.0.1:3080` | dsh-pet 路由 origin（与桌面 Helper 同源）。环境变量 `DSH_PET_BRIDGE_PET_URL` 可覆盖 |
| `serverEnabled` | `true` | 回环拉取服务开关 |
| `serverPort` | `7780` | 回环拉取服务端口（仅绑定 127.0.0.1） |
| `token` | 见上 | 回环服务 + webhook 默认 token |
| `targets` | `[]` | webhook 目标数组：`{url, header?, token?, events?, timeoutMs?}` |
| `port` | `7779` | v0.2.0：手机桌宠 `/bubble` 端口（仅回环生效） |
| `pollInterval` | `250` | v0.2.0：事件轮询间隔（ms），必须 >0 |
| `enabled` | `true` | `false` 时装载但零推送 |
| `auth` | `auto` | v0.2.0：`off`=刻意不带 `/bubble` token |
| `selfPublishRandomLines` | `true` | v0.3.5：无任务详情时是否由桥端自发布随机台词（dsh-pet `workStatusTexts` 原文）。关闭后 text 只带真实任务详情，措辞交给手机桌宠台词库。对应 dsh 设置界面的开关 |

## 验证

```sh
npm test        # 单测（node:test，27 项）
npm run smoke   # E2E 冒烟：伪 dsh-pet + 伪 ctx 全链路（listen/replay/事件/bubble/webhook）
```

验证 APK（假数据框架，v0.2.0 既有）：

```sh
adb forward tcp:17779 tcp:7779
node tools/verify-apk.mjs --token <DSH_PET_BRIDGE_TOKEN> --port 17779
```

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add @xiaopb/dsh-pet-bridge

# 或本地路径安装
dsh plugin --profile web add /path/to/dsh-pet-bridge
# 之后重启引擎（bundle 插件不热加载）
```

前置：dsh-pet 已安装并启用（replay 模式可不装，但直连是首选数据源）；webhook/拉取的消费端拿引擎日志里的 token。

## CI/CD

`.github/workflows/release.yml`（结构参考 dsh-hardssh）：push/PR/手动跑 verify（元数据校验 → 单测 → E2E 冒烟 → `npm pack` → tarball 形状校验）；`v*` tag 额外触发 npm 发布（trusted publishing OIDC 优先、`NPM_TOKEN` 兜底，pre-release 自动走 `next` dist-tag）与 GitHub Release（分类 changelog + tarball + SHA256SUMS）。`compat.yml`：Node 22.12 / 24 矩阵 × 单测 / 冒烟 / 打包三验证面。

## 许可

MIT。源自上游 dsh-pet-bridge（MIT）；工作状态聚合语义移植自 dsh-pet（MIT）。
