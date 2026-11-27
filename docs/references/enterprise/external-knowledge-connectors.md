---
description: 外部知识库标签的点击查询、手动启停、企业实例范围与撤权更新边界
sources:
  - src/main/enterprise/ExternalKnowledgeConnectorCatalog.ts
  - src/main/enterprise/JavaKnowledgeConnectorClient.ts
  - src/renderer/pages/settings/McpSettings/McpCatalog.tsx
  - src/renderer/pages/settings/McpSettings/ExternalKnowledgeConnectorList.tsx
  - src/shared/ipc/schemas/enterprise.ts
  - src/shared/utils/externalKnowledgeConnector.ts
---

# 外部知识库连接器

Java企业登录的连接器一级标签为内置服务器、广场、我的MCP。广场下以二级标签切换企业共享和外部知识库，默认展示企业共享。仅显式进入或点击外部知识库时获取当前企业已启用且有合法mcp-key的Space接入实例，离开标签不停止运行；再次进入或再次点击已选标签重新查询。实例向全部有效企业成员开放，不按分组过滤。此目录不进入普通企业MCP授权缓存，不增加登录同步、后台轮询或工具调用时的成员强校验。

## 连接与刷新

- 新实例默认关闭，用户启动才创建本地MCP，使用现有streamableHttp运行时；用户停止只改变本客户端。
- 复用既有reference字段，`cowork-external-knowledge:`后为URI编码的JSON，固定issuerId、userId、tenantId、instanceId；安装来源保持manual，不新增SQLite迁移。
- 实例UUID决定来源身份，同名手动MCP不认领、不修改。外部项不重复显示在“我的MCP”目录，设置页仍能管理本地配置。
- 刷新更新名称、说明、地址和Key，保留用户开关；Key或地址变化断开旧会话，后续使用新配置，不自动启动新实例。
- 完整成功快照缺失项停用并清除本地Key。明确10007/10008停用当前来源、用户、企业范围内的外部项，保留其他来源。网络/超时/JSON/结构错误均保留旧配置，页面显示查询失败。
- 读取与写入使用身份租约和Profile写入栅栏，身份切换后的迟到响应不得落盘。启动握手失败回到关闭态，运行时异常原文不展示。

## 接口和凭据

主进程固定GET `/api/v1/client/knowledge/connectors/list`，原始token头，no-store，禁止重定向。成功 `data={userId,tenantId,items}`，items含UUID、kind、名称、说明、type、baseUrl、headers；主进程将mcp-key写入既有MCP存储，目录IPC只返回展示信息、本地serverId和isActive，设置页沿用既有MCP配置查看机制。Java从Space部署元数据生成对外连接地址；不向客户端下发上游服务credentials/defaults，不打印Key或配置。

Space实际调用继续使用mcp-key，未将Key与个人身份强绑定。用户被移出企业后，如果不点击标签，旧连接可能继续使用；点击后的明确拒绝或成功完整快照才更新本地状态。此版本不提供即时撤权。无需改Space或数据库，部署后需确认对外endpoint可从桌面客户端访问。

## 验证

主进程定向测试：`pnpm test:main src/main/enterprise/__tests__/ExternalKnowledgeConnectorCatalog.test.ts src/main/enterprise/__tests__/JavaKnowledgeConnectorClient.test.ts src/main/enterprise/__tests__/EnterprisePlugin.test.ts`，使用生产SQLite迁移与受控fetch/运行时。界面测试：`pnpm test:renderer src/renderer/pages/settings/McpSettings/__tests__/McpCatalog.test.tsx src/renderer/pages/settings/McpSettings/__tests__/ExternalKnowledgeConnectorList.test.tsx src/renderer/pages/settings/McpSettings/__tests__/McpServersList.test.tsx`。另执行pnpm lint、docs:check、mea:check及受控页面渲染验证，不操作实际企业数据。
