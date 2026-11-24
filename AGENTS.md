CLAUDE.md

企业共享空间只读管理查看使用独立 `KnowledgeInspection`、固定 GET `/api/v1/client/knowledge/inspection/**` 及专用 IPC 契约。仅 management-java 当前企业 OWNER/ADMIN，主进程每次在线核验并固定身份租约凭据，Java再次校验。管理目录只存在知识库页面状态，禁止写入 useOrgKnowledge.catalog、聊天选择或搜索授权；切身份/企业/角色/分类清除范围及选中项，迟到响应丢弃。内容只读 ready 文件解析正文/分块，不提供原件、上传、删除、策略或分享写入；问答沿用既有授权，管理查看不映射角色。关系显示真实分享人/领取人，不暴露分享码/密码/地址，邀请更新时间不冒充接受时间。回归见 KnowledgeInspection.test.ts、KnowledgeInspection.test.tsx、OrgKnowledgeNavigation.test.tsx；定制契约为 enterprise-shared-space-view，文档见 docs/references/enterprise/knowledge-space-administrators.md。

Cowork 自动模型绑定使用 `/api/v1/client/model/config` 完整快照与原始 `token` 头，一个 Key 对应一个自动服务商。每次登录或恢复登录首次在线验证成功后仅尝试同步一次，周期在线校验、网络恢复及授权通知不重复拉取；失败保留旧配置，下次登录再尝试。后端以 `coworkAutoBindEnabled` 显式控制 Key 是否参与返回，新建及历史 Key 默认关闭；在后端筛选后读取明文，客户端只接收已开启且授权有效的完整配置列表。Key 仅首次导入，已存在绑定不覆盖本地名称、地址、密钥、协议、模型列表及工具等能力；后台配置调整需删除自动项后重新登录导入。开关不影响 Key 的其他调用用途；关闭后下次登录成功同步时停用自动项，重新开启同一 Key 保持配置 ID 并仅恢复停用状态；客户端删除自动项不记录忽略状态。绑定按认证来源、实例、用户、企业及配置 ID 隔离；网络返回后校验身份租约并原子保存新增项及授权状态，禁止按名称认领手动项或覆盖用户默认模型。完整快照缺失项及旧企业绑定停用但保留历史引用，账号在线授权校验独立保留。Java及sub2api接口和开关代码已实现，管理Vue在API Keys创建及编辑弹窗提供自动绑定开关、列表展示开关状态，已完成受控桌面及手机验证；需手工迁移与部署，桌面完整链路待验收，契约见 `docs/references/enterprise/client-model-binding-api.md`，回归见 `JavaModelConfigClient.test.ts`、`CoworkModelConfigSync.test.ts` 和 `EnterprisePlugin.test.ts`。

Java 企业资源统一使用 `/api/v1/client/knowledge/**`、`/api/v1/client/skill/**`、`/api/v1/client/mcp/**` 与 `/api/v1/client/file/view/{fileCode}`；客户端请求省略 `scope`，权限由服务端客户端上下文及实时分组授权确定。列表、详情、文件、生命周期、个人分享及取消续作均不得回退旧 PC 管理入口。登录、企业切换、版本分发和外部第三方接口沿用各自协议。路由回归见 `JavaClientResourceRoutes.test.ts`，流式上传另由 `JavaKnowledgeUpload.test.ts` 验证。

成员候选 `/api/v1/client/knowledge/member/options` 仅传可选的 `keyword`、`page`、`pageSize`，不传 `knowledgeId`；当前企业由服务端会话确定。协作者面板仍保留 `baseId` 标识与当前身份下本地分享关联的完成状态校验。

指定人邀请检索失败时收起候选层并完整展示错误；本地共享关联未完成时由用户明确启动上传，全部确认成功后再重试原候选查询，不将失败展示为空结果。

个人库分享取消续作：再次分享前必须检查同一副本的取消日志，未知删除只经Java的localShare/state核查本人3/local墓碑，再调用localShare/finishRemoval补清理授权，不调用已移除的operation接口，不重放Space删除。历史类型、缺失或无权均保留关联及资料；恢复库不同于原库时要求从最终恢复库重开。关键契约与回归维护在.mea/customizations.yml的enterprise-knowledge-page条目。


知识库逐库管理角色由Java配置分组，客户端仅按服务端editable显示内容上传/删除，knowledgeRole和knowledgeRoleDescription传递角色，spaceAdministrator只作旧版内容管理标记，不能扩大读取或问答范围。公共创建及网页管理仅当前企业management-java OWNER/ADMIN开放，主进程重新核查角色；固定URL不含Token，浏览器正常登录并核对用户/企业。MAIN_VITE_ORG_WEB_BASE_URL为构建期管理前端地址，缺省复用管理服务根地址。公共/分享库原件上传逐文件流式走/client/knowledge/file/upload，未知结果停止且不自动重发；个人库创建和本人分享的预计算流程保持既有契约。实现及验证见 docs/references/enterprise/knowledge-space-administrators.md。

知识库角色使用Java KnowledgeRoleEnum稳定编码：1=空间管理员仅预留，2=知识管理员，3=空间成员按既有读取授权派生不落库；角色等级不替代editable/manageable。客户端按knowledgeRole本地化展示，旧服务端spaceAdministrator=true兼容显示知识管理员。
