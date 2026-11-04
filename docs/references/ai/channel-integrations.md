---
description: 当前已接入的消息频道适配器与钉钉频道接入技术方案
sources:
  - src/main/ai/channels
  - src/shared/data/api/schemas/agentChannels.ts
  - src/renderer/pages/settings/ChannelsSettings
---

# 消息频道接入

本文盘点代码中已有的频道平台，并记录钉钉频道的技术设计与当前实现边界。现有平台清单来自代码检查；钉钉已完成 Stream 入站、被动回复及主动消息投递的核心实现，真实企业租户联调仍需单独验收。

## 当前已接入频道

当前频道注册表包含六个平台：Telegram、飞书、QQ、微信、Discord 和 Slack。频道运行时统一处理生命周期协调、消息分发、会话绑定、命令、频道状态及 Agent 流式输出转发。各平台 Adapter 负责具体传输、鉴权、消息标准化和发送行为。

| 平台 | 入站传输 | 出站与流式能力 | 说明 |
|---|---|---|---|
| Telegram | grammY Bot 长轮询 | 文本、文件、增量文本更新 | 使用 Bot Token；轮询异常支持退避重连。 |
| 飞书 | SDK 管理的 WebSocket | 文本、文件、话题回复、流式更新 | 使用 App ID/Secret；支持飞书/Lark 域名选择。 |
| QQ | Bot WebSocket Gateway | 文本及被动回复 | 使用 App ID/Client Secret；支持仅响应 @ 的策略；当前 Adapter 未实现文件发送。 |
| 微信 | 登录后长轮询 | 文本和文件 | 凭据由微信协议/登录流程管理，不采用普通应用凭据配置。 |
| Discord | Gateway WebSocket | 文本和流式更新 | 使用 Bot Token；支持频道白名单。 |
| Slack | Socket Mode WebSocket | 文本和流式更新 | 使用 Bot Token 与 App Token；支持频道白名单。 |

### 共享实现边界

- `src/shared/data/api/schemas/agentChannels.ts`：平台配置 Schema、频道实体及创建/更新联合类型。
- `src/main/data/services/AgentChannelService.ts`：配置校验，并在启用频道时校验必填凭据。
- `src/main/ai/channels/ChannelAdapter.ts`：标准化消息事件、生命周期钩子、出站发送和流式回调契约。
- `src/main/ai/channels/ChannelRuntime.ts`、`ChannelManager.ts`：Adapter 实例与 Agent 生命周期协调。
- `src/main/ai/channels/ChannelMessageHandler.ts`：命令处理、会话映射、权限和 Agent 执行。
- `src/main/ai/streamManager/listeners/ChannelAdapterListener.ts`：将 Agent 流式更新、完成结果及错误转发给 Adapter。
- `src/main/ai/channels/channelAdapterLoader.ts`：按平台类型动态创建 Adapter。
- `src/renderer/pages/settings/ChannelsSettings`：平台选择、配置表单、启用状态和管理界面。

`agent_channel` 表使用通用的类型与 JSON 配置，并已有会话/活跃聊天关系。新增平台通常不需要数据库迁移；只有平台引入无法从现有配置或会话关系推导、且必须持久化的新状态时，才考虑新增存储结构。

## 钉钉接入目标与范围

首期目标是支持钉钉企业内部应用机器人：接收群聊或单聊消息并返回 Agent 回复。接入应复用频道运行时，把钉钉协议细节封装在独立 Adapter 内。

首期范围：

- 企业内部应用机器人，使用 Stream 模式。
- 文本及平台确认支持的 Markdown 内容。
- 群聊 @ 机器人触发、会话白名单和机器人自身消息过滤。
- 按钉钉会话 ID 隔离会话。
- 在有效期内使用入站消息携带的会话 Webhook 回复。
- 连接重试、事件 ACK、消息去重和生命周期清理。
- 通过 `ChannelMessageHandler` 复用通用频道命令、权限和会话行为。

首期不包含：

- 钉钉 HTTP 回调服务或公网回调托管。
- 以自定义机器人 Webhook 作为入站通道。
- 图片/文件上传、互动卡片。主动通知已支持文本消息，但仍受目标会话类型和钉钉机器人权限约束。
- 在未确认具体 API 与权限范围前，为过期会话 Webhook 实现 AccessToken 回退。

## 建议架构

```text
钉钉企业应用机器人
        │ Stream WebSocket
        ▼
DingTalkAdapter
  ├─ 订阅 /v1.0/im/bot/messages/get
  ├─ 校验事件并应用白名单 / @ 策略
  ├─ 去重并确认事件
  ├─ 转换为 ChannelMessageEvent
  ├─ 在内存中保存短期 sessionWebhook
  └─ 负责回复及连接生命周期
        │
        ▼
ChannelRuntime → ChannelManager → ChannelMessageHandler
        │
        ▼
Agent 流 → ChannelAdapterListener → DingTalkAdapter
```

优先选择钉钉 Stream 模式：连接由客户端主动建立，不需要向公网暴露 HTTP 回调地址。建议优先评估钉钉官方 Node.js SDK，由 SDK 负责 Stream Ticket、连接协议和事件 ACK 等协议细节；Cherry Studio 仍负责 Adapter 生命周期、日志、资源清理、统一事件转换和输出策略。

## 配置契约

建议配置结构：

```ts
type DingTalkAgentChannelConfig = {
  client_id: string
  client_secret: string
  allowed_chat_ids?: string[]
  require_mention?: boolean
}
```

- `client_id`：企业应用 Client ID，旧称 AppKey。
- `client_secret`：企业应用 Client Secret，旧称 AppSecret；启用频道时必填。
- `allowed_chat_ids`：可选会话白名单。为空时的行为应遵循现有频道自动追踪约定，并在界面中明确说明。
- `require_mention`：群聊是否必须 @ 机器人后才处理。为群聊安全，建议默认 `true`；单聊不受 @ 条件限制。

不要将每条消息的 `sessionWebhook` 写入频道配置或数据库。应在内存 TTL Map 中按频道/会话/消息身份保存，过期或断开时清理，并禁止写入日志和诊断信息。

## 绑定方式与连接检测

### 官方能力边界

钉钉官方 Stream 机器人接入流程要求企业在开发者后台先创建应用、获取 `Client ID` / `Client Secret`，再为应用配置并发布机器人能力，接收模式选择 Stream。官方“扫码登录第三方网站”流程的目标是取得已登录用户授权信息，不会创建机器人应用，也不能替代应用凭据。故本产品不能仅凭普通钉钉扫码推导或获取 Stream 所需应用密钥。

产品要求的“默认扫码一键绑定”仅可通过钉钉官方支持、适用于桌面客户端且能安全授权既有企业应用的 OAuth/授权机制实现；不得将网页登录二维码或自建二维码包装成凭据授权。如果该机制未获官方文档及真实租户验证，扫码入口必须标记为“暂不可用/需管理员启用”，首期可用路径为手动配置。扫码不创建应用、不配置机器人能力，也不代替管理员完成应用发布和权限审批。

### 用户流程

```text
添加钉钉频道
  ├─ 官方桌面授权能力已验证：默认显示“扫码绑定”
  │    ├─ 展示短时效、一次性授权码二维码 → 用户在钉钉确认企业/应用授权
  │    ├─ 授权回调校验 state、过期时间与目标企业 → 安全保存凭据
  │    └─ 进入独立的“检测连接”步骤
  └─ 官方授权能力未验证/不可用：显示手动配置入口及原因
       └─ 管理员填写 Client ID / Client Secret → 检测连接

检测通过 → 保存并启用频道 → 展示在线状态
检测失败 → 保留输入但不启用 → 展示失败阶段、可操作原因与重试
```

扫码页必须提供二维码过期倒计时、重新生成、取消、授权中的等待态、授权成功/拒绝/超时/网络失败状态，以及“改用手动配置”入口。二维码只承载短时效、一次性、不含密钥的授权事务标识；回调须校验随机 `state`、事务绑定、有效期和一次性消费，防 CSRF、重放及跨企业串绑。不得把二维码内容、授权码、Client Secret 或访问令牌写入日志。授权完成仅表示凭据授权成功，不能显示“频道已连接”。

### 连接检测契约

设置页提供显式“检测连接”操作，检测不应隐式启用频道或发送群聊消息。检测分为以下阶段，并返回结构化结果：

| 阶段 | 检查内容 | 成功状态 | 失败提示方向 |
|---|---|---|---|
| 凭据校验 | Client ID/Secret 可用，必要凭据可取得 | 凭据有效 | 检查凭据、应用状态及授权 |
| 机器人配置 | 企业应用已配置并发布机器人能力，接收模式为 Stream | 机器人已发布 | 到开发者后台添加/发布机器人并选择 Stream |
| Stream 建连 | SDK 建立长连接并完成订阅确认 | Stream 已连接 | 检查网络代理、防火墙、SDK错误与应用配置 |
| 事件订阅就绪 | 目标消息主题订阅已确认；若协议不能确认则标为“未验证”，不得伪报成功 | 接收就绪/未验证 | 检查消息订阅主题和机器人发布状态 |

建议抽象为 `testConnection(config, signal): Promise<ConnectionTestResult>`，结果至少包含 `status`、`checkedAt`、分阶段 `checks[]`（`id/status/message/retryable`），敏感内容不得包含在结果或错误文本中。调用可取消并设置总超时；检测过程创建临时 Stream 客户端，结束后关闭并释放资源。若 SDK 不支持无副作用的临时连接检测，则改为启动频道后观察真实连接状态，并明确提示“检测会启动连接”，不得发送测试消息到用户会话。

当前实现（`channel.dingtalk.test_connection`）已按此契约落地两阶段检测：输入为 `client_id`、`client_secret`（`robot_code` 可选，检测不依赖它）；先调用 `/v1.0/oauth2/accessToken` 验证凭据可换取 Access Token（不发送任何消息），再建立临时 Stream 连接并断开。失败返回稳定枚举：`credentials_invalid`、`timeout`、`connection_failed`。该检测验证凭据与建连，不等于机器人主动发送权限的完整验证；后者仍需真实租户联调确认。

状态模型需区分 `unbound`、`authorizing`、`authorized`、`testing`、`connected`、`degraded`、`disconnected`、`error`。持久化状态仅保存必要的非敏感状态和最近检测时间；Secret 继续通过应用现有安全配置存储机制处理。连接掉线应从 `connected` 转为 `degraded/disconnected`，重连恢复后更新状态；UI 展示最近一次检测时间及具体失败阶段。

### 交互与验收

- 默认选中扫码模式仅限官方授权机制经验证可用；否则呈现明确不可用说明及手动配置 CTA，不展示假二维码。
- 手动配置支持 Secret 掩码、显示/隐藏、保存后仍掩码；编辑已有 Secret 时留空表示保持原值，明确提供替换/清除动作。
- “检测连接”在必填项完整后可用，显示逐阶段进度；重复触发时禁用按钮，取消后清理临时客户端。
- 凭据或机器人配置失败时不启动常驻 Adapter、不启用频道；网络可恢复错误提供重试，权限/配置错误指出后台操作方向。
- 检测通过后由用户确认保存并启用；连接状态与授权状态分开显示。运行中掉线提供“重试连接”，不要求重新扫码或重新输入凭据。
- 自动化测试覆盖二维码过期/重放/state 不匹配、授权拒绝、手动路径、检测各阶段成功与失败、超时/取消/资源清理、Secret 不泄漏及运行时掉线恢复。
- 真实租户验收必须分别证明：授权绑定（若官方能力可用）、Stream 实际建连、机器人消息可达；任何一项未验证均不得显示整体“连接成功”。

## 入站消息契约

订阅官方机器人回调主题：

```text
/v1.0/im/bot/messages/get
```

将钉钉事件转换为现有 `ChannelMessageEvent`：

| 钉钉数据 | 频道事件字段 |
|---|---|
| `conversationId` | `chatId` 与 `conversationId` |
| 入站消息 ID（`msgId` 或 SDK 标准化字段） | `messageId` |
| `senderStaffId` 或 `senderId` | `userId` |
| `senderNick` | `userName` |
| 文本内容 | `text` |
| 是否 @ 机器人的标识 | Adapter 策略校验 |
| `sessionWebhook` 及其过期时间 | 私有回复上下文，不传给通用消息处理器 |

确切字段名和事件封装必须在选定 SDK 版本及真实钉钉测试企业中确认后才能实现。过滤机器人自身消息、不支持的事件、空内容、不在白名单的会话，以及 `require_mention` 开启时未 @ 机器人的群消息。

### ACK、去重与背压

- 成功、可重试失败和过载场景使用 SDK 明确支持的 ACK 结果；SDK 已提供 ACK 封装时不自行实现底层协议。
- 以钉钉消息 ID 建立有容量上限和 TTL 的内存去重缓存。重复消息应确认 ACK，但不可再次触发 Agent。
- 限制并发事件处理数量。如果 SDK 支持过载时延迟 ACK/稍后重试，则采用该机制；否则仅在消息已安全进入有界队列后确认。
- 在 SDK 提供连接/事件取消信号时，将信号传递给支持取消的工作。
- 除非钉钉 ACK 契约明确要求，否则不要让 Stream 事件回调等待完整的 Agent 推理。回调应先安全接纳消息并返回适当 ACK，再由共享频道处理链异步执行。

## 出站消息与流式策略

### 首期回复路径

在入站消息的 `sessionWebhook` 有效时，优先用它回复。该路径简单，不需要额外换取 AccessToken；Webhook 只对应具体消息且有有效期，不是永久的会话地址。

对异步 Agent 任务，不能依赖入站消息的临时 Webhook：自动化任务通常没有 `replyToMessageId`，必须走主动发送模式。当前实现使用企业机器人 OpenAPI：通过 Client ID/Client Secret 获取并缓存 AccessToken，群聊调用 `/v1.0/robot/groupMessages/send`，需要 `robotCode` 和目标 `openConversationId`；单聊调用 `/v1.0/robot/oToMessages/batchSend`，使用入站 `senderStaffId` 作为 `userIds`。入站会话类型仅在适配器内存中维护；主动发送要求目标会话已收到过消息、或目标明确列在 `allowed_chat_ids` 中（此时按群聊兼容处理），完全未知的目标会直接报错而不是猜测接口。

`robotCode` 无需用户必填配置：按钉钉官方规则，企业内部机器人应用的 AppKey 即为 robotCode，因此 Adapter 默认使用 `client_id` 充当 `robotCode`；仅当使用新版应用内机器人且其展示了独立 robotCode 时，才需要通过可选的 `robot_code` 配置覆盖。若主动发送返回 `robotCode.notExsit` 类错误，应先确认应用是否为应用内机器人并检查其独立 robotCode。

### 流式输出

MVP 建议只发送最终回复；仅当平台交互明确允许时，才额外发送一条“处理中”提示。不要按 token 逐次调用消息 API。后续可评估钉钉文档中的预发送/更新/结束流程，但需先确认其适用于目标机器人类型和回复场景。流式更新必须按会话节流并串行执行，结束时完成最终刷新，并保留普通消息回退。

基类 Adapter 的 `onTextUpdate` 默认不执行操作，`onStreamComplete` 默认返回 `false`；因此可在不修改共享 Listener 的情况下实现首期“只发送最终消息”。

### 内容和长度

首期先实现文本。Markdown 转换及长文本切分必须遵循钉钉实际接口限制，并避免拆断 Unicode 代理对和代码围栏。确认入站回调是否支持图片/文件，以及现有附件工具是否可用于下载后，才能承诺附件支持。

## 可靠性与安全

- 使用有上限的指数退避进行重连；连接稳定一段时间后重置重试计数。
- 断开时停止 SDK 客户端、取消待处理工作、清理定时器/流控制器/去重及回复缓存，并更新 Adapter 连接状态。
- OpenAPI 主动投递缓存应用 AccessToken；在过期前刷新，并串行化并发刷新请求。
- 禁止记录 Client Secret、AccessToken、sessionWebhook、签名或包含凭据的完整 URL。
- 在 Adapter 边界用 `allowed_chat_ids` 和 @ 策略过滤消息，同时保留 `ChannelMessageHandler` 的共享权限模式校验。
- 对消息长度、事件并发、队列大小和 API 请求速率设上限。遇到平台限流时退避；同一会话的流式更新不得并行发送。
- 引入官方 SDK 前，检查许可证、维护情况、依赖树、Electron/Node 兼容性及构建产物中的 ESM/CJS 行为。升级依赖前检查 `patches/`。

## 代码改动范围

| 模块 | 建议改动 |
|---|---|
| 共享契约 | 新增 `dingtalk` 配置 Schema、启用态凭据校验、实体/创建/更新联合类型，以及 `ChannelConfigSchema`、`CHANNEL_TYPES`。 |
| 主进程 Adapter | 新增 `src/main/ai/channels/adapters/dingtalk/DingTalkAdapter.ts` 及协议/Adapter 定向测试。 |
| Loader | 在 `src/main/ai/channels/channelAdapterLoader.ts` 增加 `dingtalk` 分支。 |
| 设置界面 | 在 `ChannelsSettings/channelTypes.ts` 注册钉钉，在 `ChannelForms.tsx` 增加表单及本地化文案。 |
| 详情摘要 | 若 `ChannelDetail.tsx` 的默认展示无法正确显示新平台，再补钉钉名称/摘要分支。 |
| 持久化 | 预计不需要迁移；通用频道配置和现有活跃会话关系应足够。 |
| MCP 频道创建 | 只有产品范围要求通过 MCP 创建钉钉频道时，才扩展内置 `add_channel` 工具。 |
| 通知投递 | 只有主动投递纳入验收范围时，才扩展通知接收方路由。 |

## 测试与验收计划

### 自动化测试

- 配置 Schema 接受有效配置，并拒绝缺少 `client_id` 或 `client_secret` 的启用态配置。
- Loader 收到 `dingtalk` 频道实体时创建钉钉 Adapter。
- 事件封装正确映射会话、消息、发送者、文本、@ 状态和回复上下文。
- 白名单外会话、机器人自身消息、不支持的事件及未 @ 的群消息不会进入通用处理器。
- 相同消息 ID 不会重复调用处理器，并能安全 ACK。
- 成功、可恢复失败和过载时返回正确 ACK。
- `sendMessage` 对入站回复使用未过期的 sessionWebhook；对无回复上下文的自动化通知使用 OpenAPI 主动发送，且不在日志中泄露凭据。
- 断开时关闭 SDK 客户端并清理定时器/缓存；重连后状态恢复。
- 长文本切分不拆断代理对或代码围栏。
- 设置表单可创建和更新配置，并正确掩码 Secret。

### 端到端验收

1. 在真实企业中完成应用与 Stream 机器人配置；若官方桌面扫码授权能力已核实，验证扫码授权成功、拒绝、超时、重放拦截和取消；否则验证 UI 不展示可误导的二维码，并可进入手动配置。
2. 通过手动凭据或已验证的官方授权路径绑定频道，逐阶段检测凭据、机器人配置、Stream 建连和事件订阅状态；确认连接检测不会向用户会话发送测试消息。
3. 检测失败时频道不得启用，错误能区分权限/配置问题与可重试网络故障；检测成功后由用户确认启用。
4. 分别发送单聊消息和白名单群聊中的 @ 消息；两者都只产生一次 Agent 执行并收到一条最终回复。
5. 发送白名单外群消息和未 @ 机器人的群消息；两者均不启动 Agent。
6. 验证两个会话绑定到不同的会话上下文。
7. 断网并恢复，确认频道状态从掉线恢复且没有重复回复。
8. 验证 `new`、`compact`、`help`、`whoami` 通用命令。
9. 检查日志，确认凭据、AccessToken、授权码和 sessionWebhook 未泄露。

## 分阶段交付

| 阶段 | 交付内容 | 退出标准 |
|---|---|---|
| P0 | 配置 Schema、手动配置兜底、绑定状态模型、分阶段连接检测、Stream 连接、文本收发、白名单、@ 策略、ACK/去重和重连 | 真实测试企业中，检测阶段结果准确；单聊和 @ 群聊可完成对话，且会话隔离正确。 |
| P0（条件项） | 默认扫码授权绑定 | 仅在钉钉官方桌面授权机制、适用范围、凭据授予方式及安全回调均经文档和真实租户验证后启用；未验证则不展示可操作二维码，手动配置保持可用。 |
| P1 | OpenAPI 主动通知、Token 缓存、节流流式输出、Markdown/长文本处理 | 自动化任务可在无入站回复上下文时投递到配置会话；权限、Token 过期和较长响应均有明确且测试覆盖的送达行为。 |
| P2 | 图片/文件/卡片、单聊主动通知 | 每项能力均确认钉钉权限并通过端到端测试，界面不暗示未实现能力。 |

## 实施前待确认事项

1. 首期是否仅支持企业内部应用，第三方企业应用暂不纳入。
2. 钉钉是否提供适用于 Cherry Studio 桌面端、能安全授权既有企业机器人应用凭据的官方 OAuth/授权机制；需核实官方文档、授权范围、回调形态、凭据交付规则和真实租户流程。未验证前扫码绑定不进入可用 P0，手动配置作为唯一可用路径。
3. 是否将群聊默认设置为必须 @，以及白名单为空时的实际行为。
4. 在真实企业应用中验证 sessionWebhook 有效期；结合 Agent 响应耗时决定 P0 对过期场景报错，还是必须实现 OpenAPI 回退。
5. 按仓库 Electron 打包、模块系统、许可证与安全要求评估官方 Node.js SDK，并确认 SDK 是否支持无副作用的连接检测。
6. 确认目标机器人类型是否支持回复场景下的流式预发送/更新/结束；否则 P0 固定为最终消息发送。

## 资料来源

### 本地实现

- `src/shared/data/api/schemas/agentChannels.ts`
- `src/shared/data/types/channel.ts`
- `src/main/data/services/AgentChannelService.ts`
- `src/main/ai/channels/ChannelAdapter.ts`
- `src/main/ai/channels/ChannelRuntime.ts`
- `src/main/ai/channels/ChannelManager.ts`
- `src/main/ai/channels/ChannelMessageHandler.ts`
- `src/main/ai/channels/channelAdapterLoader.ts`
- `src/main/ai/streamManager/listeners/ChannelAdapterListener.ts`
- `src/renderer/pages/settings/ChannelsSettings`
- `src/main/ai/channels/adapters`

### 钉钉官方资料

- Stream 模式协议接入说明：https://open.dingtalk.com/document/direction/stream-mode-protocol-access-description
- 企业内部应用网页登录/扫码登录教程（用于用户身份授权，不等同于机器人凭据授权）：http://open.dingtalk.com/document/isvapp/tutorial-enabling-login-to-third-party-websites
- 开发 Stream 推送服务：https://open.dingtalk.com/document/development/develop-stream-mode-push-server
- 配置 Stream 推送：https://open.dingtalk.com/document/development/stream
- 机器人接收消息：https://open.dingtalk.com/document/dingstart/robot-receive-message
- 机器人回复/发送消息：https://open.dingtalk.com/document/orgapp/robot-reply-and-send-messages
- 智能交互概述：https://open.dingtalk.com/document/orgapp/intelligent-interaction-overview
- 钉钉官方 Node.js Stream SDK：https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs

官方平台资料访问日期：2026-10-19。具体 API 字段、SDK 版本行为、权限范围、消息长度和限流值，均需在实施时根据选定机器人类型及 SDK 版本重新核实。
