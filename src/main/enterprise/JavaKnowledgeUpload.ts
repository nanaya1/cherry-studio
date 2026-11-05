import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'

import type { JavaKnowledgeClient } from './JavaKnowledgeClient'

const KNOWLEDGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX32 = /^[0-9a-f]{32}$/
// 服务端 fileName 校验为 [^/\\\p{Cntrl}]+；客户端提前拒绝，不静默改名。
const ILLEGAL_FILE_NAME = /[\p{Cc}/\\]/u

export interface JavaKnowledgeUploadParams {
  /** 目标知识库 ID（36 位带横线 UUID）。 */
  knowledgeId: string
  /** 文件展示名；服务端规则校验，非法直接拒绝，不静默改名。 */
  fileName: string
  /** 预计算分块，顶层非空数组（逐块含 chunk_id 等）。 */
  chunks: unknown[]
  /** 原件本地路径；缺省视为仅上传元数据（不发送原件字节）。 */
  filePath?: string
  /** 目标目录 ID（32 位十六进制），缺省置于根目录。 */
  parentId?: string | null
  /** 是否随附原件字节；缺省为 filePath 存在时 true。 */
  uploadOriginal?: boolean
  /** 原件 SHA-256 hex，用于流式上传期间的指纹校验；缺省不比对。 */
  expectedHash?: string
  /** 原件大小（字节）；缺省且有 filePath 时按文件 stat 推断。 */
  fileSize?: number
  /** 取 token 后、发请求前的账号租约守卫；抛错即中止发送。 */
  beforeSend?: () => void
  /** 原件累计字节；元数据模式报告逻辑文件大小，不含 multipart 开销。 */
  progress?: (bytes: number) => void
  signal?: AbortSignal
}

export interface JavaKnowledgeUploadResult {
  knowledgeId: string
  fileId: string
  chunkCount: number
}

function assertAttribution(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`知识库${label}归属校验失败`)
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}无效`)
  }
  return value
}

function validateFileName(name: string): void {
  if (typeof name !== 'string' || !name.trim()) throw new Error('文件名称不能为空')
  if (name.length > 250) throw new Error('文件名称超长')
  if (ILLEGAL_FILE_NAME.test(name)) throw new Error('文件名称不合法')
}

/**
 * Java 原生预计算分块流式上传：组合 JavaKnowledgeClient.uploadMultipart 传输，
 * 流式读取原件（不整文件缓冲），camelCase 字段 id/fileName/chunksFile/file/parentId，
 * scope=client 查询参数；保持原件 SHA-256 指纹与大小一致性校验。
 * 未知结果不自动重发。
 */
export async function uploadJavaKnowledgeFile(
  client: JavaKnowledgeClient,
  params: JavaKnowledgeUploadParams
): Promise<JavaKnowledgeUploadResult> {
  if (!KNOWLEDGE_UUID.test(params.knowledgeId)) throw new Error('知识库ID格式无效')
  if (params.parentId != null && !HEX32.test(params.parentId)) throw new Error('父目录ID格式无效')
  validateFileName(params.fileName)
  if (!Array.isArray(params.chunks) || params.chunks.length === 0) throw new Error('预计算分块不能为空')

  const uploadOriginal = params.uploadOriginal ?? Boolean(params.filePath)
  if (uploadOriginal && !params.filePath) throw new Error('随附原件时缺少原件路径')

  let fileSize = params.fileSize ?? 0
  if (uploadOriginal && params.filePath && params.fileSize == null) {
    fileSize = statSync(params.filePath).size
  }

  const boundary = `mea-${randomUUID()}`
  const idField = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${params.knowledgeId}\r\n`
  )
  const parentField = params.parentId
    ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${params.parentId}\r\n`)
    : Buffer.alloc(0)
  // fileName + chunksFile(JSON) 作为两个独立 multipart 部分。
  const metaPrefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${params.fileName}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="chunksFile"; filename="chunks.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(params.chunks)}\r\n`
  )
  // 与 fetch/FormData 的 multipart 编码一致；控制字符已由文件名校验拒绝。
  const encodedFileName = params.fileName.replace(/"/g, '%22')
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodedFileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  )
  // 元数据模式末端不补前缀换行；原件模式在原件字节后补 \r\n 再闭合边界。
  const suffix = Buffer.from(`${uploadOriginal ? '\r\n' : ''}--${boundary}--\r\n`)

  const contentLength =
    idField.length +
    parentField.length +
    metaPrefix.length +
    (uploadOriginal ? fileHeader.length + fileSize : 0) +
    suffix.length

  async function* body(resetTimeout: () => void, signal: AbortSignal): AsyncIterable<Uint8Array> {
    signal.throwIfAborted()
    yield idField
    yield parentField
    yield metaPrefix
    if (uploadOriginal && params.filePath) {
      yield fileHeader
      let bytes = 0
      const fingerprint = createHash('sha256')
      for await (const chunk of createReadStream(params.filePath, { signal })) {
        signal.throwIfAborted()
        const buf = chunk as Buffer
        fingerprint.update(buf)
        bytes += buf.length
        if (bytes > fileSize) throw new Error('上传期间文件大小发生变化')
        resetTimeout()
        params.progress?.(bytes)
        signal.throwIfAborted()
        yield buf
      }
      if (bytes !== fileSize) throw new Error('上传期间文件大小发生变化')
      if (params.expectedHash && fingerprint.digest('hex') !== params.expectedHash) {
        throw new Error('上传期间文件内容发生变化，结果需核对')
      }
    } else {
      // 元数据模式单跳到满进度，不读取原件字节，不套总超时。
      resetTimeout()
      params.progress?.(fileSize)
    }
    signal.throwIfAborted()
    yield suffix
  }

  const data = (await client.uploadMultipart(
    '/api/v1/knowledge/file/importChunks?scope=client',
    `multipart/form-data; boundary=${boundary}`,
    contentLength,
    body,
    params.beforeSend,
    params.signal
  )) as Record<string, unknown>

  const knowledgeId = String(data.knowledgeId)
  const fileId = String(data.fileId)
  const chunkCount = safeInteger(data.chunkCount, '分块数')
  if (!KNOWLEDGE_UUID.test(knowledgeId)) throw new Error('上传响应知识库ID无效')
  if (!HEX32.test(fileId)) throw new Error('上传响应文件ID无效')
  if (chunkCount < 1) throw new Error('上传响应分块数无效')
  // 响应归属校验：返回 knowledgeId 须与请求一致。
  assertAttribution(knowledgeId, params.knowledgeId, '文件')
  if (chunkCount !== params.chunks.length) throw new Error('上传响应分块数与请求不一致，结果需核对')
  return { knowledgeId, fileId, chunkCount }
}
