---
description: 登录后自动绑定 Cowork 模型服务商的接口契约、客户端实现与后端联调条件
sources:
  - src/main/enterprise/JavaAuthClient.ts
  - src/main/enterprise/EnterprisePlugin.ts
  - src/main/enterprise/JavaModelConfigClient.ts
  - src/main/enterprise/CoworkModelConfigSync.ts
  - src/main/enterprise/OrgAuthManager.ts
  - src/main/data/services/ProviderService.ts
  - src/main/data/services/ModelService.ts
  - src/shared/data/types/provider.ts
  - src/shared/data/types/model.ts
---

# 登录后自动绑定模型服务商：接口契约

状态：**客户端、Java及sub2api后端、管理网页开关代码已实现，尚未部署；桌面完整链路待验收**。2026-11-20新增Java开关、配置接口和下游只读动作，2026-11-23管理网页已在API Keys创建及编辑弹窗中接入“自动绑定到 Cowork”，新建默认关闭，列表显示开关状态。Java与sub2api已通过隔离临时环境的真实HTTP联调，管理网页已通过受控桌面及手机浏览器验证；完整回归结果以后端验证记录为准，不代表已上线。后端精确契约维护在同级cowork-server的docs/client-model-config.md。

目标：用户在 Cowork 后台为可用 Key 开启“自动绑定到 Cowork”后，登录桌面客户端即可获得对应服务商与可用模型，无需手动复制地址、填写 Key 或添加服务商。其他用途的 Key 不自动下发。

## 当前代码与复用边界

- 客户端登录使用 `POST /api/v1/auth/login`，随后通过 `GET /api/v1/auth/me` 确认用户及当前企业；认证响应只处理身份与授权，模型配置通过独立接口同步。
- 服务商和模型分别由 `ProviderService`、`ModelService` 管理，可复用其创建、更新与密钥管理能力。
- 同级 Java 后端已有个人门户能力：`GET /api/v1/model/key/usageOptions` 获取公开模型根地址，`GET /api/v1/model/key/page` 查询本人当前企业的脱敏 Key，`POST /api/v1/model/key/reveal` 受控读取明文。它们可供后端复用，但不是已经约定的客户端自动配置接口。
- `usageOptions.defaultModel` 是使用指引推荐值，不保证该 Key 有权调用，不能用它代替实际可用模型列表。

## 后端 Key 自动绑定开关

后端模型 Key 记录已增加布尔字段 `coworkAutoBindEnabled`（数据库列名 `cowork_auto_bind_enabled`），管理页面展示为“自动绑定到 Cowork”。Java字段、持久化、创建编辑及查询已实现，管理页面控件尚未接入。

| 属性 | 约定 |
| --- | --- |
| 开启：`true` | 允许此 Key 参与 `/api/v1/client/model/config` 的返回筛选，仍须满足本人、当前企业、实时授权及 Key 有效性要求 |
| 关闭：`false` | 此接口不返回该 Key 及其明文；Key 原有状态、权限、额度和其他系统中的调用用途保持不变 |
| 新建默认值 | `false`；通用 Key 创建入口需由用户明确开启，创建请求省略字段时按关闭处理 |
| 历史数据 | 新增非空列，默认 `false`；历史记录不自动开启，兼容读取中的缺失或 `null` 均视为关闭 |
| 编辑语义 | 省略字段保留原值；显式 `false` 必须能关闭；显式 `null` 或非布尔值应被拒绝 |
| 管理端展示 | Key 新建、编辑、列表及详情使用同一字段，支持查看和修改；管理响应仍只展示脱敏 Key |

该开关独立于 Key 的启用/停用状态，不作为模型调用鉴权条件。关闭开关不会删除、停用或轮换后端 Key，也不会撤销它在其他应用中的授权；开启开关不能绕过现有账号、企业、分组或 Key 管理权限。修改开关应复用现有 Key 所有权与企业权限校验。

后端先按 `coworkAutoBindEnabled=true` 和当前身份权限筛选，再为入选项组装明文配置；禁止先把全部 Key 下发给客户端再由客户端过滤。未入选 Key 不读取明文，也不进入此接口的响应或日志。开关无需重复放入模型配置响应，响应中的每一项已经代表允许自动绑定的配置。

开关切换沿用现有完整快照语义：

- `false → true`：下一次登录成功同步时创建或恢复对应自动服务商。
- `true → false`：下一次登录成功同步的列表不再包含该 Key，客户端停用对应自动服务商、凭据及模型，保留历史对话引用；不影响用户手动配置的服务商。
- 重新开启同一个 Key 保持配置 ID 不变，客户端只恢复原绑定的停用状态，不覆盖模型能力等本地配置；无需重新生成 Key。
- 客户端手动删除自动服务商后，只要后端开关仍开启且 Key 有效，下次登录成功同步仍会重建，并导入最新配置，不增加本地忽略列表。

这些变更在下一次登录成功同步时生效，当前没有实时推送或周期模型同步。账号在线校验与技能、连接器的授权监控仍独立运行。所有 Key 均未开启或均不满足返回条件时，成功返回 `providers=[]`；筛选或读取失败仍须返回失败，不能伪装成空列表。

## 最小后端接口

Java已新增 `GET /api/v1/client/model/config`，只读取已经创建的 Key，不在读取时开户或创建 Key。

请求沿用原始 `token` 头，不加 `Bearer`；不传 `userId`、`tenantId`、`groupId`、`scope` 等身份或授权参数。后端从会话及实时授权确定当前用户、企业与分组。

接口返回当前用户在当前企业下**全部已开启 `coworkAutoBindEnabled` 且可自动绑定的有效配置**。完整快照指所有符合筛选条件的配置，不要求包含该用户的其他用途 Key。一个 Key 对应一条配置；客户端将它们归入同一个内置服务商，但仅在同时授权了同一模型、支持本次协议且已在本机启用的 Key 之间轮询。

示例中的地址、ID、模型和 Key 均为占位值：

```json
{
  "code": 200,
  "msg": "成功",
  "requestId": "model-config-example",
  "data": {
    "serverInstanceId": "11111111-1111-4111-8111-111111111111",
    "userId": "7",
    "tenantId": "9",
    "providers": [
      {
        "id": "42",
        "name": "Cowork 企业模型",
        "apiKey": "sk-example-placeholder",
        "defaultChatEndpoint": "openai-responses",
        "endpointConfigs": {
          "openai-responses": {
            "baseUrl": "https://models.example.com/v1"
          }
        },
        "models": [
          {
            "id": "enterprise-chat-model",
            "name": "企业对话模型",
            "endpointTypes": ["openai-responses"]
          }
        ]
      }
    ]
  }
}
```

### 必需字段与语义

| 字段 | 类型 | 约定 |
| --- | --- | --- |
| `data.serverInstanceId` | string | 与本次登录身份中的服务实例一致 |
| `data.userId` | string | 当前登录用户的稳定 ID |
| `data.tenantId` | string | 当前会话企业 ID，不接受客户端指定 |
| `data.providers` | array | 本次身份下已开启自动绑定的完整有效配置列表；成功的空数组才表示确实没有可绑定配置 |
| `providers[].id` | string | 稳定绑定 ID，可使用后端 Key ID；不能使用显示名称或列表下标 |
| `providers[].name` | string | 服务商显示名称；多 Key 时建议带上 Key 名称，如“Cowork · 开发”“Cowork · 生产”，便于用户区分 |
| `providers[].apiKey` | string | 该用户有权使用的完整客户端 Key，不能是脱敏值、哈希或上游厂商管理密钥 |
| `providers[].defaultChatEndpoint` | string | 此配置实际可用的默认文本协议，必须存在于 `endpointConfigs` 中 |
| `providers[].endpointConfigs` | object | 实际支持的协议及其完整 API 基地址，至少包含一个文本协议；当前Java按平台返回一个协议 |
| `providers[].models` | array | 此 Key 当时有权调用的模型；没有可用模型时为空数组，不填入未经授权的推荐模型 |
| `models[].id` | string | 发往模型 API 的实际模型 ID，不是展示名 |
| `models[].name` | string，可选 | 模型展示名，缺省时使用 ID |
| `models[].endpointTypes` | string[] | 该模型支持的协议子集，每个值必须存在于所属服务商的 `endpointConfigs` 中 |

所有业务 ID 使用非空字符串返回（客户端拒绝数字 ID），避免 Java Long 在 JavaScript 中丢失精度。同一快照中的服务商 ID 不重复，同一服务商的模型 ID 不重复；每个模型至少声明一个协议，不允许重复协议。对同一个绑定轮换 Key 明文或调整地址时保持绑定 ID；删除后重新创建的独立 Key 使用新 ID。

### 协议与地址

协议值复用客户端的 `EndpointType`：

| 协议 | `baseUrl` 示例 | 模型调用路径 |
| --- | --- | --- |
| `openai-chat-completions` | `https://models.example.com/v1` | 基地址后接 `/chat/completions` |
| `openai-responses` | `https://models.example.com/v1` | 基地址后接 `/responses` |
| `anthropic-messages` | `https://models.example.com/v1` | 基地址后接 `/messages` |
| `google-generate-content` | `https://models.example.com/v1beta` | 基地址后接 `/models/{modelId}:generateContent` 或流式路径 |

同一 Key 支持多个协议时可在同一绑定内返回多个 endpointConfigs，但不能仅根据模型名字推断协议。地址由部署提供，必须是客户端可访问、无 URL 凭据、无查询参数及片段的 HTTP(S) 模型 API 基地址；不能将 Java 站点、后台内部连接地址或完整的 `/chat/completions` 等请求 URL 当作基地址。

如果后端不能直接返回授权模型列表，需要另行约定按 Key 查询模型的入口及格式；在该契约明确之前，客户端不写死默认模型，也不将“已经绑定服务商”当作“已具备可用模型”。

### 当前后端实现范围

Java以本地Key归属记录ID作为稳定配置ID，最多100个本地入选Key，每Key最多4000模型。平台openai/grok返回openai-responses，anthropic返回anthropic-messages，gemini返回google-generate-content；其他平台整体失败。公开地址来自sub2api的api_base_url，目录通过实际账号模型准入及组白名单筛选，通配符不作为模型ID返回。开启固定OpenAI manifest的组复用正式目录读取。新库使用最新init.sql/index.sql，基线旧库须先手工执行当前init_update.sql，再部署含key.clientConfig的sub2api及Java；历史开关不自动开启。

## 完整性、权限及失败语义

- 每次请求验证活跃账号、当前有效企业成员及实时模型分组授权，只返回已开启 `coworkAutoBindEnabled` 且当前身份本人可用、未停用、未过期、未撤权、额度允许使用的 Key；企业管理员不因此获得其他成员的 Key。
- 生成配置过程中发生身份、企业或授权变化时，本次快照失败；不能混合多个授权时点的数据。
- `code=200` 才表示完整快照成功。失败、部分读取失败、数据过大或下游不可用均返回业务失败，不能返回部分成功列表或伪装成 `providers=[]`。
- 沿用现有 Java 响应信封和业务码：`10008` 为会话失效、`10007` 为无权限、`500` 为服务异常；不能把普通无权限等同于全局账号失效。
- 成功响应带 `Cache-Control: no-store`。明文只进入服务商凭据管理链路，不写日志、审计正文、前端持久缓存或通用响应缓存。切回同一企业时的恢复快照仅由主进程使用系统凭据保护加密保存；如系统加密不可用，不额外留存快照，当前身份已落库配置的失败回退不受影响。
- 登录 token 只用于 Cowork 配置接口；模型请求只使用对应模型 Key，不向模型地址转发登录 token。
- 没有符合自动绑定条件的 Key 时返回成功空列表，不自动调用 Key 创建接口或替用户开启自动绑定。若后续需要“新账号自动发 Key”，另行设计有幂等保证的写接口。

## 客户端接入规则

当前客户端实现规则（尚未与真实后端联调）：

1. 每次登录或恢复登录，在 `/me` 首次验证通过、目标账号的数据环境激活后，仅在主进程尝试读取一次配置。周期在线校验、网络恢复的验证成功通知及授权变化通知不重复触发模型同步。模型配置失败不回滚已经成功的账号登录；记录不含凭据的失败日志，等下次登录再尝试。设置页显示同步状态，不提供手动重试入口；失败时仅允许继续使用当前身份上次成功的配置。
2. 校验响应中的服务实例、用户、企业与请求前的身份快照一致，并在网络返回后再次核对现有 epoch/lease；退出、换账号或企业授权变化后丢弃旧响应。
3. 快照写入内置「雪浪工匠」服务商（`XUELANG_PROVIDER_ID = 'xuelang'`），不再按 Key 创建 `cowork-auto-*` 独立服务商。雪浪工匠的 OAuth 授权登录已移除，该服务商的凭据与模型完全来自登录用户。每条 Key 的本地 id 由后端配置 ID 的 SHA-256 摘要生成，label 固定为 `Cowork`；服务端按当前身份下发完整列表，全量替换该服务商的 API Key 集合，切换企业后旧凭据不再可用；撤权后从该身份的当前配置和恢复快照移除旧凭据。
4. 快照保留每把 Key 的授权模型及各协议对应的地址。聊天优先用 OpenAI Chat Completions，无法匹配时尝试兼容协议；按模型与已选协议筛选启用且已授权的 Key 轮询，地址取自同一 Key。后台字段只读，Key 在设置中脱敏展示。
5. 设置页按真实模型 ID 合并去重。首次分配的 Key 和模型默认开启；按当前服务、用户和企业保留总开关及 Key、模型的本机启停，撤销后重新授权也沿用。没有可用 Key 的授权模型仍可在设置中查看，但不能在聊天中选择；撤权模型保留历史引用，不可调用，也不自动换模型。空快照时服务商入口保留。
6. 复用 `ProviderService` 与 `ModelService` 在同一 SQLite 连接的外层事务中保存配置、凭据与模型，任一写失败全部回滚；提交后通过现有数据变化通知（`/providers`、`/providers/:providerId`、api-keys、auth-config、`/models`、`/models/:uniqueModelId*`）刷新界面。
7. 明文 Key 只写入服务商凭据存储，不写日志、通知载荷或通用缓存。同步失败不能清空配置或把旧配置归属到新身份；账号在线授权校验仍独立拦截明确失效的会话。
8. 默认模型沿用用户已有选择；本同步只维护模型目录与启停，不改写用户的默认模型选择。

## 接口就绪后的验收

| 场景 | 必须证明的结果 |
| --- | --- |
| 首次登录，有一个已开启自动绑定的有效 Key | 雪浪工匠服务商自动写入地址、Key 与全部下发模型、处于启用状态；OAuth 登录入口不再出现 |
| 同时存在多个已开启自动绑定的有效 Key | 全部写入同一个雪浪工匠服务商的 Key 列表，由现有轮询机制选 Key；多个 Key 的模型按 ID 合并去重 |
| 新建时省略开关，或升级前已有 Key | 开关默认为关闭，配置接口不返回该 Key |
| 多个有效 Key 仅部分开启自动绑定 | 仅返回开启且授权有效的项，未开启项的明文不读取、不下发 |
| 编辑 Key 时省略开关，或显式传 `false` | 省略保留原值；显式 `false` 能关闭；非法类型不写入 |
| 已绑定 Key 关闭自动绑定 | 下次登录成功同步后从雪浪工匠 Key 列表移除；后端 Key 及在其他系统中的调用不受影响 |
| 同一个 Key 再次开启自动绑定 | 以相同本地 ID 重新写入并保留本机启停，不产生重复项 |
| 客户端操作托管配置 | 仅允许服务商、Key 及模型各自的本机开关；不能手动删除、添加或刷新 |
| 重复登录或重复同步 | 更新后台配置，不重复添加，不覆盖各级本机开关 |
| 登录后经过多个在线校验周期或网络恢复 | 模型配置不再次请求，账号校验及资源授权监控继续运行 |
| 用户手动添加了同名服务商 | 原服务商及其配置保持不变 |
| 相同配置 ID 出现在不同账号、企业或服务实例 | 写入同一个雪浪工匠服务商，但按完整快照覆盖，旧身份 Key 不再可用 |
| 配置请求尚未返回时退出或切换身份 | 旧结果不能写入新身份的数据环境 |
| 后端确认 Key 停用、过期、撤权、额度耗尽或删除 | 下次登录成功获取的完整快照不再包含该 Key，客户端将其移除；实际模型调用由服务端实时鉴权 |
| 后端无 Key，或所有 Key 均关闭自动绑定 | 成功空列表，雪浪工匠停用、Key 清空且全部模型停用，不发起 Key 创建、不自动开启开关 |
| Key 有效但模型列表为空 | 该服务商已有的全部模型停用，不自动填入推荐值或默认模型 |
| 服务端移除某个模型或某次快照不再返回 | 对应模型行保留但停用，历史对话引用不丢失；再次授权时恢复该身份的本机启停状态 |
| 配置接口超时、业务失败、部分读取失败或字段非法 | 不伪装为成功空列表，不清空既有配置，记录不含凭据的失败日志并等下次登录再尝试 |
| 协议不同或同 Key 多协议 | 按声明的 endpoint 和真实模型 ID 写入模型并发起请求，不按名称猜协议或能力 |
| 日志、缓存和请求头检查 | 不输出完整 Key，登录 token 不发送到模型服务 |

客户端代码触点及定向回归已记录在 `.mea/customizations.yml` 的 `enterprise-model-binding` 条目，长期约定同步至 `AGENTS.md`。`JavaModelConfigClient.test.ts` 覆盖请求头、响应信封、协议及失败语义；`CoworkModelConfigSync.test.ts` 使用仓库统一的 `setupTestDatabase()` 验证真实 SQLite 写入、跨实例保留本地配置与工具能力、新 Key 导入、删除重建、停用恢复、Key 隔离、身份切换、迟到响应和事务回滚。`EnterprisePlugin.test.ts` 覆盖每次登录仅同步一次、周期在线校验不拉取模型、失败不阻断业务环境及下次登录重试；`useProvider.dataChange.test.ts` 使用真实查询与缓存验证列表、详情和凭据读取在收到同步通知后更新。上表是联调验收清单，尚不能视为真实后端的端到端验收结果。
