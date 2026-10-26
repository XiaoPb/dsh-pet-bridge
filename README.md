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
| < v1.4.21（协议 v1） | 0.1.x（上游） | 无 token |

0.3.1 同时修了上游 0.1.0 的真 bug：`push()` 未设 `Content-Length`（Node 走 chunked 编码），而 APK 只按定长读 body，**必然回 400** —— 这是「插件已连接但桌宠没有事件」的隐性根因。App 侧从 v1.4.21 起按版本硬门禁，低于 0.3.1 会提示「需 0.3.1+」并禁止开启桌宠。

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
