---
description: 知识库分组角色、网页管理跳转与企业共享空间只读查看约定
sources:
  - src/main/enterprise/KnowledgeInspection.ts
  - src/main/enterprise/KnowledgeInspectionClient.ts
  - src/shared/data/types/knowledgeInspection.ts
  - src/renderer/pages/knowledge/components/KnowledgeInspectionDetail.tsx
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

## 企业全部共享空间只读查看

当前企业 OWNER/ADMIN 在「分享给我」增加「我收到的 / 企业全部」。全部范围通过独立 GET `/api/v1/client/knowledge/inspection/**` 分页读取当前企业未删除的非公共知识库，包括没有领取人的分享副本和未归类库。公共库仍使用公共分类，普通成员不显示范围切换。

详情以现有 DetailHeader、知识库表格和文件预览布局展示「文档内容 / 分享关系」，支持查看已启用目录、ready 正文及分块，并通过独立的 `/inspection/file/preview-url` 查看已保存原件的转换 PDF。正文是纯文本，超限有截断提示并支持分块分页。关系分别查询实际邀请、链接及领取人，分页展开；不展示分享码、密码、地址或已删除关系。真实邀请人/链接创建者缺失时不回填空间创建者，邀请只显示真实更新时间。链接次数耗尽仅限制新领取，不撤销既有领取，过期或吊销与实际授权分别展示。

`qaAuthorized` 按原有访问事实提示是否可问答；管理目录不加入普通 catalog、聊天选择器或搜索范围。此入口不提供原件下载、编辑、上传、删除、策略和分享写操作，不新增巡检配置或角色。其他既有页面入口保持原规则。

主进程 KnowledgeInspection 每次在线核验有效管理角色，以租约固定会话凭据；请求和失效回调都复核原身份，迟到失效响应不能清除新会话。渲染端单独维护范围和选中空间，身份/企业/角色或分类变化即清空，查询失败显示错误，异步旧结果不回填。

自动化回归：`KnowledgeInspection.test.ts`、`KnowledgeInspection.test.tsx`、`OrgKnowledgeNavigation.test.tsx`、`enterpriseKnowledge.test.ts`，同时验证普通目录和聊天选择范围。若 `pnpm test:main` 的预重建因正在使用的 SQLite 原生模块被锁失败，本组不依赖 SQLite，可直接使用 `pnpm exec vitest run --project main <测试路径>` 执行，不中断其他进程或改写用户数据。完整类型、格式和多语言检查沿用 `pnpm lint`。本次无客户端存储迁移、后端 SQL 或新增配置。

## 知识库角色

Java通过 `tb_knowledge_group_role` 保存逐库分组角色，`KnowledgeRoleEnum` 定义1=空间管理员（预留）、2=知识管理员、3=空间成员（由已有读取权限派生、不落库）。当前配置入口仅写入角色2；旧授权表增量尚未执行，后端直接创建最终角色表，不进行旧表迁移。客户端不提供角色配置，不根据角色推断写权限，所有内容操作继续使用服务端 `editable`。

主进程将 `knowledgeRole` 与 `knowledgeRoleDescription` 传到IPC；渲染端使用角色编码和i18n显示身份。未知编码不显示角色，旧服务端只有 `spaceAdministrator=true` 时兼容显示“知识管理员”，不能当作预留的空间管理员。OWNER/ADMIN及创建者原有 `manageable` 与知识库角色独立，不自动映射为1。角色不会扩大公共库、分享库的可读或问答范围。
