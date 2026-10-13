---
description: 企业组织账号、公共技能与连接器目录、全量复制安装模式的功能交接说明
sources:
  - src/main/enterprise
  - src/main/ipc/handlers/enterprise.ts
  - src/shared/ipc/schemas/enterprise.ts
  - src/renderer/hooks/useOrgAccountSession.ts
  - src/renderer/hooks/useOrgSkills.ts
  - src/renderer/hooks/useOrgConnectors.ts
  - src/renderer/components/UserPopup.tsx
  - src/renderer/components/resourceCatalog/catalog/OrgSkillCatalogView.tsx
  - src/renderer/pages/settings/McpSettings/OrgConnectorList.tsx
  - src/renderer/pages/workspace/SkillsConnectorsPage.tsx
---

# 企业组织资源功能交接

## 1. 交接范围

本文档介绍 `feature/enterprise-plugin` 分支中从 `840f94ebbb` 到 `bc4c2f9a74` 的企业组织资源功能。该范围共 33 个提交、92 个文件，核心交付包括：

- 企业账号登录、会话恢复、刷新与退出；
- 公共组织技能目录、分类筛选、标签展示、安装与卸载；
- 公共组织连接器目录、搜索、安装和组织来源标识；
- 企业主进程服务、类型化 IPC、数据库兼容迁移和多语言文案；
- 企业服务地址的部署配置。

基线不能直接采用 `main...HEAD`：当前分支还包含多轮上游同步和 MEA Cowork 既有定制。交接时应以首个企业插件提交的父提交 `840f94ebbb^` 为功能基线。

本文档以 `bc4c2f9a74 feat(enterprise): 组织技能支持分类筛选与标签展示，对齐推荐视图` 为已交付功能终点。

## 2. 当前产品语义

当前实现是“公共目录 + 全量复制”模式，不是“组织托管”模式。

- 未登录用户也可以浏览技能和连接器目录；有会话时请求会附带 Bearer token。
- 技能或连接器安装后成为本地资源，由用户自行启用、修改和删除。
- 登出不会停用已安装资源。
- 服务端下架或更新不会自动修改本地副本。
- 用户删除本地副本后可以再次安装，不写删除墓碑。
- 启动时只把旧托管来源迁移为本地来源，不再执行自动同步。

分支早期实现过 C1-C6 托管生命周期，因此 `OrgStateStore`、`startupScan`、`compareAndSync`、停用/墓碑 IPC 及部分测试仍保留。当前主链路已绕开这些逻辑。维护时必须先确定 copy 模式是否已最终定稿，再决定删除遗留代码或用明确开关保留；不要同时维护两套含义相反的生命周期。

## 3. 用户操作路径

### 3.1 企业账号

1. 点击侧边栏用户头像打开用户弹窗。
2. 点击企业账号“登录”。
3. 客户端生成 PKCE `state`、`codeVerifier` 和 S256 challenge，并用系统浏览器打开企业服务 `/authorize`。
4. 服务端完成授权后回调 `meacowork://auth/callback`。
5. 主进程校验 state 和 10 分钟有效期，调用 `/api/token` 换取会话并落盘。
6. 登录后弹窗显示手机号；`super_admin` 额外显示管理员身份。
7. 退出只清理本地企业会话，不调用服务端 revoke，也不影响已复制资源。

### 3.2 组织技能

入口为“技能·连接器 > 技能 > 推荐 > 组织”。

- 顶部搜索框由 `SkillsConnectorsPage` 统一持有，同时用于公共推荐技能和组织技能。
- 搜索字段包括名称、描述、slug、分类和标签。
- 分类页签包含“全部”“待分类”和服务端返回的分类集合。
- 卡片展示组织来源、图标、标签和版本；已安装状态按本地技能 `sourceUrl=org-skill:<slug>` 判断。
- 安装时下载 tar.gz、校验 SHA-256、解包并走现有 `SkillService` 安装流程。
- 卸载复用普通技能卸载逻辑。

### 3.3 组织连接器

入口为“技能·连接器 > 连接器 > 组织”。

- 支持按名称和描述搜索，并可手动刷新目录。
- 安装使用目录返回的完整 MCP 配置，支持 `stdio`、`sse` 和 `streamableHttp`。
- 新安装连接器默认关闭，`installSource` 写为 `manual`，并增加 `org` 标签。
- 已安装状态目前按本地 MCP 名称与目录名称相等判断。
- 删除复用普通 MCP 删除逻辑。

## 4. 架构与职责

```text
UserPopup / SkillsConnectorsPage / McpCatalog
                │
                ▼
useOrgAccountSession / useOrgSkills / useOrgConnectors
                │  typed IPC
                ▼
       enterprise IPC handlers
                │
                ▼
EnterprisePlugin
├── OrgAuthManager       PKCE、深链回调、会话与 token 刷新
├── OrgApiClient         企业 HTTP API、匿名目录请求、生命周期上报
├── OrgSkillCatalog      技能目录缓存、下载校验、复制安装
├── OrgMcpCatalog        连接器配置归一化、复制安装、旧来源迁移
├── OrgCredentialStore   org-session.json
└── OrgStateStore        旧托管模式状态，当前主链路不使用
```

关键文件：

| 层级 | 文件 | 职责 |
| --- | --- | --- |
| 生命周期 | `src/main/enterprise/EnterprisePlugin.ts` | 注册企业服务，启动时迁移旧来源 |
| 认证 | `src/main/enterprise/OrgAuthManager.ts` | 登录、回调、刷新、退出、状态广播 |
| HTTP | `src/main/enterprise/OrgApiClient.ts` | 请求企业服务、公共目录和技能包下载 |
| 技能 | `src/main/enterprise/OrgSkillCatalog.ts` | 目录 TTL、安装状态、包校验与安装 |
| 连接器 | `src/main/enterprise/OrgMcpCatalog.ts` | 目录配置转换、安装和来源回填 |
| IPC | `src/shared/ipc/schemas/enterprise.ts` | 企业请求与事件契约 |
| 账号 UI | `src/renderer/components/UserPopup.tsx` | 登录状态和操作入口 |
| 技能 UI | `src/renderer/components/resourceCatalog/catalog/OrgSkillCatalogView.tsx` | 搜索、分类、标签和安装状态 |
| 连接器 UI | `src/renderer/pages/settings/McpSettings/OrgConnectorList.tsx` | 搜索、刷新和安装 |

## 5. 服务端契约

| 方法与路径 | 用途 | 关键响应或请求字段 |
| --- | --- | --- |
| `GET /authorize` | PKCE 登录授权 | `client_id`、`redirect_uri`、`state`、`code_challenge` |
| `POST /api/token` | 授权码换 token | `access_token`、`refresh_token`、`expires_in`、`user` |
| `POST /api/auth/token/refresh` | 刷新 token | 请求 `{ refreshToken }`；响应 `{ accessToken, refreshToken }` |
| `GET /api/skills` | 公共技能目录 | `slug`、`name`、`version`、`contentHash`、`categories`、`tags` |
| `GET /api/skills/:slug/download` | 下载技能包 | tar.gz；客户端校验 SHA-256 |
| `POST /api/skills/lifecycle` | 最佳努力生命周期上报 | `{ skillSlug, event, detail }` |
| `GET /api/connectors` | 公共连接器目录 | `slug`、`name`、`type`、`baseUrl`、`config` |

目录接口允许匿名访问。当前技能下载实现仍要求登录，与“匿名可安装”的 UI 语义不一致，联调时需要确认服务端和产品预期。

## 6. 数据与兼容迁移

企业文件位于应用 `userData/Data/enterprise`：

- `org-session.json`：用户、手机号、角色、access token、refresh token、过期时间，文件权限为 `0600`；
- `org-state.json`：旧托管模式的资源快照、可用性和墓碑，当前 copy 主链路不再写入。

技能继续写入 `agent_global_skill` 和 `Data/Skills`。组织技能以 `source=local`、`sourceUrl=org-skill:<slug>` 保存。

连接器继续写入 `mcp_server`。迁移 `0031_sloppy_pet_avengers.sql` 扩展了 `install_source` CHECK 以兼容历史 `org` 值；启动后旧值会迁移为 `manual`。不要直接删掉 `org` 枚举或迁移兼容，除非确认所有升级路径都已完成。

## 7. 部署配置

企业服务地址使用构建期变量：

```bash
MAIN_VITE_ORG_SERVER_BASE_URL=https://org.example.com pnpm build
```

该地址覆盖授权、token、技能目录/下载和连接器目录。未配置时回退 `http://127.0.0.1:3000`，生产部署必须显式覆盖。

注意：变量由 Vite `import.meta.env` 注入。只在运行已打包应用时设置环境变量不会生效，必须在构建阶段提供。地址解析目前只取 URL `origin`，不能配置带路径前缀的部署地址。

## 8. 已知问题与接手优先级

### P0：发布前必须确认

1. token 刷新成功后没有更新 `expiresAt`，旧过期时间会导致后续请求持续刷新；刷新响应契约也没有 `expiresIn`。
2. 收到 401 后再次调用 `getValidSession()` 不会强制刷新未过期 token，通常会因 token 未变化直接失败。
3. 组织连接器的目录配置可以包含 `command`、`args`、`env` 和 `headers`。虽然默认关闭，但用户启用后可执行本地命令；服务端发布审核和客户端确认是安全边界。
4. 生产构建若漏配企业地址会静默连接 localhost。

### P1：建议下一轮处理

1. 连接器已安装状态按名称判断，同名手工连接器会误判，改名或同配置副本会漏判，也可能重复安装。应持久化稳定 slug/sourceUrl 映射。
2. 公共目录响应没有运行时校验；技能 slug、下载地址和压缩包内容进入文件系统流程前需做路径、同源和解包越界校验。
3. 技能包下载先把全部分片保存在内存，再统一写盘；大包会放大主进程内存，应改为真正流式写入并限制体积。
4. `useOrgSkills` 首次加载也传 `force: true`，实际绕过 5 分钟 TTL；应区分初始加载和手动刷新。
5. `authorizing` 状态没有禁用重复登录，用户可再次点击并覆盖内存中的 PKCE pending。
6. 账号状态查询失败时企业账号区域静默消失，缺少错误和重试状态。
7. `OrgStateStore` 和旧托管测试与当前 copy 模式并存，维护成本和误判风险较高。

## 9. 测试与验收

已有测试主要覆盖：

- `OrgAuthManager`、`OrgApiClient`、`OrgSkillCatalog`、`OrgMcpCatalog`、`OrgStateStore`；
- 企业 IPC 输入输出和 copy 模式固定状态；
- 组织技能搜索、分类、标签、安装和并发迟到响应；
- 组织连接器安装后刷新本地 MCP；
- 企业服务地址解析和脚本来源校验。

明显缺口：

- `UserPopup` 企业登录、授权中、退出和失败状态；
- `useOrgAccountSession`、`useOrgConnectors` 独立测试；
- 连接器搜索、刷新、错误恢复、重复安装和稳定身份判断；
- token 刷新后过期时间以及 401 强制刷新；
- 匿名浏览/安装与服务端契约的端到端验证；
- 恶意目录数据、超大技能包和 tar 路径穿越测试。

建议接手后的最小验证：

```bash
pnpm exec vitest run --project main \
  src/main/enterprise/__tests__ \
  src/main/ipc/handlers/__tests__/enterprise.test.ts

pnpm exec vitest run --project renderer \
  src/renderer/hooks/__tests__/useOrgSkills.test.ts \
  src/renderer/components/resourceCatalog/catalog/__tests__/OrgSkillCatalogView.test.tsx \
  src/renderer/pages/settings/McpSettings/__tests__/OrgConnectorList.test.tsx \
  src/renderer/pages/workspace/SkillsConnectorsPage.test.tsx

pnpm docs:check
```

发布验收还应使用真实企业服务完成：匿名目录、登录回调、token 过期刷新、技能包校验失败、三种 MCP 类型安装、登出后本地资源继续可用，以及旧版本 `org` 来源迁移。

## 10. 后续改动注意事项

组织连接器工具栏若被停用，搜索、手动刷新和错误后的恢复入口会同时消失。调整该区域时应同步处理关联的 import、参数和 hook 返回值，避免产生未使用项并阻断 lint 或类型检查。
