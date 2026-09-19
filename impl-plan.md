# 远端知识库服务接入 — 实施计划

> 设计文档：`docs/contrib/remote-knowledge-service-plan.md`（v1.0 已评审定稿）
> 工作区：`../cherry-studio-rkb-wt`，分支 `feature/remote-knowledge-service`
> 执行纪律：TDD（先写会失败的测试）；每步验证后才进下一步；**所有对既有文件的修改都是增量分支，不禁用/删除任何原逻辑**；commit 需 `CODEBUDDY_SAFE_DELETE_ENABLED=0 CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0 CODEBUDDY_SAFE_DELETE_SANDBOX=0` + `-S --signoff`，Conventional Commits，scope 用 `remote-knowledge`。

## 已确认的设计决策（不许偏移）

1. v1 认证：`bearer` / `api_key`；`oauth2` 仅枚举占位（配置/测试连接时返回「暂不支持」）。
2. 远端库进助手/智能体静态绑定：新增无 FK junction 表（`assistant_remote_knowledge_base` / `agent_remote_knowledge_base`），绑定允许悬空（运行时按 partial-failure 降级）。
3. API Key 用 electron `safeStorage` 加密落库；IPC 出口只回 `hasApiKey`，不回明文。
4. `kb_list` 大纲模式、`kb_read` grep 模式、`kb_manage` 写操作对远端 base 一律返回引导文案（规范不为其加端点）。
5. 联邦搜索 = 客户端并行调多服务 + 复用现有 merge/dedup/sort/citeId；超时默认 30s（`timeout_ms` 可配）；单服务失败不影响其他。
6. baseId 格式 `remote:{serviceId}:{remoteBaseId}`；`remoteBaseId` 可含 `:`（只按第一个 `:` 切分）。
7. **不自动绑定**（2026-09-19 拍板）：配置远端服务不自动加入任何助手/智能体（含默认助手）。使用路径 = composer 手选（本轮）/ 编辑弹窗显式绑定（长期）/ 服务级 `enabled` 开关（全局停用）。kb 工具门控谓词维持 `hasAnyKnowledgeBase && scope.length > 0` **不放宽**（「无绑定发现式激活」是设计文档遗留项，本轮不做）。
8. **响应强制截断**：`RemoteKnowledgeClient` 对 search 响应 `chunks.slice(0, top_k)`——契约约束请求，截断约束响应，违规服务端无法撑爆上下文。
9. **UI 区分唯一源头**：一切以 `isRemoteKnowledgeBaseId()` 前缀判断；选择器/绑定弹窗混排 + 「远端」Badge；**知识库管理页不混入远端库**（管理页=文档管理，远端全只读），远端库只在设置页服务区 + 选择器/绑定编辑器出现。

---

## 任务 1（P0）：接口规范文档 `docs/remote-knowledge-service-api.md`

- 文件：`docs/remote-knowledge-service-api.md`（新增；带 frontmatter `description` + `sources`，仿 `docs/contrib/` 现有文件）
- 内容（外部交付物，必须可独立实现）：
  - 通用约定：路径前缀 `/v1`；`Content-Type: application/json`；认证头二选一（`Authorization: Bearer <token>` 或 `X-API-Key: <key>`，按客户端配置）；分数归一化 `[0,1]`；所有响应 `application/json`；UTF-8。
  - `GET /v1/health` → `200 {"status":"ok"}`；401/500 走错误模型。
  - `GET /v1/knowledge/bases` → `200 {"bases":[{"id","name","description"?}]}`（id 客户端不解释、原样回传）。
  - `POST /v1/knowledge/search`：请求 `{"query": string(必填,1..1000), "base_ids": string[] (必填,1..32), "top_k": int(可选,默认8,上限50), "rerank": bool(可选,默认true), "filters"?: object}`；响应 `{"chunks":[{"chunk_id","base_id","document_id","title","content","score","source"?,"metadata"?}],"error"?}`；`source` 为 `{url}` 或 `{path}`。
  - `POST /v1/knowledge/read`：请求 `{"base_id","document_id","chunk_id"?}`；响应 `{"document_id","title","content","total_chars"?,"truncated"?}`。
  - 错误模型：`{"error":{"code","message"}}`；code ∈ `unauthorized|forbidden|not_found|invalid_request|rate_limited|upstream_error`；HTTP 状态映射表（401/403/404/400/429/5xx）。
  - 兼容性章节：未实现的操作（客户端大纲/grep/管理）返回 `501` 或错误模型 `upstream_error`；`oauth2` 为保留枚举。
  - 附录：最小 Python/TypeScript 适配示例（各 ~20 行）。
- 验证：`pnpm docs:check` 通过。

## 任务 2（P0，TDD）：shared 类型 + baseId 工具

- 先写测试：`src/shared/data/types/__tests__/remoteKnowledge.test.ts`
  - 断言契约：`buildRemoteKnowledgeBaseId('svc1','base/中文')` → `'remote:svc1:base/中文'`；`parseRemoteKnowledgeBaseId` 往返一致；`remoteBaseId` 含 `:` 时只切第一个冒号；`parse('local-uuid')` → `null`；`parse('remote::x')` / `parse('remote:s:')`（空段）→ `null`；`RemoteAuthTypeSchema` 拒绝 `basic`。
- 实现：`src/shared/data/types/remoteKnowledge.ts`

```ts
export const REMOTE_KNOWLEDGE_BASE_ID_PREFIX = 'remote:'
export type RemoteAuthType = 'bearer' | 'api_key' | 'oauth2'
export const RemoteAuthTypeSchema = z.enum(['bearer', 'api_key', 'oauth2'])
// Entity（IPC 出口形状；apiKey 一律不出主进程）
export const RemoteKnowledgeServiceInfoSchema = z.strictObject({
  id: z.string(), name: z.string().trim().min(1), baseUrl: z.string().url(),
  authType: RemoteAuthTypeSchema, headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(300000), enabled: z.boolean(),
  hasApiKey: z.boolean(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
})
// 外部服务 wire 类型（search/read/bases），字段名用 snake_case 对外规范
export const RemoteWireChunkSchema = z.object({
  chunk_id: z.string().min(1), base_id: z.string().min(1), document_id: z.string().min(1),
  title: z.string(), content: z.string(), score: z.number().min(0).max(1),
  source: z.object({ url: z.string().optional(), path: z.string().optional() }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})
export const RemoteSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1000), base_ids: z.array(z.string().min(1)).min(1).max(32),
  top_k: z.number().int().min(1).max(50).optional(), rerank: z.boolean().optional(),
  filters: z.record(z.string(), z.unknown()).optional()
})
export const RemoteReadRequestSchema = z.object({
  base_id: z.string().min(1), document_id: z.string().min(1), chunk_id: z.string().optional()
})
export const RemoteWireErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
// baseId 工具（签名见上文测试断言）
export function buildRemoteKnowledgeBaseId(serviceId: string, remoteBaseId: string): string
export function parseRemoteKnowledgeBaseId(id: string): { serviceId: string; remoteBaseId: string } | null
export function isRemoteKnowledgeBaseId(id: string): boolean
```

- 验证：`pnpm exec vitest run src/shared/data/types/__tests__/remoteKnowledge.test.ts` 绿（先红后绿）。
- commit：`feat(remote-knowledge): shared types and remote base id utils`

## 任务 3（P1）：DB schema（3 张表）

- 文件：`src/main/data/db/schemas/remoteKnowledge.ts`（新增）

```ts
export const remoteKnowledgeServiceTable = sqliteTable('remote_knowledge_service', {
  id: uuidPrimaryKey(),
  name: text().notNull(),
  baseUrl: text().notNull(),
  authType: text().$type<RemoteAuthType>().notNull().default('bearer'),
  // safeStorage 密文（base64）；明文永不出现在 DB
  apiKeyEncrypted: text(),
  headers: text({ mode: 'json' }).$type<Record<string, string>>(),
  timeoutMs: integer().notNull().default(30000),
  enabled: integer({ mode: 'boolean' }).notNull().default(true),
  ...createUpdateTimestamps
}, (t) => [
  check('remote_knowledge_service_auth_type_check', sql`${t.authType} IN ('bearer','api_key','oauth2')`)
])
// 远端绑定 junction：无 knowledge_base FK（remote: 前缀字符串），行存完整 remoteBaseId
export const assistantRemoteKnowledgeBaseTable = sqliteTable('assistant_remote_knowledge_base', {
  assistantId: text().notNull().references(() => assistantTable.id, { onDelete: 'cascade' }),
  remoteBaseId: text().notNull(),
  ...createUpdateTimestamps
}, (t) => [primaryKey({ columns: [t.assistantId, t.remoteBaseId] })])
export const agentRemoteKnowledgeBaseTable = sqliteTable('agent_remote_knowledge_base', {
  agentId: text().notNull().references(() => agentTable.id, { onDelete: 'cascade' }),
  remoteBaseId: text().notNull(),
  ...createUpdateTimestamps
}, (t) => [primaryKey({ columns: [t.agentId, t.remoteBaseId] })])
```

- 验证：`pnpm typecheck:node` 通过。
- commit：`feat(remote-knowledge): db schema for service config and bindings`

## 任务 4（P1）：迁移生成 + 人工审查

- 命令：`pnpm db:migrations:generate`（drizzle-kit 自动生成）
- **人工审查（已知高危区，必须逐行看）**：
  1. 新 SQL 只 CREATE TABLE ×3 + 索引，无任何对既有表的改动；
  2. `pnpm db:migrations:check` 通过；
  3. 新快照 `prevId` 精确接在当前链尾（0030）快照 id 上，journal 追加一条；
  4. 迁移文件命名/序号 0031。
- 验证：`pnpm db:migrations:check` + `pnpm test:main src/main/data`（全量 DB 相关测试不回归）。
- commit：`feat(remote-knowledge): migration for remote knowledge tables`

## 任务 5（P1，TDD）：RemoteKnowledgeService

- 先写测试：`src/main/features/remoteKnowledge/__tests__/RemoteKnowledgeService.test.ts`
  - 用 `setupTestDatabase()`（`@test-helpers/db`，真实迁移 DB）；mock electron `safeStorage`（`isEncryptionAvailable()`→true，encryptString/decryptString 往返）。
  - 断言契约：
    - create（bearer + apiKey）落库后 `apiKeyEncrypted` ≠ 明文；list 返回 `hasApiKey:true` 且无任何密文字段；
    - update 换 apiKey 重加密；update 不带 apiKey 保留旧值；authType=`oauth2` 抛 `invalid_request`；
    - delete 同时清除两 junction 表中 `remote:{id}:%` 前缀的绑定行；
    - `hasAnyEnabledService()`：无行/全 disabled → false，任一 enabled → true；
    - `resolveClientConfig(id)`：disabled/不存在 → 抛 NOT_FOUND（DataApiError）；decrypt 往返等于原明文。
- 实现：`src/main/features/remoteKnowledge/RemoteKnowledgeService.ts`
  - `@Injectable()`，方法：`list()` / `getById(id)` / `create(dto)` / `update(id, dto)` / `delete(id)` / `testConnection(input)` / `hasAnyEnabledService()` / `listRemoteBases(serviceId?)` / `resolveClientConfig(serviceId)`
  - `testConnection` 支持两种入参（已存 id XOR 未保存草稿配置），内部统一走 `RemoteKnowledgeClient.health()`（任务 6 的类；本任务可先以注入 stub 的方式开发，任务 6 完成后换真实现——测试里 mock fetch 即可，不阻塞）。
  - 网络失败不抛裸错误，返回/抛 `DataApiError`（code ∈ 现有 `ErrorCode`，映射：超时→`TIMEOUT`/`UPSTREAM_ERROR`，按仓库现有枚举取最贴切者，写代码前先 grep `ErrorCode` 确认可用值）。
- 验证：`pnpm test:main src/main/features/remoteKnowledge` 绿。
- commit：`feat(remote-knowledge): service CRUD, test-connection and binding cleanup`

## 任务 6（P1，TDD）：RemoteKnowledgeClient

- 先写测试：`src/main/features/remoteKnowledge/__tests__/RemoteKnowledgeClient.test.ts`
  - 用 `node:http` 起临时真实服务（端口 0），或 stub `net.fetch`（二选一，优先 stub 保持纯单测；任务 18 再做真 HTTP 集成）。
  - 断言契约：
    - bearer：请求头 `Authorization: Bearer t1`；api_key：`X-API-Key: k1`；自定义 headers 合并（不覆盖认证头）；
    - search 响应映射正确；`score` 超 [0,1] 被截断；
    - **响应 chunks 超过请求 `top_k` 时被 `slice(0, top_k)` 截断**（防违规服务端撑爆上下文——契约约束请求，slice 约束响应）；
    - 401 + `{"error":{"code":"unauthorized"}}` → 抛错 message 含 `unauthorized`；非 JSON 响应 → `upstream_error`；
    - `timeoutMs=100` + 服务 sleep 500 → 超时错误；
    - read/health 同理。
- 实现：`src/main/features/remoteKnowledge/RemoteKnowledgeClient.ts`
  - `import { net } from 'electron'`，`net.fetch(url, { headers, signal })`（AbortController 实现超时）；
  - 方法：`health()` / `listBases()` / `search(req)` / `read(req)`；私有 `request(path, init)` 统一超时/头/错误解析（`RemoteWireErrorSchema.safeParse`）。
- 验证：`pnpm test:main src/main/features/remoteKnowledge` 绿。
- commit：`feat(remote-knowledge): HTTP client for the remote knowledge API`

## 任务 7（P1）：IPC 契约 + handler + 注册

- 文件 1：`src/shared/ipc/schemas/remoteKnowledge.ts`（新增）

```ts
export const remoteKnowledgeRequestSchemas = {
  'remote_knowledge.list': defineRoute({ input: z.strictObject({}), output: z.array(RemoteKnowledgeServiceInfoSchema) }),
  'remote_knowledge.create': defineRoute({ input: z.strictObject({ service: CreateRemoteKnowledgeServiceSchema }), output: RemoteKnowledgeServiceInfoSchema }),
  'remote_knowledge.update': defineRoute({ input: z.strictObject({ id: z.string(), patch: UpdateRemoteKnowledgeServiceSchema }), output: RemoteKnowledgeServiceInfoSchema }),
  'remote_knowledge.delete': defineRoute({ input: z.strictObject({ id: z.string() }), output: z.void() }),
  // id XOR config：支持「保存前测试」
  'remote_knowledge.test_connection': defineRoute({ input: z.strictObject({ id: z.string().optional(), config: RemoteServiceDraftSchema.optional() }), output: z.object({ ok: z.boolean(), latencyMs: z.number().optional(), error: z.string().optional() }) }),
  'remote_knowledge.list_bases': defineRoute({ input: z.strictObject({ serviceId: z.string().optional() }), output: z.array(RemoteKnowledgeBaseInfoSchema) })
}
```
- 文件 2：`src/shared/ipc/schemas/ipcSchemas.ts` — 仿 `knowledgeRequestSchemas` 增加 import + `...remoteKnowledgeRequestSchemas`（追加，不动其他行）。
- 文件 3：`src/main/ipc/handlers/remoteKnowledge.ts` — 仿 `handlers/knowledge.ts` 薄适配到 `application.get('RemoteKnowledgeService')`。
- 文件 4：`src/main/ipc/handlers/ipcHandlers.ts` — 同样追加挂载。
- 文件 5：`src/main/core/application/serviceRegistry.ts` — import + `services={...}` 注册 `RemoteKnowledgeService`（**逐项 diff 确认只增不改**）。
- 验证：`pnpm typecheck`（node+web 全量）+ 任务 5/6 测试仍绿。
- commit：`feat(remote-knowledge): IPC routes and service registration`

## 任务 8（P2，TDD）：knowledgeLookup 远端分流

- 先写测试：`src/main/ai/tools/__tests__/knowledgeLookup.remote.test.ts`（mock `application.get`：本地走现有 mock 模式，远端 mock `RemoteKnowledgeService.resolveClientConfig` + client search/read）
  - 断言契约：
    - `searchKnowledge`：`baseIds=['remote:svc:b1']` → client 收到 `base_ids:['b1']`，返回值形状/`score` 截断/`baseId` 保留 `remote:svc:b1`，与本地结果合并排序去重（跨本地+远端同 content 去重保留高分）；
    - 服务 disabled/未知 → 该 base 记为失败；本地 + 远端混合时本地结果照常返回（partial failure）；全部失败 → `{error}`;
    - `listOrOutlineKnowledge` list 模式：远端 base 追加为 `{id:'remote:svc:b1', name, groupId:null, status:'completed', itemsUnavailable:true, sampleSources:[]}`；远端服务发现失败不炸整页（跳过 + logger.warn）；
    - outline 模式 `baseId='remote:x:y'` → `{error: 引导文案}`；
    - `readOrGrepConcept`：read → POST /read 映射为 KbReadOutput（`conceptId=document_id`，`type:'file'`）；grep 模式 → `{error: 引导文案}`；
    - `manageKnowledge` 远端 → `{error: 只读引导}`；
    - 远端 id 出现在 `allowedIds` 之外 → 既有 out-of-scope 分支照常生效。
- 实现：`src/main/ai/tools/knowledgeLookup.ts`（**全部增量分支**）：
  - `searchKnowledge` per-base 循环内加 `isRemoteKnowledgeBaseId(baseId)` 分支：`parse → resolveClientConfig → client.search({query, base_ids:[remoteBaseId], top_k})` → 映射为 `{pageContent, score, scoreKind:'ranking', rank:i+1, metadata:{itemId:chunk_id, itemType:'file', source:source?.url??source?.path??'', chunkIndex:0, tokenCount:0}, chunkId, conceptId:document_id, title}` 喂给现有 merge 管线；
  - `readConcept` 前置分支同构；`readTree` / `manageKnowledge` 前置分支返回引导 error。
- 验证：`pnpm test:main src/main/ai/tools` 全绿（含既有 knowledgeLookup 测试零回归）。
- commit：`feat(remote-knowledge): route kb_* lookups to remote services`

## 任务 9（P2，TDD）：门控

- 测试：`src/main/ai/runtime/aiSdk/params/__tests__/buildAgentParams.test.ts` 增补用例（先红）：本地无库 + `RemoteKnowledgeService.hasAnyEnabledService()=true` → kb 工具可见；两者皆 false → 不可见；`hasAnyBase()` 抛错 → 仍 fail-open true。
- 实现：`buildAgentParams.ts` 的 `resolveHasAnyKnowledgeBase()` — 保留原 try/catch 结构，`return` 前追加远端检查分支：

```ts
function resolveHasAnyKnowledgeBase(): boolean {
  try {
    if (application.get('KnowledgeService').hasAnyBase()) return true
  } catch (error) {
    logger.warn('...; treating as present', { error })
    return true
  }
  try {
    return application.get('RemoteKnowledgeService').hasAnyEnabledService()
  } catch {
    return true // 与本地同语义的 fail-open
  }
}
```
- 验证：`pnpm test:main src/main/ai/runtime/aiSdk/params` 绿。
- commit：`feat(remote-knowledge): gate kb tools on enabled remote services`

## 任务 10（P2，TDD）：绑定读写拆分（AssistantService + AgentService）

- 测试（先红）：
  - `src/main/data/services/__tests__/AssistantService.test.ts` 增补：create/update 带 `knowledgeBaseIds:['<local-uuid>','remote:svc:b1']` → `assistant_knowledge_base` 只有 local、`assistant_remote_knowledge_base` 有 remote；getById 读回合并顺序 = local 后 remote；重复绑定幂等；删除远端服务（`RemoteKnowledgeService.delete`）后绑定行消失（任务 5 已测，这里测读侧悬空容忍：getById 照常返回悬空 remote id）。
  - `src/main/data/services/__tests__/AgentService.test.ts` 增补：镜像用例（`agent_remote_knowledge_base`）+ `assertKnowledgeBasesExistTx` 对 remote id 跳过本地存在性校验（改为格式校验：`parseRemoteKnowledgeBaseId` 成功即放行）。
- 实现（**锚点已勘察**）：
  - `AssistantService.ts`：
    - `getRelationIdsByAssistantIds`：knowledgeBaseRows 循环后，同构查询 `assistantRemoteKnowledgeBaseTable`（`inArray(assistantId, ids)`，orderBy createdAt）push 进 `knowledgeBaseIds`；
    - `syncRelationsTx` 的 `dto.knowledgeBaseIds` 分支：`isRemoteKnowledgeBaseId` 拆两半，local 走现有 diff 逻辑（把现有代码的目标集合换成 localIds），remote 用同一 diff 算法写 `assistantRemoteKnowledgeBaseTable`（diff key 换 `remoteBaseId`）。
  - `AgentService.ts`：
    - `fetchKnowledgeBasesForAgents`：同构合并 `agentRemoteKnowledgeBaseTable`；
    - create/update 的 junction 插入处：按 remote/local 拆分插两张表；
    - `assertKnowledgeBasesExistTx` 调用前先滤除 remote id（remote 另做格式断言）。
- 验证：`pnpm test:main src/main/data/services` 全绿。
- commit：`feat(remote-knowledge): persist remote base bindings for assistants and agents`

## 任务 11（P3）：设置页 UI

- 文件：
  - `src/renderer/routes/settings/remote-knowledge.tsx`（仿 `device-connections.tsx` 路由文件 + 导航注册；先读该文件确认导航清单位置再动）；
  - `src/renderer/pages/settings/RemoteKnowledgeSettings/index.tsx` + `ServiceForm.tsx` + `ServiceListItem.tsx`（组件用 `@cherrystudio/ui`；表单：名称/URL/认证类型下拉（oauth2 项 disabled+「即将支持」）/API Key 密码框（编辑时占位 `••••••••`，留空=不修改）/自定义 headers（kv 编辑，可后置到表尾）/超时/启用开关；操作：测试连接（显示 ok/延迟/错误）、「测试并保存」、删除（二次确认，提示将清除绑定））；
  - **停用/删除的差异化交互**（2026-09-19 评审语义）：`enabled` 开关 = 可逆暂停（保留配置与绑定，无确认）；删除 = 清场（服务行 + API Key 密文 + 全部绑定行级联消失，二次确认且文案明示「将同时移除所有助手/智能体绑定」）。停用后的行为：该服务库从 kb_list 消失、已有绑定保留、残留引用按 partial failure 降级（任务 8 语义）。
  - 数据层：`src/renderer/hooks/useRemoteKnowledge.ts` — 封装 `ipcApi` 调 `remote_knowledge.*` 六个路由（普通 IPC，不走 DataApi SWR）。
- 验证：`pnpm typecheck:web` + `pnpm test:renderer`（如有组件测试；无则手动 `pnpm dev` 走查一遍增删改测连接）。
- commit：`feat(remote-knowledge): settings UI for remote knowledge services`

## 任务 12（P3）：composer 选择器接入远端库

- 文件：
  - `src/renderer/components/composer/tools/components/KnowledgeBaseButton.tsx`：在 `useKnowledgeBases` 数据后追加远端 base 列表（`remote_knowledge.list_bases` → 映射 `{id: buildRemoteKnowledgeBaseId(serviceId, b.id), name: b.name, isRemote: true}`），QuickPanel 列表合并展示（名称尾部加「远端」徽标，i18n key）；`onSelect` 回传统一 id 列表（服务层已能拆分落库，无需前端区分）。
  - 注意 `onSelect` 现类型是 `(bases: KnowledgeBase[]) => void`：新增轻量展示类型（`{id,name,isRemote}`）替换 Props 泛型，**只在该组件与其调用方范围内改**；涉及调用方（chat/agent 两处 composer）传参形状核对。
  - **AgentEditDialog 绑定收敛 effect 必修**（勘察发现）：`AgentEditDialog.tsx` ~L405 的收敛 effect 按 `availableKnowledgeBaseIds`（仅本地 `useKnowledgeBases()`）过滤 `knowledgeBaseIds`，远端绑定会被打开弹窗即静默清除。改法：`availableKnowledgeBaseIds` 并入 `remote_knowledge.list_bases` 返回的远端 ID 集合后再收敛，保持「目录消失才清绑定」的原语义（本地库删了清、远端服务删了清，其余不动）。`EditDialogShared`（Assistant 侧共用）同步核对。
- 验证：`pnpm test:renderer`（KnowledgeBaseButton 相关既有测试）+ typecheck:web。
- commit：`feat(remote-knowledge): surface remote bases in composer picker`

## 任务 13（P3）：i18n + 设置入口文案

- 新 key（扁平、按 key 排序，先跑 `pnpm i18n:sync` 再手工补 `en`/`zh`，其余语言 sync 生成）：`settings.remoteKnowledge.title` / `add` / `edit` / `delete.confirm` / `testConnection` / `testConnection.ok` / `testConnection.failed` / `authType.bearer` / `authType.api_key` / `authType.oauth2.unsupported` / `apiKey.placeholder` / `apiKey.keepExisting` / `composer.knowledge.remoteBadge` / `settings.remoteKnowledge.empty` 等（实现时按 UI 实际用到的为准，宁缺勿滥）。
- 验证：`pnpm i18n:check`（lint 链会跑）通过。
- commit：`feat(remote-knowledge): i18n strings`（或并入任务 11/12 的 commit）

## 任务 14（P4）：mock 外部服务 + 真 HTTP 集成测试

- 文件：`tests/fixtures/remote-knowledge-server.mjs`（新增；零依赖 `node:http`）
  - 实现 4 端点 + 错误模型；内存语料 3 个 base / 6 个 chunk；支持 `?delay=ms` 与 `AUTH_TOKEN` 环境变量（不匹配返回 401 unauthorized）；默认端口 `24390`（避开 24333/19790），`PORT=0` 打印实际端口。
  - 用法注释：`node tests/fixtures/remote-knowledge-server.mjs`（联调时跑起来，设置页里配 `http://127.0.0.1:24390` 即可端到端手测）。
- 集成测试：`src/main/features/remoteKnowledge/__tests__/RemoteKnowledgeClient.integration.test.ts`
  - `spawn` 子进程起 mock（PORT=0，从 stdout 读端口），真 HTTP 打通 health/bases/search/read + 401 + 超时；`afterAll` 杀子进程。
- 验证：`pnpm test:main src/main/features/remoteKnowledge` 绿。
- commit：`test(remote-knowledge): mock external service and integration tests`

## 任务 15（P4）：收尾验证

- `pnpm lint`（含 typecheck 两套 + i18n check + 格式化）全绿；
- `pnpm test:main` + `pnpm test:renderer` + `pnpm test:shared` 全量；
- 手动走查（`pnpm dev`）：配置 mock 服务 → 测试连接 → composer 选择远端库提问 → 回答带 `[cite:]` 引用 → 追问 kb_read 溯源 → **停用服务**（kb_list 消失、绑定保留、检索降级）→ 重新启用 → **删除服务**（绑定级联清除、编辑弹窗无残留、无悬空崩溃）。
- `docs/README.md` 若索引了 contrib 文档：跑 `pnpm docs:index` 后提交。

## 里程碑验证汇总

| 阶段 | 任务 | 验收 |
|---|---|---|
| P0 | 1-2 | 外部可按 api.md 独立实现；类型单测绿 |
| P1 | 3-7 | CRUD/测试连接链路通；迁移审查过；typecheck 绿 |
| P2 | 8-10 | kb_* 远端分流绿；本地链路零回归；绑定拆分落库正确 |
| P3 | 11-13 | 设置页可完整配置（含停用/删除差异化交互）；composer 可选远端库；编辑弹窗远端绑定不被误清 |
| P4 | 14-15 | 真服务检索→引用→溯源闭环；停用/删除全场景走查通过 |
