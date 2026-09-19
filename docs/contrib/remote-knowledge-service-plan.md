---
description: 新增远端知识库服务配置以对接外部知识库服务的接入方案，含接口规范、工程接入设计、实施阶段与开放问题
---

# 远端知识库服务接入方案

> MEACowork（cherry-studio）· 新增远端知识库服务配置，对接外部不同知识库服务 · 方案 v1.0（已评审定稿，2026-09-18）
>
> 评审决策记录：① v1 认证只做 Bearer + API-Key（OAuth2 client-credentials 列为规范扩展预留，不实现）；② 远端库支持进助手静态绑定（`remote:` ID 直接进现有绑定列表）；③ 本轮实施 P0→P4 全量交付。
>
> 配套可视化版：`docs/remote-knowledge-service-plan.html`

## 一、背景与目标

**现状**：知识库为**本地索引**（文档解析 → 分块 → 本地向量化 → SQLite 向量库），经 `kb_search / kb_list / kb_read / kb_manage` 工具在助手会话与智能体会话中被模型调用（`knowledgeLookup.ts` 共享核心，AI-SDK 与 MCP 两条路径共用）。

**目标**：新增「远端知识库服务」配置——定义一套标准 REST 接口规范，外部知识库服务按规范适配后即可接入现有 kb_* 检索链路；**我们定义契约，外部实现服务端**。本地知识库能力保持不变。

## 二、职责边界

| 本工程（客户端 / 调用方） | 外部知识库服务（提供方） |
|---|---|
| 定义接口规范并交付外部 | 按本规范实现 bases / search / read / health |
| 远端服务配置管理（地址 / 认证 / 密钥） | 负责服务端向量化、检索、Rerank、权限校验（如企业版链路） |
| 远端知识库发现与检索路由（kb_list / kb_search / kb_read） | 返回带来源与元数据的检索片段 |
| 本地知识库链路保持不变 | — |

## 三、接口规范（外部服务需实现，核心交付）

**通用约定**：路径前缀 `/v1`；`Content-Type: application/json`；认证按配置 `Authorization: Bearer <token>` 或 `X-API-Key: <key>`；分数归一化 `[0,1]`。

| 端点 | 用途 | 映射 kb 工具 |
|---|---|---|
| `GET /v1/health` | 连通性 / 配置校验 | 设置页「测试连接」 |
| `GET /v1/knowledge/bases` | 列出该服务下可检索的知识库 | `kb_list` |
| `POST /v1/knowledge/search` | 检索（query + base_ids + top_k + rerank + filters） | `kb_search` |
| `POST /v1/knowledge/read` | 按片段/文档读取内容（供追问溯源） | `kb_read` |

**search 响应片段**：`chunk_id / base_id / document_id / title / content / score / source（url|path）/ metadata`

**错误模型**：`{"error":{"code","message"}}`，code ∈ `unauthorized / forbidden / not_found / invalid_request / rate_limited / upstream_error`

## 四、工程接入设计

### 1. 远端 base 标识（命名空间）

远端知识库以 `remote:{serviceId}:{remoteBaseId}` 标识，与本地 uuid 区分；解析/构建工具放在 shared 层。**作用域解析（`resolveKnowledgeBaseScope`）无需改动**——按字符串处理，现有"绑定=天花板、选择只收窄"语义直接适用。

### 2. 配置存储

新表 `remote_knowledge_service`（drizzle + migration）：

```
id / name / base_url / auth_type / api_key（AES 加密）/ headers(JSON) / timeout_ms / enabled / 时间戳
```

### 3. 路由分发（最小侵入）

在 `knowledgeLookup.ts` 按前缀分流：本地 → 现有 `KnowledgeService`；远端 → 新 `RemoteKnowledgeClient`（electron `net.fetch`）。

- `kb_list`：合并本地 + 各启用服务的远端库
- `kb_manage`：对远端返回只读提示

### 4. 门控调整

`hasAnyKnowledgeBase` 纳入「存在启用的远端服务」，保证仅配置远端服务时 kb_* 工具仍可见。

## 五、调用时序

### A. 管理侧：配置远端服务

```
设置页（新增服务：名称/URL/认证/密钥）
  → IPC（remote_knowledge.* 路由）
  → RemoteKnowledgeService（CRUD + 连通测试 GET /health）
  → SQLite（remote_knowledge_service 表）
```

### B. 检索侧：提问 → 远端检索 → 回答

```
模型调 kb_list（合并本地 + 远端发现，remote:… id）
  → 模型调 kb_search（baseIds 含 remote:…）
  → knowledgeLookup 分流（解析 remote:serviceId:baseId）
  → RemoteKnowledgeClient（按服务并行调 POST /search，可多 base、rerank）
  → 合并 + 归一化（score [0,1] 去重排序，补 citeId 溯源）
  → 上下文注入 → LLM 回答（带引用）；追问可 kb_read 回溯远端片段
```

## 六、文件改动清单

**新增（11）**：

- `src/shared/data/types/remoteKnowledge.ts`（类型 + baseId 工具）
- `src/shared/ipc/schemas/remoteKnowledge.ts`（IPC 契约）
- `src/main/data/db/schemas/remoteKnowledgeService.ts`（服务表 + 远端绑定 junction 表）+ 迁移 SQL
- `src/main/features/remoteKnowledge/RemoteKnowledgeClient.ts`
- `src/main/features/remoteKnowledge/RemoteKnowledgeService.ts`
- `src/main/ipc/handlers/remoteKnowledge.ts`
- `docs/remote-knowledge-service-api.md`（接口规范交付）
- 设置页 UI（远端服务管理）
- composer 知识库选择器远端库接入 + 绑定读写合并
- 单元测试
- mock 外部知识库服务（测试夹具，供 P4 联调）

**修改（6）**：

- `knowledgeLookup.ts`（远端分流）
- `serviceRegistry.ts`（注册服务）
- `ipcHandlers.ts` + `ipcSchemas.ts`（挂载路由）
- `buildAgentParams.ts`（门控纳入远端服务）
- AssistantService / AgentService 绑定读写（合并远端 junction 表）
- docs 索引（README）

## 七、实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 接口规范文档 + shared 类型 + baseId 工具 | 外部可按文档独立实现 |
| **P1** | 配置表 + RemoteKnowledgeService + IPC（CRUD/测试连接） | typecheck + 单测通过 |
| **P2** | knowledgeLookup 远端分流（list/search/read）+ 门控 | 本地链路回归不变 |
| **P3** | 设置页 UI（列表/新增/编辑/测试连接/启用） | 可完整配置并检索 |
| **P4** | mock 外部服务联调 + 端到端验证 | 检索→引用→溯源闭环 |

## 八、已决与遗留问题

**已决（2026-09-18 评审，2026-09-19 补充）**：

- **认证**：v1 支持 Bearer / API-Key 两种静态凭据；规范预留 `oauth2` auth_type 枚举位，客户端不实现（配置了 oauth2 的服务连接测试时报「暂不支持」）。
- **助手静态绑定远端库**：本轮支持。现有 `assistant_knowledge_base` / `agent_knowledge_base` junction 表对 `knowledge_base.id` 有外键（CASCADE），`remote:` 字符串 ID 无法直接入库——新增无外键的 `assistant_remote_knowledge_base` / `agent_remote_knowledge_base` junction 表（行存完整 `remote:{serviceId}:{remoteBaseId}` 字符串），AssistantService/AgentService 读取时合并两表。作用域解析（`resolveKnowledgeBaseScope`）仍零改动；绑定允许悬空（服务删除/禁用时运行时过滤并降级提示）。
- **实施范围**：P0→P4 全量。
- **不自动绑定**（2026-09-19）：配置远端服务不自动加入任何助手/智能体（含默认助手）。kb 工具门控谓词维持 `hasAnyKnowledgeBase && scope.length > 0` 不放宽。使用路径 = composer 手选（本轮）/ 显式绑定（长期）/ 服务级 enabled 开关（全局停用）。
- **响应截断**：客户端对远端 search 响应强制 `chunks.slice(0, top_k)`（契约约束请求、截断约束响应）；混合场景总量 = 本地既有量（不变）+ 远端服务数 × top_k，合并不做全局截断（不改变纯本地存量行为）。
- **UI 区分与展示边界**：一切以 `isRemoteKnowledgeBaseId()` 前缀判断；选择器/绑定弹窗混排 + 「远端」Badge；知识库管理页不混入远端库（管理页=文档管理，远端全只读），远端库只在设置页服务区 + 选择器/绑定编辑器出现。
- **退出路径**：停用（enabled 开关，可逆，保留配置与绑定，kb_list 消失 + 残留引用 partial-failure 降级）/ 删除（服务行 + 密文 + 绑定级联清除，二次确认）/ 关闭应用（无常驻连接，无需操作）。

**设计补充（代码勘察结论，实施时遵循）**：

- `kb_list` 大纲模式（`getOrganizationTree`）与 `kb_read` grep 模式远端无对应端点：v1 对远端 base 返回明确引导文案（「远端库请使用 kb_search / kb_read」）；接口规范不为此加端点。
- 联邦搜索 = 客户端按服务并行调 `POST /search` 后合并（复用 knowledgeLookup 现有 merge/dedup/sort/citeId 逻辑）；不做服务端聚合。**混合场景（本地+远端）总量控制**：本地返回量保持既有行为不变；远端每服务贡献上限 = 请求 `top_k`（默认 8），且客户端对响应 `chunks.slice(0, top_k)` 强制截断——契约约束请求、截断约束响应，违规服务端无法撑爆上下文。多配一个远端服务的暴露增量等价于多绑一个本地库，不引入新风险形态。
- 远端检索超时默认 30s（`timeout_ms` 可配），单服务失败不影响其他（partial-failure 语义已有）。
- `kb_manage` 对远端 base 返回只读引导。
- 门控：`resolveHasAnyKnowledgeBase()` 返回 `hasAnyBase() || 存在启用的远端服务`，保持 fail-open。
- API Key 落库前加密：使用 electron `safeStorage`（OS 钥匙串，先例 `CopilotService`；`aes.ts` 需外部密钥、工程内无应用级密钥管理，不采用）。IPC 出口不回传明文，仅返回 `hasApiKey` 布尔。
- 迁移注意：新迁移文件必须手工审查 SQL + 快照 prevId 链完整性（`drizzle-kit check`）。

**遗留（后续版本）**：

- OAuth2 client-credentials 自动换 token 与刷新。
- 无绑定时远端服务的「发现式激活」：放宽 kb 工具 `applies` 门控（`hasAnyKnowledgeBase && scope.length > 0` → 存在启用远端服务时 scope 为空也激活，scope=空=全量发现）。运行时语义已支持，但会改变本地库「无绑定不激活」的既有行为，属产品级决策，2026-09-19 评审定为本轮不做、不自动绑定远端库。
- 助手侧绑定校验远端库可用性（服务禁用/库已删除时的绑定降级提示）。
- `kb_read` 分页读取远端长文档（当前一次返回整片段）。
