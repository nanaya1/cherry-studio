## 指导原则（必须遵守）

### 思维方式

处理本仓库中任何编码任务时应遵循以下方式。

#### 编码前先思考

- 明确说明假设。如果不确定，请在实现前询问。
- 存在多种理解时，把它们明确提出来，不要默默选择一种。
- 如果有更简单的方法，请指出。必要时应提出异议。
- 如果有不清楚的地方，请停下来，说明困惑之处并询问。

#### 简单优先

- 只编写解决问题所需的最少代码，不做推测性实现。
- 不添加需求之外的功能。
- 不要为只使用一次的代码创建抽象。
- 不要添加未被要求的“灵活性”或“可配置性”。
- 不要为不可能发生的场景添加错误处理。
- 如果写了 200 行但 50 行就能解决，请重写。
- 行内注释最多 2 行。需要更多说明意味着代码只是补丁，应修正实现，而不是靠叙述解释。只说明“为什么”，不要复述“做什么”；不要写变更日志、长篇理由，也不要粘贴聊天或评审回复。（导出 API 上的文档注释，例如 TSDoc 的 `@param`、`@returns`、`@deprecated`，属于文档而非叙述，不受此限制。）

#### 精准修改

- 只修改任务要求的内容。不要顺手“改进”相邻代码、注释或格式。
- 不要重构没有问题的内容。
- 即使你会采用不同做法，也要匹配现有风格。
- 如果发现无关的死代码，请指出，但不要删除。
- 删除因**你的**修改而不再使用的导入、变量和函数。除非用户要求，否则不要处理原有死代码。
- 每一行改动都必须能直接追溯到用户的要求。

#### 目标驱动执行

- 编码前，把任务转化为可验证的目标：
  - “添加校验” → “为无效输入编写测试，然后让测试通过。”
  - “修复缺陷” → “编写能复现缺陷的测试，然后让测试通过。”
  - “重构 X” → “确保重构前后测试都通过。”
- 对于多步骤任务，给出简短计划，并明确每一步的验证方式：

```
1. [步骤] → 验证：[检查项]
2. [步骤] → 验证：[检查项]
```

### 操作规则

项目专用的工具、路径和约定。

- **保持清晰**：编写易于阅读、维护和解释的代码。
- **先阅读本地 README**：编辑某个目录中的代码前，检查该目录及其父目录中是否存在 `README.md` 并阅读。这些文件记录了仅凭代码不易发现的本地约定、不变量和入口点。
- **修正上游，不要在下游打补丁**：如果新功能触及现有模块的限制，应先提出改进上游模块的方案供用户决定，再考虑下游变通方案。
- **优先使用库，最后才自定义**：编写自定义代码前，先查看库或框架文档中是否已有内置选项或现成方案。只有没有合适方案时才编写自定义代码。
- **使用 Tailwind CSS 与 Shadcn UI 构建**：所有新 UI 组件都使用 `@cherrystudio/ui` 中的组件（位于 `packages/ui`，采用 Shadcn UI + Tailwind CSS）。
- **集中记录日志**：所有日志都必须通过带有正确上下文的 `loggerService` 输出，禁止使用 `console.log`。
- **集中访问路径**：主进程的所有文件系统路径都使用 `application.getPath('namespace.key', filename?)` 获取，绝不调用 `app.getPath()`、`os.homedir()`，也不要临时拼接路径。通过 `import { application } from '@application'` 导入单例。
- **检查改动范围，不要检查整个仓库**：代码改动应运行 `pnpm lint`（涵盖格式化、类型检查和 `i18n:check`），并运行覆盖本次改动的测试。可以使用各项目包装命令（`pnpm test:main <file>`、`test:renderer`、`test:aicore`、`test:shared`、`test:pkg:ui`、`test:scripts`），或对少量文件使用 `pnpm exec vitest run <file>`。只有改动范围较广或无法明确受影响测试时，才运行完整的 `pnpm test`。绝不要使用 `pnpm test <path>`：该脚本用 `&&` 串联多个 Vitest 调用，命令行参数只会传给最后一个调用，之前的项目会在未过滤的情况下运行完整测试套件。仅修改文档或 Markdown 时，只需运行 `pnpm docs:check`（链接、结构、frontmatter 和索引）。CI 会执行完整门禁；你的职责是避免明显破坏它。
- **编写约定式提交**：使用 Conventional Commits 格式创建小而集中的提交，例如 `feat(data-api):`、`fix(lifecycle):`、`refactor(quick-assistant):`、`docs(testing):`、`chore(deps):`、`test(window-manager):`。scope 必须是具体的 kebab-case 模块名，不能使用 `main` 这类笼统名称；如果 `git log` 中的惯例与此规则冲突，以此规则为准。
- **签名并签署提交**：每个提交都必须同时具有加密签名和 DCO sign-off。使用 `git commit -S --signoff`，不能只用 `--signoff`；确认提交对象含有 `gpgsig` 头（使用 `git cat-file commit HEAD` 检查），并确认推送后的 PR 提交在 GitHub 上显示 `Verified`。
- **选择正确的分支**：`main` 是所有活跃开发的默认分支，功能、重构、优化和修复都应提交到这里。

## 开发

### 命令

首先运行 `pnpm install`（Node 和 pnpm 版本固定在 `package.json` 中，应让它执行版本约束）。对于其他脚本，请阅读 `package.json`。必须了解以下命令：

- `pnpm lint` — oxlint + eslint fix + typecheck + i18n check + format（会写入文件）
- `pnpm test` — 运行全部 Vitest 测试
- `pnpm format` — 使用 Oxfmt 格式化（写入模式）
- `pnpm docs:check` — 文档门禁（`check-links` + 结构闭集检查 + frontmatter/`sources` 存在性 + 生成索引的新鲜度）；这是 `build:check` 相较于 `lint` + `test` 唯一增加的检查。修改文档或 Markdown 时运行它，无需运行完整门禁。`docs/references/**` 和 `docs/contrib/**` 下的文档需要包含 `description`/`sources` frontmatter；`docs/README.md` 是自动生成的，应修改 frontmatter 后运行 `pnpm docs:index`，绝不要手工编辑索引。
- `pnpm build:check` — `lint` + `docs:check` + 完整 `test`，即一条命令执行全部门禁。适合范围广或风险高的改动；范围较窄时只运行相关部分。如果因 i18n 排序失败，先运行 `pnpm i18n:sync`；如果因格式失败，先运行 `pnpm format`；如果文档链接损坏，则修复链接。
- `pnpm test:lint` — 与 CI 等效的 lint 门禁：Oxlint 的错误和警告都会阻止 CI（`--deny-warnings`）；ESLint 错误会阻止 CI，但警告不会。

### 测试

- 测试使用 Vitest 3 运行（项目配置见 `vitest.config.*`）。
- **禁止固化当前行为的测试**：如果一个测试唯一的断言只是记录代码当前行为，例如对任意输出做快照、对 mock 使用 `toHaveBeenCalled`，或按照实现逻辑重新推导预期值，那么它毫无价值。它不会因真正的问题而失败，却会在每次重构时破坏，并把现有缺陷认证为“预期行为”。应改为断言契约：真实输入 → 功能承诺的结果，并覆盖失败和边界情况。编写测试前，先说明它能捕获什么缺陷；如果说不出来，就不要写。**现有测试套件中充斥着此类测试**。如果你正在编辑的文件中存在这些测试，应删除它们，而不是只维持其通过；全仓库清理是独立任务，不应成为无关 PR 的副作用。
- **前端测试——必须阅读**：[前端测试指南](docs/references/testing/frontend-testing.md)。
- **测试 Mock**：使用统一的 mock 系统，禁止为 `application`、服务或数据层创建临时 mock。可用 mock、用法模式和最佳实践见 [tests/__mocks__/README.md](tests/__mocks__/README.md)。
- **数据库测试**：任何读写 SQLite 的服务、处理器或 seeder，都应使用 `setupTestDatabase()`（来自 `@test-helpers/db`）。它提供使用生产迁移的真实文件型数据库。禁止手写 `CREATE TABLE` SQL、覆盖 `@application` 或伪造 Drizzle 调用链。参见[数据库测试](docs/references/testing/database-testing.md)。

### 补丁依赖

升级任何依赖前，检查 `patches/` 中是否存在自定义补丁。

## GitHub

### Pull Request

使用 `gh-create-pr` 技能。备用方案：直接阅读 `.agents/skills/gh-create-pr/SKILL.md`。

### 代码评审

评审 GitHub PR 时，不要在本地运行 `pnpm lint`、`pnpm test` 或 `pnpm format`，因为 CI 已经运行过；应通过 `gh` 检查结果。

### Issue

使用 `gh-create-issue` 技能。备用方案：直接阅读 `.agents/skills/gh-create-issue/SKILL.md`。

## 约定

### TypeScript

- 跨进程类型应放在 `src/shared/`；仅渲染进程使用的共享类型应放在 `src/renderer/types/`（参见[共享层架构](docs/references/architecture/shared-layer.md)）。

### 命名约定

**必须阅读**：[docs/references/architecture/naming-conventions.md](docs/references/architecture/naming-conventions.md)，其中规定了文件、目录、标识符以及单复数规则。

### 日志

```typescript
import { loggerService } from "@logger";
const logger = loggerService.withContext("moduleName");
// 仅渲染进程：先调用 loggerService.initWindowSource('windowName')
logger.info("message", CONTEXT);
logger.warn("message");
logger.error("message", error);
```

### 路径

**必须阅读**：[src/main/core/paths/README.md](src/main/core/paths/README.md)，其中包含命名空间、命名方式、新增 key 和测试模式。（对应指导原则中的“集中访问路径”规则。）

### i18n

- 所有用户可见字符串都必须使用 `i18next`，禁止硬编码 UI 字符串。
- 语言目录位于 `src/renderer/i18n/locales/` 和 `src/main/i18n/locales/`；两者都以 `en-us.json` 为事实来源。
- 只有新增或修改 key 时才执行以下流程：编辑 `en-us.json`，运行 `pnpm i18n:sync`（用 `[to be translated]:` 占位符填充其他语言），然后翻译每一处。无需单独运行 `pnpm i18n:check`，因为 `pnpm lint` 已包含该检查；它会拒绝遗留占位符、空值、插值或标签不匹配以及未排序的 key。

### UI 设计

进行任何 UI 组件或页面样式工作前，先阅读 [DESIGN.md](./DESIGN.md)，并严格遵循其中的颜色、字体、间距和组件规范。

## 架构

### 代码组织

每个文件和目录都有规定位置。添加代码或打开目录前，应先阅读与你所修改流程相关的文档。每个进程根目录的顶层都是一个**闭集**：新代码必须归入现有类别，绝不能创建新的顶层目录（参见[命名约定 §4.8](docs/references/architecture/naming-conventions.md)）。

目录中的 `index.ts` 是 **barrel 文件**，也是强制执行的封装边界：它只重新导出一个内聚的公共 API，内部实现保持私有，外部通过它导入。该文件只能重新导出（不能包含逻辑，也不能使用 `export *`），不可嵌套，并且仅当 lint 能禁止深层导入时才应存在，否则不要创建 barrel。始终禁止使用 `index.tsx`（参见[命名约定 §6.4](docs/references/architecture/naming-conventions.md)）。

- [主进程架构](docs/references/architecture/main-process.md) — `src/main/` 下的目录（`core`/`ipc`/`data`/`ai`/`features`/`services`/`utils`/`i18n`）及依赖方向。
- [渲染进程架构](docs/references/architecture/renderer.md) — `src/renderer/` 的双轴布局（类型 × 领域）以及只允许向下依赖的分层。
- [共享层架构](docs/references/architecture/shared-layer.md) — 哪些内容属于 `@shared`（跨进程且无可变运行时状态）及其顶层闭集。

### 数据

**必须阅读**：[docs/references/data/README.md](docs/references/data/README.md)，其中包含系统选择、架构和模式。

| 系统                                                       | 使用场景                 | API                                                        |
| ---------------------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| [BootConfig](docs/references/data/boot-config-overview.md) | 早期启动设置（生命周期前） | `bootConfigService.get()`、`usePreference('BootConfig.*')` |
| [Cache](docs/references/data/cache-overview.md)            | 临时数据（允许丢失）       | `useCache`、`useSharedCache`、`useSharedCacheValue`、`usePersistCache` |
| [Preference](docs/references/data/preference-overview.md)  | 用户设置                 | `usePreference`                                            |
| [DataApi](docs/references/data/data-api-overview.md)       | 业务数据（**关键**）       | `useQuery`、`useMutation`                                  |

作用域：

- **BootConfig**：基于同步文件；在主进程生命周期前直接使用，其他场景通过 `usePreference('BootConfig.*')` 使用。
- **Cache**：分为内存、共享（跨窗口）和持久化层；主进程和渲染进程都支持内存层与共享层，也都支持持久化，但二者是**独立**存储（渲染进程使用 localStorage，主进程使用 `{userData}/cache.json` JSON 文件），绝不共享；主进程还负责在窗口之间转发渲染进程的持久化同步。
- **Preference**：跨进程（主进程 + 渲染进程）；自动在窗口间同步。
- **DataApi**：以 SQLite 为后端；不自动同步，由渲染进程按需获取。

数据库：通过 **better-sqlite3** + Drizzle ORM 使用 SQLite。驱动是**同步的**（查询和事务以内联方式运行，不使用 `await`，这与应用中其他异步数据层不同），因此 `getDb()` 查询和 `withWriteTx(fn)` 回调必须以同步方式编写。Schema 位于 `src/main/data/db/schemas/`，通过 `pnpm db:migrations:generate` 生成迁移。

**写入原子性**：使用 `application.get('DbService').withWriteTx(fn)`，在一个同步的 `BEGIN IMMEDIATE` 事务中以全有或全无的方式提交多次写入，或先读后写；`fn` 必须是同步函数。单次写入不需要使用它，因为 better-sqlite3 会在其单一连接上以原子方式执行每条语句。参见[数据库模式——写入串行化](docs/references/data/database-patterns.md#write-serialization-dbservicewritewritetx)。

**DataApi 边界规则**：DataApi 只用于 SQLite 支持的业务数据。没有数据库表，就不能创建 DataApi 端点，应改用 IPC。参见[作用域与边界](docs/references/data/api-design-guidelines.md#dataapi-scope--boundaries)。

### IPC（IpcApi）

**必须阅读**：[docs/references/ipc/README.md](docs/references/ipc/README.md)，其中包括范式边界（RPC 与 REST）、schema/router/preload/facade 分层、`IpcContext`、错误模型和安全性。

非数据命令 IPC（窗口、系统、shell、通知、外部调用、文件）通过 **IpcApi** 执行。它是 BootConfig、Cache、Preference、DataApi 之外的第五个子系统，采用 IPC 上的 RPC，并使用单点 schema：新增路由时提供 `schema + handler`；调用时使用 `ipcApi.request('namespace.action', input)`；事件使用 `IpcApiService.broadcast`/`send` + `useIpcOn`。旧版命令 IPC 仍然共存，因此会同时遇到两种形式。决策规则：SQLite 数据 → DataApi；用户设置 → Preference；可丢失或共享的数据 → Cache；其他所有命令式操作 → IpcApi。

### 窗口管理器

**必须阅读**：[docs/references/window-manager/README.md](docs/references/window-manager/README.md)，其中包含生命周期模式、池机制和 API 参考。

所有 `BrowserWindow` 都必须通过 `WindowManager` 管理，并使用三种模式之一（`default` / `singleton` / `pooled`）；各类型的模式在 `src/main/core/window/windowRegistry.ts` 中声明。

- **消费方 API**：只能使用 `open()` / `close()`，业务代码中禁止使用 `create()` / `destroy()`。
- **在 `onWindowCreated` 中绑定监听器**，不要在 `open()` 后绑定，因为复用窗口时不会执行后者。
- **渲染进程通过 `useWindowInitData` 读取初始化数据**。

### 主进程服务（生命周期）

**必须阅读**：[docs/references/lifecycle/README.md](docs/references/lifecycle/README.md)，其中包含架构、决策指南、使用模式和迁移步骤。

所有持有长期资源或注册持久副作用的主进程服务，**必须**使用生命周期系统：

- **继承 `BaseService`**，并应用 `@Injectable`、`@ServicePhase`、`@DependsOn` 装饰器。
- **在 `serviceRegistry.ts` 中注册**（`src/main/core/application/serviceRegistry.ts`），每个服务一行。
- **只对同阶段依赖使用 `@DependsOn`**。WhenReady 服务禁止声明对 BeforeReady 服务（`PreferenceService`、`DbService`、`CacheService`、`DataApiService`）的依赖；容器会自动强制执行阶段顺序。
- **通过 `application.get('Name')` 访问**；也可以使用 `getOptional()` 访问 `@Conditional` 服务。
- **使用 `this.ipcHandle()` / `this.ipcOn()` 处理 IPC**；它们会在 stop/destroy 时自动清理，并返回 `Disposable`。
- **使用 `this.registerInterval()` 注册周期性定时器**；它会自动 unref、隔离异常，并在 stop/destroy 时自动清理，返回 `Disposable`。
- **使用 `this.registerDisposable()` 跟踪清理项**；它接受 `Disposable` 对象或 `() => void` 清理函数。
- **使用 `Emitter<T>` / `Event<T>` 处理服务间事件，使用 `Signal<T>` 表示一次性完成**。
- 对具有重量级按需资源的服务，**实现 `Activatable`**（IPC 保持注册，资源通过 `onActivate()`/`onDeactivate()` 加载和释放）。
- **禁止**使用 `new` 或手工单例模式；容器负责实例化、排序和关闭。

详细代码示例参见[使用指南](docs/references/lifecycle/lifecycle-usage.md)。迁移旧服务参见[迁移指南](docs/references/lifecycle/lifecycle-migration-guide.md)。

### 非生命周期服务（直接导入单例）

对于不持有长期资源或持久副作用的服务，使用**具名导出单例**（`export const x = new X()`）。不要使用 `getInstance()` 模式。判断标准参见[决策指南](docs/references/lifecycle/lifecycle-decision-guide.md)。

## Schema 与迁移规则

v2 重构已经完成。v1 数据只能通过 `src/main/data/migration/v2/` 中的 migrator 进入 v2，绝不要为 v1 的保存、读取或丢失添加回退、双写或保护逻辑。

**迁移链不再是可随意丢弃的。**它已合并为一个干净的初始迁移，并随 `v2.0.0-rc.1` 发布，因此 `migrations/sqlite-drizzle/` 现在会在包含真实用户数据的数据库上运行。绝不要清空或重写已经发布的迁移，也绝不要让用户删除数据库。Schema 变更必须以新迁移追加，并通过 `pnpm db:migrations:generate` 生成。`src/main/data/db/schemas/` 仍可自由修改，但每次修改都必须能在已有数据的数据库上完成向前迁移。

**解决迁移合并冲突：重新生成，绝不要重命名。**如果上游迁移与本地迁移冲突，删除本地 `.sql` 及其 `meta/*_snapshot.json`，然后重新运行 `pnpm db:migrations:generate`。仅重命名或重新编号会悄悄复用快照中的随机 `id`，使所有人的迁移链产生分叉；而且 `drizzle-kit generate` 仍会以状态码 `0` 退出，只有 `pnpm db:migrations:check` 能发现问题。CI 同时强制执行迁移链检查，以及 schema 与迁移的生成后差异检查。

### 数据分类工具链

`scripts/data-classify/` 是 v2 数据层的代码生成流水线；`classification.json` 是唯一事实来源（参见其中的 README）。以下四个文件是**自动生成的，绝不要手工编辑**：`src/shared/data/preference/preferenceSchemas.ts`、`src/shared/data/bootConfig/bootConfigSchemas.ts`、`PreferencesMappings.ts` 和 `BootConfigMappings.ts`（后两个位于 `src/main/data/migration/v2/migrators/mappings/`）。如需修改，请编辑 `classification.json` 或 `target-key-definitions.json`（两者都位于 `data/` 中），然后运行 `cd scripts/data-classify && npm run generate`。

## MEA Cowork 定制规则（必须遵守）

本仓库以 **MEA Cowork** 名义维护，是 Cherry Studio 的定制分支（上游 `CherryHQ/cherry-studio`，定制仓库 `nanaya1/cherry-studio`），定期同步上游。本节为 fork 专属规则，**合并上游改动时必须原样保留**。

### 品牌身份 vs 兼容身份

换牌遵循一条原则：**用户可见的全换，外部身份/存储兼容项保持 Cherry Studio 原值**。涉及品牌字符串时先判断属于哪一类：

| 已换牌（用户可见） | 兼容保留（不要改） |
| --- | --- |
| `appId: com.meacowork.desktop`、`productName: MEA Cowork`、深链协议 `meacowork://` | 数据目录 `~/.cherrystudio`、数据库文件 `cherrystudio.sqlite`、`cherry.*` 路径命名空间、`cherry-media` scheme |
| OAuth DCR `client_name: "MEA Cowork"`、`client_uri: https://github.com/nanaya1/cherry-studio`（原值以注释保留在 `src/main/ai/mcp/oauth/provider.ts`） | 更新/analytics 请求头、NSIS GUID、Windows/Linux 可执行文件名 |

注意：GitHub 上不存在 `meacowork` 组织，对外仓库地址是 `https://github.com/nanaya1/cherry-studio`，不要写成 `github.com/meacowork`。

### 注释式修改（最高优先级）

- 需要禁用/绕过某段原逻辑时，把原代码**注释掉**，新逻辑紧随其后，并留一行说明；不删除原代码（定制点、上游代码均适用）。
- 回滚 = 取消注释。例外：本任务全新创建的文件不受约束；用户明确要求删除时才允许删除，并说明删了什么。

### 上游同步（sync）

- 同步在隔离 worktree `../cherry-studio-sync-wt`、分支 `sync/upstream-YYYY-MM-DD` 进行，绝不直接改发布分支。两步合并：先并上一个 sync 分支复用解法，再并 upstream/main 增量。
- 合并后必跑全量 `pnpm run typecheck`（node + web，只跑 web 会漏主进程错误）+ 相关 vitest（renderer：home/agents/history/resourceList；main：apiGateway/seeders）。
- `release/2.0.x` 与定制主线是**两条独立发布线**，修复不会自动互通；打包/发版前逐项核对关键定制行为存在于目标分支（`git branch -a --contains <sha>`）。
- 本仓库 prek/pre-commit 钩子可能改写 dead-code 相关代码，维护者本地已停用（`.git/hooks.disabled`）；提交使用 `git commit -S --signoff`。

### 定制热点（合并时必须保留）

- `electron-builder.yml`：appId / productName / `meacowork://` 协议；api_gateway 端口 24333、OpenClaw 19790。
- 雪浪 provider 图标（`packages/ui` icons catalog + 4 个 provider 文件）；Cherry login 隐藏（`ENABLE_CHERRY_ACCOUNT_LOGIN=false`）。
- 组件位置迁移：上游在 `pages/{home,agents}/…/components/`，本仓库移到 `components/chat/resourceList/`。合并姿势：以 upstream 版本为基底重放定制 props（如 Bot 图标隐藏），不要直接保留旧版文件。
- i18n 存在约 113 个 MEA-only key；语言 JSON 一律扁平结构、按 key 排序（渲染进程与主进程 locales 都是），禁止嵌套。
- 隐藏某个设置页/路由时，必须审计该数据的**所有消费方**（侧栏、设置搜索索引等），统一接入 `settingsMenu.ts` 的 `MEA_HIDDEN_SETTINGS_ROUTES`。

## 本地指令

如果仓库根目录存在 `CLAUDE.local.md`（该文件被 git 忽略，可能不存在），在执行本文件中的任何内容前，应完整阅读它。它包含开发者的私有指令；与本文件冲突时，**以它为准**。能够自动加载该文件的工具（例如 Claude Code）无需再次读取。
