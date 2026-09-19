---
description: 远端知识库服务对外接口规范 v1.0，定义 health、knowledge bases、knowledge search、knowledge read 四个 HTTP 端点的请求响应契约、认证方式与统一错误模型，供外部知识库服务提供方适配接入
sources: []
---

# 远端知识库服务接口规范 v1.0

> 对外契约文档 · 面向外部知识库服务提供方

本文档定义客户端「远端知识库服务」接入所需的 **HTTP 接口契约**。外部知识库服务提供方按本文档实现下述 4 个端点后，即可被本客户端（MEA Cowork / cherry-studio 的 `feature/remote-knowledge-service` 分支）接入：用户在客户端配置服务的 `baseUrl` 与凭据，客户端把 `kb_*` 检索工具的远端部分路由到该服务执行。

本规范为 **v1.0**，仅包含检索与溯源能力；写操作、大纲浏览、文档内 grep 不在范围内（见[第八章](#八兼容性与扩展)）。配套方案背景见 `./contrib/remote-knowledge-service-plan.md`。

---

## 一、通用约定

所有端点遵循以下统一约定：

| 项 | 约定 |
|----|------|
| 路径前缀 | 所有路径挂载在用户配置的 `baseUrl` 之下，统一以 `/v1` 开头（例如 `https://kb.example.com/v1/health`） |
| 请求/响应格式 | `Content-Type: application/json`；请求体为 JSON，响应体为 JSON |
| 字符编码 | UTF-8 |
| 请求体 | 仅 `POST` 端点需要 `body`；`GET` 端点无 `body` |
| 分数归一化 | 所有 `score` 均为 `[0, 1]` 区间的浮点数，数值越大表示相关性越高 |

### 1.1 认证

客户端按用户配置选择一种认证方式，服务方**必须**在全部端点（含 `/v1/health`）校验凭据：凭据缺失或失效必须返回 `401 unauthorized`，不得无条件返回成功。

| authType | 请求头 | 说明 |
|----------|--------|------|
| `bearer` | `Authorization: Bearer <token>` | 客户端配置为 Bearer 时发送 |
| `api_key` | `X-API-Key: <key>` | 客户端配置为 API-Key 时发送 |

> `oauth2` 为保留的 `auth_type` 枚举位，当前版本客户端不支持（配置时会提示「暂不支持」），服务方可忽略。详见[第八章](#八兼容性与扩展)。

### 1.2 约定续则

- 时间、单位以「毫秒」或 ISO 8601 字符串表示时，由服务方自行决定，客户端不依赖。
- 所有字符串字段使用 UTF-8 编码。
- 客户端不解释的字段（如 `filters`、`metadata`、`source`、`description`）一律原样透传或忽略，服务方可在语义允许范围内自由扩展其值。

---

## 二、端点 1：GET /v1/health

**用途**：连通性与认证校验。客户端「设置页 → 测试连接」按钮调用此端点，并依据响应延迟向用户展示连接质量。

**请求**：无 `body`，需携带[认证头](#11-认证)。

**成功响应** `200 OK`：

```json
{ "status": "ok" }
```

**要求**：
- 服务方**必须验证凭据**。若凭据缺失或失效，返回 `401 unauthorized`（错误模型见[第七章](#七错误模型)），不得在未认证时返回 `ok`。
- 该端点是凭据问题的唯一前置暴露点；客户端依赖其 `401` 及时发现配置错误。

**示例**：

```http
GET /v1/health
Authorization: Bearer <token>

HTTP/1.1 200 OK
Content-Type: application/json

{ "status": "ok" }
```

---

## 三、端点 2：GET /v1/knowledge/bases

**用途**：列出当前凭据**有权检索**的知识库清单。客户端将其展示给用户，供选择绑定到助手。

**请求**：无 `body`，需携带[认证头](#11-认证)。

**成功响应** `200 OK`：

```json
{
  "bases": [
    { "id": "kb-001", "name": "产品手册", "description": "V2 系列" }
  ]
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `bases` | array | 是 | 知识库列表 |
| `bases[].id` | string | 是 | 知识库原生 ID。**客户端不解释此值，仅回传**；客户端后续调用会将其拼接为 `remote:{serviceId}:{id}` 的方式记录，并把原生 `id` 原样传回本端点 |
| `bases[].name` | string | 是 | 知识库展示名称 |
| `bases[].description` | string | 否 | 知识库描述，不传可省略 |

**要求**：
- **仅返回该凭据有权检索的库**。权限收窄是服务端职责，客户端不做二次过滤。
- `bases: []` 是合法结果（该凭据无任何可检索库），与失败严格区分。

---

## 四、端点 3：POST /v1/knowledge/search

**用途**：核心检索端点。服务端负责执行「查询向量化 → 向量检索 → Rerank → 分数归一化」的完整链路，返回排序后的片段（chunk）列表。

**请求** `POST /v1/knowledge/search`（需携带[认证头](#11-认证)）：

```json
{
  "query": "如何重置设备的网络配置？",
  "base_ids": ["kb-001", "kb-002"],
  "top_k": 8,
  "rerank": true,
  "filters": { "lang": "zh", "doc_type": "manual" }
}
```

**请求字段**：

| 字段 | 类型 | 必填 | 约束 / 说明 |
|------|------|------|------|
| `query` | string | 是 | 检索查询，长度 `1..1000` 字符（超出视为 `invalid_request`） |
| `base_ids` | string[] | 是 | 目标知识库原生 ID 数组，长度 `1..32`；多个库即**跨库联邦检索**，服务端需聚合多库结果并统一排序返回 |
| `top_k` | int | 否 | 返回片段上限，默认 `8`，上限 `50`（超过 `50` 按 `50` 处理或返回 `invalid_request`，由服务方决定；建议截断为 `50`） |
| `rerank` | bool | 否 | 是否执行 Rerank，默认 `true`。无 Rerank 能力的服务可忽略此字段 |
| `filters` | object | 否 | 过滤条件，**客户端不解释、原样透传**；语义由服务方自定义，不支持可忽略 |

**成功响应** `200 OK`：

```json
{
  "chunks": [
    {
      "chunk_id": "c-9f3a",
      "base_id": "kb-001",
      "document_id": "doc-7",
      "title": "网络配置重置指南",
      "content": "进入「设置 → 网络」，长按「重置」按钮 3 秒即可恢复出厂网络配置……",
      "score": 0.93,
      "source": { "url": "https://kb.example.com/manual/network#reset" },
      "metadata": { "page": 12, "updated_at": "2026-08-01" }
    }
  ]
}
```

**响应 `chunks[].*` 字段**：

| 字段 | 类型 | 必填 | 约束 / 说明 |
|------|------|------|------|
| `chunk_id` | string | 是 | 片段唯一标识 |
| `base_id` | string | 是 | 片段所属知识库 ID，**必须与请求 `base_ids` 之一一致** |
| `document_id` | string | 是 | 片段所属文档 ID |
| `title` | string | 是 | 片段所属文档/章节标题 |
| `content` | string | 是 | 片段正文文本 |
| `score` | float | 是 | 相关性分数，区间 `[0, 1]`，结果按 `score` **降序**排列 |
| `source` | object | 否 | 来源定位，二选一：`{ "url": "..." }` 或 `{ "path": "..." }` |
| `metadata` | object | 否 | 任意键值对，**客户端不解释** |

**要求**：
- `chunks: []` 是合法空结果（未检索到内容），与失败严格区分。
- **响应 `chunks` 数量不得超过请求 `top_k`**。客户端会强制截断，但规范上要求服务端遵守该上限。
- 跨库（`base_ids` 多值）时，服务端应聚合各库检索结果，按统一 `score` 排序后整体返回，而非分库返回。
- `score` 应为校准后的相关性分数（Rerank 分优于原始向量距离），详见[第八章](#八兼容性与扩展)。

---

## 五、端点 4：POST /v1/knowledge/read

**用途**：按文档读取全文或指定片段的扩展上下文，用于追问溯源（用户点击检索结果查看出处原文）。

**请求** `POST /v1/knowledge/read`（需携带[认证头](#11-认证)）：

```json
{
  "base_id": "kb-001",
  "document_id": "doc-7",
  "chunk_id": "c-9f3a"
}
```

**请求字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `base_id` | string | 是 | 知识库原生 ID |
| `document_id` | string | 是 | 文档 ID |
| `chunk_id` | string | 否 | 片段 ID。传了则优先返回该片段及其**邻近扩展上下文**；不传则返回整篇文档 |

**成功响应** `200 OK`：

```json
{
  "document_id": "doc-7",
  "title": "网络配置重置指南",
  "content": "（整篇或扩展后的正文……）",
  "total_chars": 4200,
  "truncated": true
}
```

**响应字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `document_id` | string | 是 | 文档 ID |
| `title` | string | 是 | 文档标题 |
| `content` | string | 是 | 文档正文或扩展上下文文本 |
| `total_chars` | int | 否 | 原文总字符数（内容被截断时建议提供） |
| `truncated` | bool | 否 | 内容是否因过长被截断；截断时置 `true` 并建议给出 `total_chars` |

**要求**：
- 若 `base_id` / `document_id` 不存在，返回 `404 not_found`（错误模型见[第七章](#七错误模型)）。
- 内容过长时服务方可截断返回，并置 `truncated: true`。

---

## 六、端点对照速查

| # | 方法 | 路径 | 主要用途 |
|---|------|------|----------|
| 1 | GET | `/v1/health` | 连通性 / 认证校验（测试连接） |
| 2 | GET | `/v1/knowledge/bases` | 列出可检索知识库 |
| 3 | POST | `/v1/knowledge/search` | 核心检索（向量化→检索→Rerank→归一化） |
| 4 | POST | `/v1/knowledge/read` | 按文档读取 / 追问溯源 |

---

## 七、错误模型

全端点统一使用如下错误结构。成功响应不含 `error` 字段；只要发生错误，HTTP 状态码与 `error.code` 必须对应（映射见下表）。

**错误响应体**：

```json
{
  "error": {
    "code": "unauthorized",
    "message": "凭据缺失或失效"
  }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `error.code` | string | 错误码，取值见下表枚举 |
| `error.message` | string | 人类可读错误描述，可本地化，客户端仅展示不解释 |

**`code` ↔ HTTP 状态映射表**：

| `error.code` | HTTP 状态 | 触发场景 |
|--------------|-----------|----------|
| `unauthorized` | 401 | 凭据缺失 / 失效 / 格式错误 |
| `forbidden` | 403 | 认证通过，但该凭据无权访问所请求的资源 |
| `not_found` | 404 | 请求的资源不存在（如 `base_id` / `document_id` 不存在，或路径不存在且服务选择错误模型返回） |
| `invalid_request` | 400 | 请求参数非法（如 `query` 超长、`base_ids` 为空或超 32 个、`top_k` 类型错误） |
| `rate_limited` | 429 | 触发限流；可附带 `Retry-After` 响应头（秒数） |
| `upstream_error` | 5xx | 服务端内部故障，或服务端依赖的上游（向量库、模型服务等）故障 |

**说明**：
- 限流响应建议带 `Retry-After` 头：`Retry-After: 30`。
- 服务端内部错误统一归为 `upstream_error` 的 `5xx`，不应向客户端暴露内部堆栈。

---

## 八、兼容性与扩展

### 8.1 不在范围内的能力

以下能力**不要求**服务方实现，也无需为此新增端点：

- 大纲浏览（文档目录树）
- 文档内 grep / 全文检索式定位
- 写操作：文档的增、删、改（`kb_manage` 类的本地管理操作）

若服务方收到上述不支持的路径，返回 `501` 或错误模型 `upstream_error` 均可，客户端不会调用这些路径。

### 8.2 认证枚举位

- `auth_type` 的枚举包含 `bearer`、`api_key`，以及**保留位 `oauth2`**。
- 当前版本客户端**不支持 `oauth2`**：若用户在配置中选择 `oauth2`，客户端会直接报「暂不支持」，不会发起请求。服务方可忽略该枚举位。

### 8.3 分数语义

- 客户端会将**本地检索结果**与**多个远端服务**的结果进行混合排序，因此各远端服务返回的分数应具备可比性。
- 服务方应返回**校准过的相关性分数**：优先使用 Rerank 后的相关性分（优于原始向量距离 / 余弦相似度），并确保落在 `[0, 1]` 区间、数值越大越相关。
- 跨库联邦检索时，不同库的原始分数应统一标定后再合并排序。

### 8.4 客户端对字段的处理边界

- `bases[].id`、`chunks[].base_id`、`document_id`、`chunk_id` 等 ID 类字段：客户端**不解释**，仅原样存储与回传。
- `filters`、`metadata`、`source`：客户端**不解释**，原样透传或忽略；服务方可在语义允许范围内自由定义其结构。

---

## 九、附录：最小适配示例

以下两段示例仅用于跑通「接口形状」，重点是**字段名准确**；生产实现应补全认证校验、错误处理与真实检索逻辑。

### 9.1 Python（标准库 `http.server`）

```python
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/v1/health":
            # 真实实现需在此校验认证头
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"error": {"code": "not_found", "message": "path not found"}})

    def do_POST(self):
        if self.path == "/v1/knowledge/search":
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            chunk = {
                "chunk_id": "c-1",
                "base_id": req["base_ids"][0],
                "document_id": "doc-1",
                "title": "示例文档",
                "content": "这是一段示例检索片段。",
                "score": 0.92,
            }
            self._send(200, {"chunks": [chunk]})
        else:
            self._send(404, {"error": {"code": "not_found", "message": "path not found"}})

if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
```

### 9.2 TypeScript（Express 风格）

```typescript
import express from "express";

const app = express();
app.use(express.json());

app.get("/v1/health", (_req, res) => {
  // 真实实现需在此校验认证头
  res.json({ status: "ok" });
});

app.post("/v1/knowledge/search", (req, res) => {
  const { base_ids } = req.body as { base_ids: string[] };
  res.json({
    chunks: [
      {
        chunk_id: "c-1",
        base_id: base_ids[0],
        document_id: "doc-1",
        title: "示例文档",
        content: "这是一段示例检索片段。",
        score: 0.92,
      },
    ],
  });
});

app.listen(8080, () => console.log("remote KB service on :8080"));
```

---

> 版本：v1.0 · 状态：对外契约定稿 · 适用分支：`feature/remote-knowledge-service`
