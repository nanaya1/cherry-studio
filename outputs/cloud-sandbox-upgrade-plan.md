# Cherry Studio 云端沙箱升级方案分析

> 版本：v0.1（方案评审稿） · 日期：2026-09-07 · 范围：只做方案分析，未改动任何代码

## 1. 背景与目标

**诉求**：接入沙箱，获得云端运行能力，使手机端可以远程执行任务操作。

**结论先行**：现有架构服务化程度高（IoC 容器 + 单一 IPC funnel + aiCore 独立包），本升级是**增量演进而非重构**。推荐「沙箱抽象层 + SaaS 沙箱起步、保留自建后路」的技术路线，按 P0→P3 四阶段推进，P0 可在 1–2 周内落地首个可验证成果。

## 2. 现状盘点

| 能力 | 现状 | 关键位置 | 结论 |
|---|---|---|---|
| 服务架构 | IoC 容器 + 生命周期管理，约 70 个 service 注册 | `src/main/core/application/` | ✅ 新增沙箱 service 即插即用 |
| IPC 通信 | 单 funnel + zod 强类型 schema | `src/main/ipc/IpcApiService.ts`、`src/shared/ipc/` | ✅ 跨端复用只需换 HTTP/WS 适配器 |
| Agent 工具循环 | 单趟 stream + 工具注册表（11 个内置工具） | `src/main/ai/runtime/aiSdk/Agent.ts` | ✅ 可抽取为 headless 编排服务 |
| MCP | stdio / SSE / streamable-http / inMemory 全支持 | `src/main/ai/mcp/mcpTransport.ts` | ✅ 服务端接入零改造（streamable-http） |
| 本地沙箱 | dsh bash/pwsh 沙箱 + policy 越界检查；Pyodide | `packages/dsh-bridge/policy.ts` | ✅ 决策模型可直接复用到云端 |
| 云端沙箱 | 无 E2B / Daytona / Docker 远程执行 | — | ❌ P0 新建 |
| 移动端 | 无代码（仅 Roadmap）；aiCore 已含 react-native 导出 | `packages/aiCore/package.json` | 🟡 有包级基础，无端侧工程 |
| 数据层 | SQLite + Drizzle，30+ 表，知识库异步作业队列 | `src/main/data/db/` | ✅ 队列模型可复用；需新增设备/同步表 |
| 设置体系 | 单一 schema 源 + 页面模板 | `src/shared/data/preference/preferenceSchemas.ts` | ✅ 加沙箱配置页成本低 |

## 3. 目标架构

```
客户端层   手机端 App(RN)   桌面端 Electron(双模式)   Web 控制台(P2)
              └───────────────┬───────────────┘
接入层                      API 网关（鉴权 · 配额 · WebSocket 流式）
                             │
编排层      云端 Agent 编排服务（main/ai 抽取 headless 化）
            ├ LLM 调用（复用 @cherrystudio/ai-core）
            ├ Agent 工具循环（stream + 工具注册表）
            └ 任务队列（长任务 · 断点恢复）
                             │
执行层      云端沙箱集群（P0 新建）      MCP 服务（streamable-http）
            E2B / Daytona / 自建 Docker
                             │
数据层      Postgres · Redis · 对象存储 · 会话/任务状态同步
```

**架构要点**：

1. **工具执行下沉，编排位置分级演进**：P0–P1 保持「客户端编排 + 云端只执行工具」（密钥不出端、改动最小）；P2 起切换「云端编排」（手机锁屏后长任务仍可继续）。
2. **沙箱抽象层是全局关键路径**：定义 `SandboxProvider` 接口（`create / exec / upload / download / destroy`），E2B、Daytona、自建 Docker 都只是适配器，避免供应商锁定。
3. **IPC 协议即 API 契约**：`src/shared/ipc/` 的 zod schema 可直接映射为网关 REST/WS 契约，业务层零改动。
4. **策略复用**：dsh-bridge 的 `decideToolCall`（approval / allowedRoots 越界检查）模型平移到云端，作为云端工具执行的前置策略层。

## 4. 沙箱选型对比

| 维度 | E2B（SaaS） | Daytona（SaaS） | 自建 Docker 沙箱池 |
|---|---|---|---|
| 接入成本 | 最低，AI agent 生态事实标准，SDK 成熟 | 低，SDK 简洁 | 高（镜像、池化、调度、回收自研） |
| 隔离强度 | Firecracker microVM 级 | 容器 / microVM | 取决于自身（需配 gVisor / Kata） |
| 成本模型 | 按秒计费，弹性 | 按秒计费 | 服务器固定成本，规模化后更省 |
| 数据主权 | 第三方云 | 第三方云 | 完全自控，可内网部署 |
| 适用 | **P0–P1 起步首选** | 备选 | P3 或企业私有化版本演进 |

**推荐**：P0 用 E2B 快速验证，通过 SandboxProvider 抽象保留切换/自建能力。

## 5. 分阶段计划（每阶段含验证标准）

| 阶段 | 交付物 | 验证标准 |
|---|---|---|
| **P0**（1–2 周）沙箱抽象层 + 云端执行工具 | SandboxProvider 接口；E2B 适配器；`cloud_run_code` 内置工具注册进 registry；SandboxSettings 配置页（preferenceSchemas 加键） | 单测 mock provider 全绿；桌面端真实执行「Python 计算 + 文件生成」并取回产物 |
| **P1**（4–6 周）云端 Agent Runtime + 网关 | 从 `src/main/ai` 抽取 headless 编排服务；网关（鉴权/配额/WS 流式）；服务端 MCP（仅 streamable-http）；任务/会话表落 Postgres | wscat 端到端触发任务，工具调用与 token 流实时回传；沙箱空闲超时自动回收 |
| **P2**（4–6 周）移动端 + 任务控制台 | RN 壳（复用 aiCore）；任务列表/发起/审批/流式对话；设备配对 + 推送；密钥经网关代理 | 手机发起「抓网页→云端分析→生成报告」全流程；锁屏后任务继续执行并推送结果 |
| **P3**（持续）数据云端化 + 多端协同 | 知识库/文件 pipeline 上云；桌面-移动会话同步；Web 控制台；配额计费与审计；可选自建沙箱池 | 双端同账号会话状态一致；移动端知识库问答可用 |

## 6. 关键决策点（需拍板）

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 编排位置 | 客户端编排（密钥不出端） vs 云端编排（支持离线长任务） | 渐进式：P0–P1 客户端编排，P2 切云端 |
| D2 | 沙箱供应商 | E2B / Daytona / 自建 | E2B 起步 + Provider 抽象兜底 |
| D3 | 模型密钥归属 | BYOK 经网关代理转发 vs 云端托管密钥 | 网关代理转发，密钥不落沙箱环境变量 |
| D4 | 云端数据库 | 云端 Postgres 与端侧 SQLite 双 schema 维护 | 共享 Drizzle schema 定义 + 分方言迁移目录，接受双轨成本 |

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Prompt injection 导致沙箱内数据外泄 | 高 | 沙箱默认 egress 白名单/默认断网模式；secrets 不注入沙箱；复用 policy 层做执行前审批 |
| 双运行时（本地 dsh + 云端 sandbox）维护成本 | 中 | 统一收敛到工具注册表之后，对 Agent 层透明 |
| 沙箱成本失控 | 中 | 空闲 5 分钟强制回收 + 用户级配额 + 用量面板 |
| 端云 schema 漂移 | 中 | Drizzle 单一 schema 源，CI 校验双迁移目录一致性 |
| 网关成为单点 | 中 | P1 起即容器化部署，预留水平扩展（无状态网关 + Redis 会话） |

## 8. 建议下一步

1. 评审确认 D1–D4 决策点；
2. 确认后按 TDD 启动 P0：先写 SandboxProvider 契约测试（RED），再实现接口与 E2B 适配器（GREEN），最后接入工具注册表与设置页；
3. P0 验收通过后进入 P1 方案细化（网关技术栈建议与 message-service-center 的 NestJS 栈对齐，降低维护心智）。
