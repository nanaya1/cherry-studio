CLAUDE.md

Java 企业资源统一使用 `/api/v1/client/knowledge/**`、`/api/v1/client/skill/**`、`/api/v1/client/mcp/**` 与 `/api/v1/client/file/view/{fileCode}`；客户端请求省略 `scope`，权限由服务端客户端上下文及实时分组授权确定。列表、详情、文件、生命周期、个人分享及取消续作均不得回退旧 PC 管理入口。登录、企业切换、版本分发和外部第三方接口沿用各自协议。路由回归见 `JavaClientResourceRoutes.test.ts`，流式上传另由 `JavaKnowledgeUpload.test.ts` 验证。

成员候选 `/api/v1/client/knowledge/member/options` 仅传可选的 `keyword`、`page`、`pageSize`，不传 `knowledgeId`；当前企业由服务端会话确定。协作者面板仍保留 `baseId` 标识与当前身份下本地分享关联的完成状态校验。

指定人邀请检索失败时收起候选层并完整展示错误；本地共享关联未完成时由用户明确启动上传，全部确认成功后再重试原候选查询，不将失败展示为空结果。

个人库分享取消续作：再次分享前必须检查同一副本的取消日志，未知删除只经Java的localShare/state核查本人3/local墓碑，再调用localShare/finishRemoval补清理授权，不调用已移除的operation接口，不重放Space删除。历史类型、缺失或无权均保留关联及资料；恢复库不同于原库时要求从最终恢复库重开。关键契约与回归维护在.mea/customizations.yml的enterprise-knowledge-page条目。
