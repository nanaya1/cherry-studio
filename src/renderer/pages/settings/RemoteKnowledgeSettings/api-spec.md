# 远端知识库服务对接接口规范

> 版本：1.0（2026-09-21） · 适用对象：为 MEA Cowork 桌面端提供「远端知识库检索」能力的服务端开发者

## 1. 概述

MEA Cowork 桌面端支持将外部知识服务挂载为「远端知识库」，在助手/Agent 的知识检索中调用。服务端只需实现本规范的 **4 个 HTTP 接口**，即可被桌面端发现、绑定和检索。

**能力边界（v1）**：

- 只读检索：服务发现、语义搜索、文档/分片读取。
- 不包含：文档写入、同步、删除、账号体系对接（后续版本再议）。
- 多知识库：一个服务可暴露多个知识库（base），客户端一次搜索可跨多个 base。

**调用方式**：请求由桌面客户端应用层直接发起（非浏览器环境），因此：

- 服务端**无需处理 CORS**。
- 无 Cookie/会话语义，认证完全依赖请求头（见 §3）。

## 2. 基础约定

| 约定 | 值 |
|---|---|
| Base URL | 部署时由用户在客户端配置，必须为 `http(s)` URL；生产环境建议 HTTPS |
| 路径前缀 | `/v1`（版本前缀，见 §8） |
| 编码 | 请求/响应均为 UTF-8 JSON；POST 请求带 `Content-Type: application/json` |
| 字段命名 | 线上协议字段一律 **snake_case** |
| 超时 | 客户端强制超时，默认 **30 秒**（用户可配置 1s–300s）；服务端应在超时窗口内响应，搜索接口建议 < 5s |
| 重试 | 客户端**不做自动重试**；失败直接呈现给用户 |
| 分页 | v1 无分页。`bases` 一次性返回全部；`search` 用 `top_k` 限制条数 |

## 3. 认证

客户端在**所有请求**（含 health）上按用户配置附带以下认证头之一：

| 客户端发送 | 说明 |
|---|---|
| `Authorization: Bearer <api_key>` | 推荐 |
| `X-API-Key: <api_key>` | |

补充规则：

- 用户未填写 key 时，客户端**不发送**认证头；匿名访问策略由服务端自行决定（如公开只读目录）。
- 用户还可配置**自定义请求头**（键值对），会合并到所有请求上，可用于网关路由、租户标识等；自定义头不可覆盖认证头。
- 认证失败建议返回 `401` + 错误信封（§5），客户端会把 `code: message` 原样呈现给用户。

## 4. 接口定义

### 4.1 健康检查

```
GET /v1/health
```

- **用途**：用户在客户端配置服务后点「测试连接」时调用；也用于探测服务可用性。
- **成功**：任意 `2xx` 状态码即视为健康。响应体不约束（可为空对象 `{}`）。
- **失败**：非 2xx / 网络错误 / 超时 → 客户端报连接失败并展示错误信息。

```bash
curl -H "Authorization: Bearer sk-xxx" https://kb.example.com/v1/health
# HTTP 200 {}
```

### 4.2 知识库列表

```
GET /v1/knowledge/bases
```

- **用途**：客户端拉取该服务下**可检索的知识库**列表，供用户勾选绑定到助手/Agent。
- **响应** `200`：

```json
{
  "bases": [
    { "id": "prod-docs", "name": "产品文档库", "description": "2026 年产品手册" },
    { "id": "faq", "name": "FAQ" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `bases` | array | 是 | 可为空数组（服务暂无可用库） |
| `bases[].id` | string | 是 | 知识库标识，**在服务内唯一且稳定**；原样回传，不做编码约束 |
| `bases[].name` | string | 是 | 展示名 |
| `bases[].description` | string | 否 | 一句话描述 |

### 4.3 语义搜索（核心）

```
POST /v1/knowledge/search
Content-Type: application/json
```

**请求**：

```json
{
  "query": "如何配置企业登录",
  "base_ids": ["prod-docs", "faq"],
  "top_k": 8,
  "rerank": true,
  "filters": { "category": "deployment" }
}
```

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `query` | string | 是 | trim 后 1–1000 字符 | 查询文本 |
| `base_ids` | string[] | 是 | 1–32 个 | 要检索的知识库，值来自 §4.2 的 `id` |
| `top_k` | int | 否 | 1–50 | 期望返回条数 |
| `rerank` | boolean | 否 | — | 提示服务端做重排 |
| `filters` | object | 否 | — | 不透明透传的过滤条件，**格式由服务端自定义**（如分类、时间、标签） |

**响应** `200`：

```json
{
  "chunks": [
    {
      "chunk_id": "doc-123#c3",
      "base_id": "prod-docs",
      "document_id": "doc-123",
      "title": "企业登录配置指南",
      "content": "企业登录需要在管理端配置回调域名……",
      "score": 0.87,
      "source": { "url": "https://kb.example.com/docs/doc-123", "path": "deployment/login.md" },
      "metadata": { "author": "docs-team", "updated_at": "2026-09-01" }
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `chunks` | array | 是 | 可为空数组（无命中） |
| `chunks[].chunk_id` | string | 是 | 分片标识，`read` 接口会用到 |
| `chunks[].base_id` | string | 是 | 必须回显所属库 id（客户端跨库检索时用于归因） |
| `chunks[].document_id` | string | 是 | 所属文档标识，`read` 接口会用到 |
| `chunks[].title` | string | 是 | 展示标题（可为文档标题或分片标题） |
| `chunks[].content` | string | 是 | 分片正文 |
| `chunks[].score` | number | 是 | 相关性得分，**归一化到 [0, 1]**，越大越相关（客户端会钳制越界值） |
| `chunks[].source` | object | 否 | `{url?, path?}`，来源链接或文件路径，客户端用于展示/跳转 |
| `chunks[].metadata` | object | 否 | 任意附加元数据，客户端透传展示 |

**客户端容错行为**（服务端无需处理，但应知晓）：

- 客户端按 `top_k` 截断结果；请求未带 `top_k` 时客户端只保留前 **8** 条。服务端应在 `top_k` 缺省时返回自己的合理默认条数。
- 单个 chunk 字段非法（缺必填字段/类型错误）时**跳过该条**，不影响其他结果。
- 未知字段一律忽略。

### 4.4 文档/分片读取

```
POST /v1/knowledge/read
Content-Type: application/json
```

**请求**：

```json
{ "base_id": "prod-docs", "document_id": "doc-123" }
```

```json
{ "base_id": "prod-docs", "document_id": "doc-123", "chunk_id": "doc-123#c3" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `base_id` | string | 是 | 知识库 id |
| `document_id` | string | 是 | 文档 id |
| `chunk_id` | string | 否 | 提供时返回该分片的**扩展上下文**（推荐前后相邻内容合并）；缺省时返回整篇文档 |

**响应** `200`：

```json
{
  "document_id": "doc-123",
  "title": "企业登录配置指南",
  "content": "整篇（或扩展上下文）正文……",
  "total_chars": 15230,
  "truncated": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `document_id` | string | 是 | 回显 |
| `title` | string | 是 | 文档标题 |
| `content` | string | 是 | 正文 |
| `total_chars` | int | 否 | 原文总字符数（`truncated: true` 时建议提供） |
| `truncated` | boolean | 否 | 内容是否被截断。**长文档应截断而非报错**，给足 `total_chars` 即可 |

## 5. 错误信封（服务端必须遵守）

所有非 2xx 响应应返回如下 JSON 结构：

```json
{
  "error": {
    "code": "base_not_found",
    "message": "知识库 prod-docs 不存在或无权访问"
  }
}
```

- `code`：稳定的机器可读错误码，**自由字符串**（客户端原样透传，不做枚举校验）。建议使用 `snake_case`，如 `unauthorized`、`base_not_found`、`document_not_found`、`rate_limited`、`internal_error`。
- `message`：面向用户可直接阅读的中文/本地化描述。
- **建议状态码**：`400` 请求参数不合法（如 `query` 超长、`base_ids` 为空）、`401` 认证失败、`404` 知识库/文档不存在、`429` 触发限流、`5xx` 服务内部错误。

客户端对不符合信封的错误响应统一降级显示为 `upstream_error: HTTP <status>`；客户端自身超时与网络故障分别显示 `request_timeout` / `network_error`。降级后用户看不到具体原因，因此**强烈建议所有错误都走信封**。

## 6. 兼容性规则

客户端对响应采用**宽松解析**（这是为了向前兼容，不是放宽服务端要求）：

- ✅ 服务端可随时**新增可选字段**（顶层或 chunk 内），客户端忽略不认识的字段。
- ❌ 服务端**不得**更改既有字段名、类型、语义（如把 `score` 改成百分制、把 `chunks` 改名）。
- 客户端发出的请求是**严格结构**：服务端应忽略请求中的未知字段，不得因多余字段报错。
- 破坏性变更（删除/改名字段、改变语义）必须升级路径前缀（`/v2`），并建议并行维护 `/v1` 过渡期 ≥ 6 个月。

## 7. 限制汇总

| 项 | 值 | 来源 |
|---|---|---|
| `query` 长度 | 1–1000 字符（trim 后） | 客户端校验 |
| 单次检索 `base_ids` 数量 | 1–32 | 客户端校验 |
| `top_k` | 1–50；缺省时客户端截断到 8 | 客户端校验/截断 |
| `score` 范围 | [0, 1]，越界被钳制 | 客户端钳制 |
| 请求超时 | 30s（用户可配 1–300s） | 客户端强制 |
| 单库文档规模 | 无协议限制；超大文档用 `truncated` + `total_chars` | 建议服务端实现 |

服务端如需自身的限流/配额，返回 `429` + 错误信封即可（建议 `code: "rate_limited"`）。

## 8. 版本策略

- 当前版本：`/v1`。
- 兼容变更（可随时发布）：新增可选响应字段、新增错误码、新增可选请求字段（客户端会忽略）。
- 不兼容变更：升 `/v2`，`/v1` 并行过渡 ≥ 6 个月。

## 9. 服务端实现检查清单

- [ ] 四个端点路径与方法与 §4 一致（`GET /v1/health`、`GET /v1/knowledge/bases`、`POST /v1/knowledge/search`、`POST /v1/knowledge/read`）
- [ ] 所有响应 `application/json; charset=utf-8`，字段 snake_case
- [ ] 同时接受 `Authorization: Bearer` 与 `X-API-Key` 两种认证头（按用户配置二选一），未带 key 的请求按服务策略处理
- [ ] health 在携带认证头时正常返回 2xx
- [ ] `search` 支持 `base_ids` 跨库检索，每个 chunk 回显 `base_id`
- [ ] `score` 归一化 [0, 1]
- [ ] `read` 支持 `chunk_id` 扩展上下文与长文档 `truncated` 截断
- [ ] 所有错误返回 §5 信封（含 400/401/404/429/5xx）
- [ ] 请求处理时间 < 客户端超时（建议 P99 < 5s）
- [ ] 忽略请求与响应中的未知字段（向前兼容）
