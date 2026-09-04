# Unified Workspace Sidebar — Design Specification

## Scope

本设计仅调整主窗口左侧工作区侧边栏，使主导航、普通对话历史和智能体任务历史同时展示在一个统一侧边栏中，并对齐“Redesign Cherry Studio Layout”会话确认的结构层级。视觉参考为本次需求提供的图片 `/Users/nanaya/.trae-cn/attachments/6a9a17eb621d062966fdf000/bf2b5ade-b69f-4798-b604-3f8358386fb4_09c7d66c-eb96-4079-8d15-ff2ff4559cb9_img_v3_02156_e7bc1ff5-b9d9-48e3-a0f0-2b1e1befc5cg.jpg`；该路径用于本地实施验收，不作为仓库运行时依赖。

本设计覆盖完整展开态、50px 图标态、完全隐藏态和隐藏态悬浮展开。资源中心页面、顶部标签栏、主内容区和 Settings 壳层不在调整范围内。

## Current State

当前侧边栏采用两层结构：

- `src/renderer/components/app/Sidebar.tsx` 负责业务数据、路由、标签页导航和收藏管理。

- `src/renderer/components/Sidebar/Sidebar.tsx` 负责三态布局、导航列表、历史分区、Footer、拖拽缩放和隐藏态悬浮展开。

现有实现已经提供三项固定主导航、Assistant topics 普通对话历史、Agent sessions 智能体任务历史、收藏应用混排、分组折叠、当前项高亮、条目级打开行为、拖拽缩放和悬浮展开。收藏项可按自身能力提供上下文菜单和中键打开；历史条目当前仅提供普通点击打开。

当前完整态同时渲染固定导航、收藏应用和历史分区，视觉层级与参考布局不一致。收藏应用占据完整态主要区域，削弱主导航和历史会话的层级。

## Goals

- 在一个统一左侧栏中同时展示主导航、普通对话历史和智能体任务历史。

- 完整态的信息顺序严格为品牌区、主导航、历史会话区和底部账户区。

- 普通对话与智能体任务继续使用现有数据源、路由规则、折叠能力和活动项判断。

- 保留隐藏、50px 图标态、完整态、拖拽缩放和隐藏态悬浮展开。

- 完整态隐藏收藏应用列表，但不删除或迁移用户收藏数据。

- 图标态继续提供收藏应用快捷入口。

- 保持 Electron 窗口拖拽区，以及各类条目当前已有的点击、上下文菜单、中键和标签页打开行为；本次不扩展历史条目的导航能力。

- 使用 `@cherrystudio/ui` 组件和语义化 sidebar tokens，兼容亮色与暗色主题。

## Non-goals

- 不调整资源中心页面或其顶部管理导航。

- 不调整 AppShell 顶部标签栏、主内容边界和 macOS 交通灯布局。

- 不修改 Settings 活动时隐藏工作区侧边栏的行为。

- 不改变收藏数据结构、默认收藏顺序或偏好迁移。

- 不新增搜索、分页、虚拟列表、历史删除或历史重命名功能。

- 不重写标签页系统或历史数据查询逻辑。

- 不顺带重构无关侧边栏代码。

## Proposed Design

### Information Architecture

完整展开态使用单一侧边栏容器：

```text
┌─────────────────────────────┐
│  Cherry Studio              │  品牌区
├─────────────────────────────┤
│  ＋ 新建任务                │
│  ◆ 资源中心                 │  主导航
│  ◷ 定时任务                 │
├─────────────────────────────┤
│  历史会话                   │
│                             │
│  ▾ 普通对话                 │
│      产品布局讨论           │
│      翻译合同内容           │  可滚动历史区
│      模型配置问题           │
│                             │
│  ▾ 智能体任务               │
│      销售登录异常           │
│      整理竞品报告           │
├─────────────────────────────┤
│  头像  用户名            设置 │  固定账户区
└─────────────────────────────┘
```

不会增加第二个会话侧栏，也不会将普通对话和智能体任务拆到独立页面。

### Layout Regions

侧边栏纵向划分为四个区域：

1. 品牌区：展示现有产品标识和由 `APP_NAME` 提供的产品名；示意图中的“Cherry Studio”不是硬编码要求。
2. 主导航区：展示新建任务、资源中心、定时任务。
3. 历史区：展示“历史会话”标题、普通对话分组和智能体任务分组。
4. 账户区：展示头像、用户名、账户描述和设置入口。

品牌区、主导航区和账户区保持在侧边栏可视范围内。历史区占据剩余高度并独立滚动。历史条目增多时，只滚动历史区，不将账户区推出视口。

### Main Navigation

主导航保持现有三个 workspace route：

| 项目   | 路由                     | 展示规则       |
| ---- | ---------------------- | ---------- |
| 新建任务 | `/app/new-task`        | 使用高强调主操作样式 |
| 资源中心 | `/app/resources`       | 活动时使用整行选中态 |
| 定时任务 | `/app/scheduled-tasks` | 活动时使用整行选中态 |

路由点击继续使用现有标签页更新和新标签打开规则。主导航不进入收藏排序，也不受收藏偏好影响。

### Conversation History

普通对话分组继续使用 Assistant topics：

- 分组支持折叠与展开。

- 条目显示现有对话标题。

- 当前对话使用可感知的整行选中态。

- 点击条目打开对应 Assistant conversation。

- 保持当前普通点击打开行为；本次不新增中键或显式“新标签打开”入口。

- 空列表时保留分组标题，不新增本次范围之外的空状态文案。

### Agent Task History

智能体任务分组继续使用 Agent sessions：

- 分组支持折叠与展开。

- 条目显示现有任务标题。

- 当前任务使用可感知的整行选中态。

- 点击条目打开对应 Agent session。

- 保持当前普通点击打开行为；本次不新增中键或显式“新标签打开”入口。

- 空列表时保留分组标题，不新增本次范围之外的空状态文案。

### Favorite Applications

完整态不展示 Agent、助手、翻译、绘画、知识库、Mini App 及其他收藏实体列表。

该变化只影响完整态组合，不修改 `ui.sidebar.favorites`：

- 收藏数据继续持久化。

- 图标态继续按收藏顺序展示快捷入口。

- 用户切换回完整态时收藏数据不会被删除。

- Launchpad 和资源中心中的收藏管理行为保持不变。

- 收藏仍参与主窗口默认 landing URL 的现有计算，本次不改变启动语义。

### Layout States

| 状态       | 展示内容                              |
| -------- | --------------------------------- |
| 完整态      | 品牌区、三项主导航、普通对话历史、智能体任务历史、账户区      |
| 50px 图标态 | 主导航图标、收藏应用图标、图标态 Footer；不展示历史文字列表 |
| 完全隐藏态    | 左侧 hover 与 resize 热区              |
| 隐藏态悬浮展开  | 与完整态相同的品牌、主导航、两类历史和账户区            |

宽度阈值、拖拽预览、中间宽度吸附和最大宽度保持现有实现不变。

### Visual Direction

视觉实现遵守 `DESIGN.md`：

- 使用 sidebar 语义表面、前景色、边框和选中态 token。

- 不新增硬编码颜色或页面级主题分支。

- 通过背景、间距、字重和边框建立层级，不使用装饰性阴影或渐变。

- 新建任务保持唯一高强调主操作；其他导航和行级操作保持克制。

- 当前项、hover、focus-visible、disabled 和折叠状态必须可感知。

- 图标按钮保留可访问名称和必要 tooltip。

- 动效沿用共享组件行为并尊重 reduced motion。

参考图中的结构和层级是目标，具体尺寸优先复用 `@cherrystudio/ui` 已有组件、spacing、radius 和 typography tokens，而不是复制图片像素或创建局部设计系统。

## Component Responsibilities

### Business Sidebar

`src/renderer/components/app/Sidebar.tsx` 继续拥有：

- 主导航条目构造。

- Assistant topics 与 Agent sessions 数据转换。

- 活动路由解析。

- 标签页打开、更新和复用策略。

- 收藏数据和收藏操作。

- 完整态与图标态所需内容的组合决策。

该层不新增视觉样式，也不复制通用侧边栏布局。

### Presentational Sidebar

`src/renderer/components/Sidebar/Sidebar.tsx` 继续拥有：

- hidden、icon、full 三态结构。

- 品牌区、导航区、历史滚动区和 Footer 的空间布局。

- 完整态与悬浮完整态的一致内容组合。

- resize handle、hover 热区和 overlay 关闭协调。

- Electron drag/no-drag 区域。

### Lists and Sections

现有 Sidebar list 和 section 组件继续负责：

- 导航行和历史行渲染。

- 缩进、选中态、hover 和 focus-visible。

- 分组折叠。

- 上下文菜单和中键打开。

- 图标态收藏项排序交互。

只有在现有组件无法表达参考布局且需求可复用时，才调整共享组件 API；不创建平行的页面局部列表组件。

### Footer

`src/renderer/components/Sidebar/SidebarFooter.tsx` 现有账户信息行已符合参考图的单行结构，本次保持其组合：

- 账户信息行左侧显示头像和用户信息。

- 账户信息行右侧显示设置入口。

- Footer 整体固定在侧边栏底部。

- Feedback 等现有 Footer actions 可继续位于账户信息行上方，以低强调方式保留，不要求将整个 Footer 压缩为单行。

- 图标态现有 Footer actions 和用户入口继续保留。

## Data and State

本设计不引入新持久化状态：

- 侧边栏宽度继续由 `ui.sidebar.width` persist cache 管理。

- 收藏继续由 `ui.sidebar.favorites` preference 管理。

- 分组折叠继续使用现有组件状态。

- Assistant topics 和 Agent sessions 继续由现有 hooks 提供。

- 活动项继续由当前 tab URL 和已有 active matcher 派生。

完整态隐藏收藏项是渲染规则，不是数据迁移，不执行 preference 写入。

## Interaction and Edge Cases

- 主导航、历史条目与 Mini App 保持各自当前的 route-tab 打开策略；本次只调整侧边栏内容组合，不修改导航 hook。

- 当前已有的活动项判断继续用于选中态。

- Mini App 已有标签继续按现有策略复用。

- context menu 或 Footer overlay 打开时，隐藏态悬浮栏不得自动关闭。

- 拖拽结束后继续抑制误点击。

- 中间宽度只用于拖拽预览，释放后按方向吸附。

- 历史列表为空时侧边栏结构仍稳定，账户区仍固定底部。

- 长标题使用现有截断行为，不横向撑大侧边栏。

- 小窗口下优先保证主导航和账户区可用，历史区收缩并滚动。

- Settings 活动时工作区侧边栏继续不渲染。

## Alternatives Considered

### Dedicated Workspace Sidebar Variant

为参考布局新增一套独立工作区侧边栏组合，可隔离新旧 DOM，但会复制 Header、列表、Footer 和缩放行为。该方案增加长期维护成本，且不符合最小改动原则，因此不采用。

### Full Sidebar Rewrite

按参考图重写整个侧边栏再重新接回缩放、悬浮、菜单和 Electron 窗口拖拽能力，视觉结构直接，但回归风险高，且会重复已稳定的交互代码，因此不采用。

### Selected Approach

在现有通用侧边栏中增加明确的状态组合：完整态与悬浮完整态展示统一信息架构，图标态保留收藏快捷入口。该方案复用现有业务数据和交互能力，改动集中且可通过现有定向测试验证。

## Implementation Notes

预计修改集中在：

1. `src/renderer/components/Sidebar/Sidebar.tsx`

   - 重组完整态区域顺序和滚动边界。

   - 让固定完整态与悬浮完整态复用相同内容结构。

   - 仅在图标态渲染收藏列表。
2. `src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx`

   - 覆盖 hidden、icon、full 与 floating full 的真实可见性边界。

   - 将收藏菜单和中键测试放在收藏实际可见的图标态。
3. `src/renderer/components/app/__tests__/Sidebar.test.tsx`

   - 让业务测试 mock 精确区分 hidden、icon 与 full。

   - 验证完整态不显示收藏且不清除收藏 preference。
4. `src/renderer/components/app/Sidebar.tsx`、`SidebarList.tsx` 与 `SidebarFooter.tsx`

   - 仅做回归核验；现有数据构造、列表能力和 Footer 组合足以支持本设计，预期无需修改。

实施前应读取上述目录的本地 README；若不存在，则遵循父级架构文档和相邻组件惯例。

## Verification Strategy

测试必须断言用户可观察契约，而不是固定实现细节：

- 完整态的同一个侧边栏中同时存在三项主导航、普通对话历史和智能体任务历史。

- 完整态不显示收藏应用列表，但不会写入或清除收藏 preference。

- 图标态继续显示收藏快捷入口且不显示历史文本。

- 隐藏态悬浮展开显示主导航和两类历史。

- 两类历史分组可独立折叠和展开。

- 当前普通对话和当前智能体任务具有选中状态。

- 主导航、历史条目和收藏项保持各自现有的点击、中键与标签页打开语义。

- 历史区可滚动且 Footer 保持固定。

- resize、吸附、hover 热区、overlay 抑制和 Electron drag/no-drag 行为不回归。

完成代码后运行：

```bash
pnpm test:renderer src/renderer/components/app/__tests__/Sidebar.test.tsx
pnpm test:renderer src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx
pnpm lint
```

若实现触及 AppShell 结构，再运行对应 AppShell 定向测试；不运行无关的全量测试。

## Acceptance Criteria

- 完整展开态只有一个左侧栏，且该侧栏同时展示主导航、普通对话历史和智能体任务历史。

- 主导航顺序为新建任务、资源中心、定时任务。

- 普通对话与智能体任务作为“历史会话”下的两个可折叠分组展示。

- 历史区域独立滚动，品牌区、主导航和账户区保持可见。

- 当前导航、当前普通对话和当前智能体任务均有清晰选中态。

- 完整态和悬浮完整态不展示收藏应用列表。

- 50px 图标态继续展示主导航和收藏应用快捷入口。

- 收藏 preference 内容不会因完整态隐藏而改变。

- 隐藏、悬浮展开、拖拽缩放、宽度吸附，以及各类条目当前已有的上下文菜单、中键和标签页打开行为保持有效。

- Settings、资源中心页面、顶部标签栏和主内容布局无行为变化。

- 亮色、暗色和键盘 focus-visible 状态符合共享设计规范。

- 定向 renderer 测试和 `pnpm lint` 通过。

