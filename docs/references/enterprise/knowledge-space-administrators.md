---
description: 知识库分组角色的客户端内容维护、网页管理跳转和验证约定
sources:
  - src/main/enterprise/KnowledgeContentCommands.ts
  - src/main/enterprise/KnowledgeWebManagement.ts
  - src/main/enterprise/OrgKnowledgeService.ts
  - src/shared/ipc/schemas/enterpriseKnowledge.ts
  - src/shared/data/types/enterpriseKnowledge.ts
  - src/main/enterprise/JavaKnowledgeClient.ts
  - src/renderer/pages/knowledge/components/OrgKnowledgeDetail.tsx
  - src/renderer/pages/knowledge/components/KnowledgeSourceUpload.tsx
  - src/renderer/pages/knowledge/components/KnowledgeWebButton.tsx
---

# 知识库分组角色与网页管理

## 权限与入口

Java 和 Web 按每个公共库或个人库分享副本配置知识管理员分组。客户端只使用服务端 `editable` 判断内容维护权；`knowledgeRole` 和 `knowledgeRoleDescription` 传递角色，客户端按编码本地化展示；`spaceAdministrator` 仅兼容旧服务端。授权不会额外增加可读目录或问答范围，公共库仍需本人分组可见，分享库仍需实际所有者、成员或领取授权。

知识管理员可以上传文件、文件夹并删除库内全部内容，不限本人上传；该角色不获得整库修改、删除、策略、分享或授权配置权。本人分享保留已有本地预计算上传流程；其他可维护空间使用原生选择文件、文件夹，原件交给 Space 按本库策略解析。

个人库创建对所有企业角色一致。`management-java` 当前企业 OWNER/ADMIN 在公共分类看到“创建知识库”，在详情看到“网页管理”；普通成员不显示这些入口。没有“共享空间巡检”配置。

## 网页跳转配置

构建客户端时设置 `MAIN_VITE_ORG_WEB_BASE_URL` 为管理 Web 根地址，例如 `https://cowork.example.com/`。前后端分开部署时必须设置为实际前端地址；未设置时复用 `MAIN_VITE_ORG_SERVER_BASE_URL`。仅接受无用户名、密码、查询串和片段的 HTTP/HTTPS 地址，可包含部署子路径。

主进程重新核查有效会话及当前企业角色，只生成固定 `/knowledge` 或 `/knowledge/{UUID}` 路由。URL 仅传 `clientUserId`、`clientTenantId` 和创建表单意图 `category=public&action=create`，不传 Token。浏览器沿用正常登录流程；Web 确认用户及企业与客户端一致后才加载目标或打开表单，不自动切换企业或提交创建。

## 上传与结果核查

主进程逐文件流式调用 `/api/v1/client/knowledge/file/upload`，文件夹使用 `folder/add` 保留层级，每次写入前读取详情复核 `editable`，同时核对身份租约和返回归属。拒绝符号链接及超过100层的目录，服务端文件类型、大小和解析策略继续生效。

同一身份、企业、知识库只允许一个原件上传批次。取消文件选择不显示上传成功；上传响应只确认已受理，解析完成状态以目录为准。中途错误或未确认结果立即停止，可能已经写入的内容保留，刷新核查后再人工选择，禁止自动重传。切换账号、企业或撤权后，旧界面状态和迟到回调不得恢复权限。

## 验证

运行 `KnowledgeContentCommands.test.ts`、`KnowledgeWebManagement.test.ts`、`OrgKnowledgeService.javaWrite.test.ts`、`OrgKnowledgeDetail.test.tsx`、`OrgKnowledgeNavigation.test.tsx` 和 `useOrgKnowledge.test.ts`，核对上传归属、撤权、未知结果不重发、Web入口角色及URL凭据边界。

按仓库约定执行 `pnpm lint`、`pnpm mea:check`、`pnpm docs:check`，使用受控会话与本地文件，不连接业务服务。Java 的手工 SQL 升级、Web 配置界面及权限契约由后端 `docs/knowledge-space-administrators.md` 维护；此文档不表示已部署或完成真实环境验收。

## 知识库角色

Java通过 `tb_knowledge_group_role` 保存逐库分组角色，`KnowledgeRoleEnum` 定义1=空间管理员（预留）、2=知识管理员、3=空间成员（由已有读取权限派生、不落库）。当前配置入口仅写入角色2；旧授权表增量尚未执行，后端直接创建最终角色表，不进行旧表迁移。客户端不提供角色配置，不根据角色推断写权限，所有内容操作继续使用服务端 `editable`。

主进程将 `knowledgeRole` 与 `knowledgeRoleDescription` 传到IPC；渲染端使用角色编码和i18n显示身份。未知编码不显示角色，旧服务端只有 `spaceAdministrator=true` 时兼容显示“知识管理员”，不能当作预留的空间管理员。OWNER/ADMIN及创建者原有 `manageable` 与知识库角色独立，不自动映射为1。角色不会扩大公共库、分享库的可读或问答范围。
