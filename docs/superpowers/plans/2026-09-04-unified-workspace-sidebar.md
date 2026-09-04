# Unified Workspace Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单一工作区侧边栏的完整态和悬浮完整态中同时展示主导航、普通对话历史与智能体任务历史，同时只在 50px 图标态保留收藏快捷入口。

**Architecture:** 保留业务层 `app/Sidebar.tsx` 已有的 `navigationEntries`、`historySections` 和收藏 `entries` 数据构造，不新增公共 props 或持久化状态。只在展示层按 `SidebarVisibleLayout` 收紧收藏渲染条件，并把两类历史的滚动边界提升为一个统一历史区域；真实展示测试负责布局状态契约，业务测试继续负责路由与数据映射契约。

**Tech Stack:** React 19、TypeScript、Vitest 3、Testing Library、`@cherrystudio/ui`、Tailwind CSS、lucide-react、Electron renderer

**Design Spec:** `docs/superpowers/specs/2026-09-04-unified-workspace-sidebar-design.md`

***

## File Map

- Modify: `src/renderer/components/Sidebar/Sidebar.tsx`

  - 决定 full/icon/floating 的内容组合。

  - 将普通对话和智能体任务放入同一个可滚动历史区域。

- Modify: `src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx`

  - 使用真实展示组件验证 full、icon、floating full 的可见内容和分组折叠契约。

- Modify: `src/renderer/components/app/__tests__/Sidebar.test.tsx`

  - 移除“完整态展示收藏”的旧契约。

  - 保留主导航、历史数据映射和收藏未被清除的业务契约。

- Verify only: `src/renderer/components/app/Sidebar.tsx`

  - 已有 `navigationEntries`、`historySections`、`entries` 和 `sidebarProps` 足以支持设计，预期无需修改。

- Verify only: `src/renderer/components/Sidebar/SidebarList.tsx`

  - 已有 `SidebarList` 与 `SidebarEntryList` 分工、历史 presentation，以及条目按自身能力提供的中键和上下文菜单行为保持不变。

- Verify only: `src/renderer/components/Sidebar/SidebarFooter.tsx`

  - 已有 FullFooter 包含固定底部的单行账户信息行；其上方低强调 Footer actions 继续保留，预期无需修改。

## Test Scope Decisions

本计划保护以下具体回归：

1. 将收藏渲染条件改错，导致完整态或悬浮完整态再次出现收藏列表。
2. 将图标态收藏入口一并隐藏，导致用户失去快捷入口。
3. 历史分组被拆到侧边栏之外，或其中一个分组未渲染。
4. 两个历史分组共用错误的折叠状态，折叠一个时另一个也消失。
5. 业务层为隐藏完整态收藏而清空 `ui.sidebar.favorites`。

本计划有意不增加以下低价值测试：

- 不断言一般视觉 Tailwind 类、具体 padding、字号或圆角。

- 不快照整个侧边栏 DOM。

- 不重复测试已覆盖的 resize 数值、hover 延时、上下文菜单和中键内部实现；但会把依赖收藏可见性的菜单与中键用例调整到图标态。

- 不在 mock 的业务测试中证明 full/icon/floating 的真实可见性；该契约由真实展示测试负责。

- 不为 Footer 增加“仅渲染成功”的测试；现有角色查询和点击测试已经覆盖可访问入口。

### Task 1: 用失败测试定义三种布局的内容契约

**Files:**

- Modify: `src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx:320-362`

- Modify: `src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx:529-567`

- Test: `src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx`

- [ ] **Step 1: 增加统一的导航和历史 fixture**

在 `entries` fixture 后增加独立的固定导航和两个历史分组。不要复用收藏 `entries` 作为历史条目，以免测试把不同职责混在一起。

```tsx
const navigationEntries: ResolvedSidebarEntry[] = [
  {
    ...appEntry({ id: 'new-task', label: 'New task', icon: Search }),
    key: 'workspace:new-task',
    presentation: 'primary'
  },
  {
    ...appEntry({ id: 'resources', label: 'Resource Center', icon: Search }),
    key: 'workspace:resources'
  },
  {
    ...appEntry({ id: 'scheduled-tasks', label: 'Scheduled Tasks', icon: Search }),
    key: 'workspace:scheduled-tasks'
  }
]

const historySections = [
  {
    id: 'conversations',
    label: 'Conversations',
    collapsible: true,
    entries: [
      {
        ...appEntry({ id: 'project-notes', label: 'Project notes', icon: Search }),
        key: 'topic:project-notes',
        presentation: 'history' as const
      }
    ]
  },
  {
    id: 'agent-tasks',
    label: 'Tasks',
    collapsible: true,
    entries: [
      {
        ...appEntry({ id: 'audit-dependencies', label: 'Audit dependencies', icon: Search }),
        key: 'session:audit-dependencies',
        presentation: 'history' as const
      }
    ]
  }
]
```

- [ ] **Step 2: 将 full 旧测试替换为统一侧边栏契约测试**

删除 `renders the full layout at the full threshold` 中对收藏文本 `Chat` 的断言，并将 `renders apps and direct mini app icons together in one full docked list` 替换为以下行为测试。该测试应在实现前失败，因为当前 full 仍显示 `Favorites` 收藏组。

```tsx
it('renders navigation and both history groups without favorites in the full layout', () => {
  render(
    <Sidebar
      width={SIDEBAR_FULL_THRESHOLD}
      setWidth={vi.fn()}
      active={{ activeItem: 'resources' }}
      entries={entries}
      entriesLabel="Favorites"
      navigationEntries={navigationEntries}
      sections={historySections}
      sectionsLabel="History"
      title="Cherry Studio"
    />
  )

  expect(screen.getByRole('navigation', { name: 'Cherry Studio' })).toHaveTextContent(
    'New taskResource CenterScheduled Tasks'
  )
  expect(screen.getByRole('button', { name: 'Conversations' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Project notes' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Audit dependencies' })).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Favorites' })).not.toBeInTheDocument()
})
```

- [ ] **Step 3: 增加 icon 状态测试**

该测试保护图标态收藏快捷入口，且确认历史文字不泄漏到紧凑布局。

```tsx
it('keeps favorites in the icon layout without rendering history text', () => {
  render(
    <Sidebar
      width={SIDEBAR_ICON_WIDTH}
      setWidth={vi.fn()}
      active={{ activeItem: 'resources' }}
      entries={entries}
      entriesLabel="Favorites"
      navigationEntries={navigationEntries}
      sections={historySections}
      title="Cherry Studio"
    />
  )

  expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Conversations' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Project notes' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Tasks' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Audit dependencies' })).not.toBeInTheDocument()
})
```

- [ ] **Step 4: 增加 floating full 状态测试**

该测试应在实现前失败，因为浮动分支也复用当前会显示收藏的 `renderContent('full')`。

```tsx
it('renders the unified full content without favorites in the floating sidebar', () => {
  render(
    <Sidebar
      width={SIDEBAR_FULL_THRESHOLD}
      setWidth={vi.fn()}
      active={{ activeItem: 'resources' }}
      entries={entries}
      entriesLabel="Favorites"
      navigationEntries={navigationEntries}
      sections={historySections}
      title="Cherry Studio"
      isFloating
    />
  )

  expect(screen.getByRole('navigation', { name: 'Cherry Studio' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Project notes' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Audit dependencies' })).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Favorites' })).not.toBeInTheDocument()
})
```

- [ ] **Step 5: 把单分组折叠测试升级为双分组独立折叠测试**

替换现有 `collapses and expands a history section`，验证两个分组不会共享错误状态。

```tsx
it('collapses history groups independently', async () => {
  const user = userEvent.setup()

  render(
    <Sidebar
      width={SIDEBAR_FULL_THRESHOLD}
      setWidth={vi.fn()}
      active={{ activeItem: 'resources' }}
      entries={[]}
      sections={historySections}
    />
  )

  const conversations = screen.getByRole('button', { name: 'Conversations' })
  const tasks = screen.getByRole('button', { name: 'Tasks' })

  await user.click(conversations)

  expect(conversations).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('button', { name: 'Project notes' })).not.toBeInTheDocument()
  expect(tasks).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Audit dependencies' })).toBeInTheDocument()

  await user.click(tasks)

  expect(tasks).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('button', { name: 'Audit dependencies' })).not.toBeInTheDocument()
})
```

- [ ] **Step 6: 运行展示层测试并确认红灯原因正确**

Run:

```bash
pnpm test:renderer src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx
```

Expected: 新增的 full 与 floating full 测试 FAIL，失败信息指出 `Favorites` 组仍存在；icon 和独立折叠测试应通过。如果 fixture 类型报错，先修正 fixture 类型，不进入生产实现。

### Task 2: 最小实现布局状态与统一历史滚动区

**Files:**

- Modify: `src/renderer/components/Sidebar/Sidebar.tsx:181-255`

- Test: `src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx`

- [ ] **Step 1: 将收藏列表限制在 icon 状态**

在 `renderContent` 中用布局状态守卫收藏区域。删除 full 态收藏标题分支，因为收藏区只会在 icon 态渲染。

```tsx
{contentLayout === 'icon' && entries.length > 0 && (
  <div role={entriesLabel ? 'group' : undefined} aria-label={entriesLabel}>
    <SidebarList layout={contentLayout} {...listProps} />
  </div>
)}
```

这一步不能删除 `entries`、`entriesLabel`、`onEntriesReorder` 或 `listProps`；它们仍是图标态收藏和排序的真实依赖。

- [ ] **Step 2: 将滚动边界提升到整个历史区**

将当前每个 section 各自 `flex-1 overflow-y-auto` 的结构替换为一个历史区滚动容器。保持 section 标题、`aria-expanded`、折叠状态和 `SidebarEntryList` 不变。

```tsx
{contentLayout === 'full' && sections.length > 0 && (
  <div className="flex min-h-0 flex-1 flex-col gap-2">
    {sectionsLabel && (
      <h2 className="shrink-0 px-3 font-medium text-[11px] text-muted-foreground">{sectionsLabel}</h2>
    )}
    <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden">
      <div className="flex flex-col gap-2">
        {sections.map((section) => {
          const collapsed = collapsedSections[section.id] ?? false
          return (
            <section key={section.id} aria-label={section.label}>
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() =>
                  section.collapsible &&
                  setCollapsedSections((current) => ({ ...current, [section.id]: !collapsed }))
                }
                className="flex h-7 w-full items-center gap-1 px-3 font-medium text-[11px] text-sidebar-foreground [-webkit-app-region:no-drag]">
                <ChevronDown size={12} className={cn('transition-transform', collapsed && '-rotate-90')} />
                <span>{section.label}</span>
              </button>
              {!collapsed && (
                <SidebarEntryList
                  entries={section.entries}
                  active={active}
                  layout="full"
                  onContextMenuOpenChange={handleContextMenuOpenChange}
                />
              )}
            </section>
          )
        })}
      </div>
    </div>
  </div>
)}
```

不要提取新的 `SidebarSection.tsx`：Section 只在此处使用，新增抽象不会改善职责边界。

- [ ] **Step 3: 将收藏菜单和中键测试调整到图标态**

现有 `opens an item context menu` 与 `opens an item in a new tab with the middle mouse button` 都在 full 宽度下通过收藏 `entries` 提供目标条目。收藏改为仅 icon 可见后，将这两个用例的 `width` 改为 `SIDEBAR_ICON_WIDTH`，其余 fixture 和断言保持不变。这样测试继续验证收藏项已有交互，而不会重新引入 full 态收藏。

- [ ] **Step 4: 运行展示层测试并确认绿灯**

Run:

```bash
pnpm test:renderer src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx
```

Expected: PASS。既有 resize、hover dismiss、overlay、上下文菜单、中键和图标态 mini app 测试继续通过。

- [ ] **Step 5: 检查本任务 diff 只包含布局契约所需变更**

Run:

```bash
git diff -- src/renderer/components/Sidebar/Sidebar.tsx src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx
```

Expected: 生产代码只改变收藏显示条件和历史滚动容器；不出现 `SidebarProps`、`types.ts`、Footer、resize 或路由逻辑变更。

### Task 3: 校正业务层测试边界并保护收藏数据

**Files:**

- Modify: `src/renderer/components/app/__tests__/Sidebar.test.tsx:252-379`

- Modify: `src/renderer/components/app/__tests__/Sidebar.test.tsx:538-555`

- Test: `src/renderer/components/app/__tests__/Sidebar.test.tsx`

- [ ] **Step 1: 让测试 Sidebar mock 遵循真实布局的可见性边界**

在 mock 中使用现有 `width`、`SIDEBAR_HIDDEN_THRESHOLD` 和 `SIDEBAR_FULL_THRESHOLD` 精确计算 `isIcon` 与 `isFull`，让收藏 mock 只在 icon 状态输出，让 sections 只在 full 状态输出。保留 `entries` 传入 mock，以便现有收藏排序和菜单业务测试继续操作条目。

```tsx
const resolvedWidth = width ?? 0
const isIcon =
  resolvedWidth >= constants.SIDEBAR_HIDDEN_THRESHOLD && resolvedWidth < constants.SIDEBAR_FULL_THRESHOLD
const isFull = resolvedWidth >= constants.SIDEBAR_FULL_THRESHOLD
```

将 section 条件改为：

```tsx
{isFull
  ? sections?.map((section) => (
      <section key={section.id} aria-label={section.label}>
        <h2>{section.label}</h2>
        {section.entries.map((entry) => (
          <div key={entry.key} role="group" aria-label={entry.label}>
            <button type="button" onClick={entry.onOpen}>
              {entry.label}
            </button>
            {entry.contextMenuItems?.map((menuItem, index) =>
              menuItem.id ? (
                <button
                  key={menuItem.id}
                  type="button"
                  data-testid={`sidebar-menu-${entry.key}-${menuItem.id}`}
                  disabled={menuItem.enabled === false}
                  onClick={menuItem.onSelect}>
                  {menuItem.label}
                </button>
              ) : (
                <hr key={`separator-${index}`} />
              )
            )}
          </div>
        ))}
      </section>
    ))
  : null}
```

将收藏及各收藏类型测试节点包进 icon 条件，不改变节点内部现有 test id：

```tsx
{isIcon && (
  <>
    <div data-testid="sidebar-items" role="group" aria-label={entriesLabel}>
      {/* 保留现有 items 映射 */}
    </div>
    <div data-testid="sidebar-mini-app-section">{/* 保留现有 dockedTabs 映射 */}</div>
    <div data-testid="sidebar-agent-section">{/* 保留现有 agentItems 映射 */}</div>
    <div data-testid="sidebar-assistant-section">{/* 保留现有 assistantItems 映射 */}</div>
  </>
)}
```

如果现有收藏管理测试显式设置了 full 宽度，应将它们的 setup 改成 `SIDEBAR_ICON_WIDTH` 语义对应值，而不是让 mock 在 full 状态继续暴露收藏。

- [ ] **Step 2: 更新业务组合测试**

将 `renders main navigation, favorites, conversations, and tasks in the full layout` 改为只验证业务层提供的完整态内容，并断言没有因 full 渲染清除收藏 preference：

```tsx
it('renders main navigation and both history groups in the full layout without clearing favorites', () => {
  mocks.sidebarWidth = 180
  mocks.sidebarFavorites = [appFavorite('translate'), appFavorite('assistants')]
  mocks.topics = [{ id: 'topic-1', name: 'Release planning' }]
  mocks.sessions = [{ id: 'session-1', name: 'Audit dependencies' }]

  render(<Sidebar />)

  expect(screen.getByRole('navigation', { name: 'Main navigation' })).toHaveTextContent(
    'New taskResource CenterScheduled Tasks'
  )
  expect(screen.getByRole('region', { name: 'Conversations' })).toHaveTextContent('Release planning')
  expect(screen.getByRole('region', { name: 'Tasks' })).toHaveTextContent('Audit dependencies')
  expect(screen.queryByRole('group', { name: 'Favorites' })).not.toBeInTheDocument()
  expect(mocks.setSidebarFavorites).not.toHaveBeenCalled()
})
```

这里的 setter 断言代表外部持久化副作用，因此是有效的 mock 边界；不要断言内部 `useMemo` 或 child props。

- [ ] **Step 3: 运行业务层测试并修复受布局 mock 影响的用例**

Run:

```bash
pnpm test:renderer src/renderer/components/app/__tests__/Sidebar.test.tsx
```

Expected: PASS。若收藏排序或收藏菜单用例因 mock 只在 icon 态渲染而失败，将对应测试宽度设为 `50`，保持被测业务行为不变；不得恢复 full 态收藏输出。

- [ ] **Step 4: 运行两组定向测试**

Run:

```bash
pnpm test:renderer src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx src/renderer/components/app/__tests__/Sidebar.test.tsx
```

Expected: 两个测试文件全部 PASS，且没有 unhandled error 或 act warning。

### Task 4: 视觉与交互运行时验收

**Files:**

- Verify: `src/renderer/components/Sidebar/Sidebar.tsx`

- Verify: `src/renderer/components/Sidebar/SidebarList.tsx`

- Verify: `src/renderer/components/Sidebar/SidebarFooter.tsx`

- Verify: `src/renderer/components/app/Sidebar.tsx`

- [ ] **Step 1: 启动或复用受跟踪的 Cherry Studio Electron 实例**

在支持仓库代理技能的环境中，调用 `cherry-electron-dev` 技能启动或复用当前 workspace 的受跟踪实例，不要把该名称当作 shell 命令，也不要手工启动第二个未跟踪实例。若执行环境不支持该技能，则先读取 `package.json` 的当前开发脚本，使用仓库提供的 Electron 启动方式，并确保只保留一个属于当前 workspace 的实例。

进入主窗口后，使用现有 UI 准备至少一个普通对话历史、一个智能体任务历史和一个收藏入口；这些数据只用于本地验收，不编写 seed 或修改持久化实现。

Expected: 应用正常加载，可明确确认实例来自当前 workspace，且无新增 renderer error。

- [ ] **Step 2: 验收完整态单一侧边栏**

将侧边栏拖到 full 阈值以上，逐项确认：

- 同一个 `data-ui="app.sidebar"` 区域内出现新建任务、资源中心、定时任务。

- 同一区域内出现普通对话和智能体任务两个分组及各自历史条目。

- 收藏应用名称不出现在完整态。

- 品牌区、主导航和账户区保持可见。

- 历史条目足够多时，滚动发生在统一历史区域，账户区不被推出视口。

- 当前导航或历史条目有清晰选中态。

Expected: 完整态与批准设计一致，没有第二个历史侧栏。

- [ ] **Step 3: 验收图标态与悬浮完整态**

将侧边栏拖到 50px 图标态，确认：

- 三项主导航图标存在。

- 收藏应用图标存在且可点击。

- 普通对话和智能体任务标题与历史文本不显示。

再拖到隐藏态并从左侧热区触发悬浮展开，确认：

- 悬浮栏显示三项主导航和两类历史。

- 悬浮栏不显示收藏应用列表。

- 打开上下文菜单或 Footer overlay 时悬浮栏不会提前关闭。

Expected: 四种状态的显示规则与设计规格一致。

- [ ] **Step 4: 验收保留交互**

逐项操作：

- 独立折叠普通对话和智能体任务。

- 点击普通对话和智能体任务，确认进入准确 route。

- 在图标态对提供 `onOpenNewTab` 的收藏条目执行中键打开；历史条目只验证现有普通点击行为。

- 在图标态拖拽收藏排序。

- 拖拽侧边栏经过中间宽度并释放，确认按原方向吸附。

- 打开 Settings，确认工作区侧边栏按原规则隐藏。

Expected: 所有既有行为保持有效；DevTools Console 无新增 error 或 warning。

### Task 5: 最终静态验证与范围审计

**Files:**

- Verify: `src/renderer/components/Sidebar/Sidebar.tsx`

- Verify: `src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx`

- Verify: `src/renderer/components/app/__tests__/Sidebar.test.tsx`

- Verify: `docs/superpowers/specs/2026-09-04-unified-workspace-sidebar-design.md`

- Verify: `docs/superpowers/plans/2026-09-04-unified-workspace-sidebar.md`

- [ ] **Step 1: 运行 renderer 定向测试**

Run:

```bash
pnpm test:renderer src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx src/renderer/components/app/__tests__/Sidebar.test.tsx
```

Expected: PASS。

- [ ] **Step 2: 运行仓库要求的 lint、类型和 i18n 总门禁**

Run:

```bash
pnpm lint
```

Expected: exit code 0。该命令会写入格式化修复；完成后必须重新检查 diff，确保没有无关文件变化。

- [ ] **Step 3: 运行文档门禁**

Run:

```bash
pnpm docs:check
```

Expected: links、structure、frontmatter 和 generated index 全部通过。

- [ ] **Step 4: 检查格式、空白与最终改动范围**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- src/renderer/components/Sidebar/Sidebar.tsx src/renderer/components/Sidebar/__tests__/Sidebar.test.tsx src/renderer/components/app/__tests__/Sidebar.test.tsx
```

Expected:

- `git diff --check` 无输出且 exit code 0。

- 代码改动仅限上述三个目标文件。

- 设计和计划文档位于 `docs/superpowers/`。

- `.superpowers/` 若为 brainstorming 工具生成的本地状态，只报告其存在，不纳入代码实现范围。

- 未出现 `SidebarList.tsx`、`SidebarFooter.tsx`、`app/Sidebar.tsx`、AppShell、i18n 目录或数据层的无关改动。

- [ ] **Step 5: 对照验收标准完成最终审计**

逐条核对设计规格 Acceptance Criteria，并在交付摘要中报告：

- 单一侧边栏内的三类内容均存在。

- full 与 floating full 不显示收藏。

- icon 显示收藏且不显示历史文本。

- 收藏 preference 未被清除。

- 独立折叠、导航，以及各类条目当前已有的中键与菜单、resize、吸附、hover 和 Settings 行为无回归。

- 定向测试、`pnpm lint` 与 `pnpm docs:check` 的实际结果。

不得将未执行的运行时检查描述为已验证。

## Execution Notes

- 本计划不要求创建新生产文件或新公共组件。

- 本计划不新增 i18n key；沿用 `workspace.history.conversations`、`workspace.history.agentTasks`、`history.records.shortTitle` 和现有导航文案。

- 本计划不修改 `ui.sidebar.favorites`，也不新增数据迁移。

- 本计划不包含提交步骤。只有用户明确要求提交时，才按仓库规则使用聚焦的 Conventional Commit，并执行签名与 DCO sign-off。

