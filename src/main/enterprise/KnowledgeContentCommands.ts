import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { dialog } from 'electron'

import { t } from '@main/i18n'

import { JavaKnowledgeError, type JavaKnowledgeClient } from './JavaKnowledgeClient'

/** 服务端详情实时确认内容权限，不能以OWNED分类或本地缓存替代。 */
export async function requireEditableKnowledge(client: JavaKnowledgeClient, id: string, active: () => void) {
  active()
  const space = await client.getSpace(id)
  active()
  if (space.id !== id || space.editable !== true)
    throw new JavaKnowledgeError(10007, t('enterprise.knowledge.content.forbidden'))
  return space
}

/** 原件逐文件流式直传；每次写入前复核权限，未知结果立即停止且不重发。 */
export async function uploadKnowledgeSource(
  client: JavaKnowledgeClient,
  id: string,
  parentId: string | undefined,
  kind: 'file' | 'directory',
  active: () => void
): Promise<boolean> {
  if (parentId !== undefined && !/^[0-9a-f]{32}$/.test(parentId))
    throw new Error(t('enterprise.knowledge.content.invalid_source'))
  await requireEditableKnowledge(client, id, active)
  const picked = await dialog.showOpenDialog({
    properties: kind === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections']
  })
  active()
  if (picked.canceled || picked.filePaths.length === 0) return false
  const visit = async (path: string, parent: string | undefined, depth: number): Promise<void> => {
    active()
    if (depth > 100) throw new Error(t('enterprise.knowledge.content.invalid_source'))
    const metadata = await lstat(path)
    active()
    if (metadata.isSymbolicLink()) throw new Error(t('enterprise.knowledge.content.invalid_source'))
    await requireEditableKnowledge(client, id, active)
    if (metadata.isDirectory()) {
      const folder = await client.createFolder(id, basename(path), parent, active)
      active()
      if (
        folder.knowledgeId !== id ||
        !/^[0-9a-f]{32}$/.test(folder.fileId) ||
        !folder.directory ||
        folder.parentId !== (parent ?? null)
      )
        throw new Error(t('enterprise.knowledge.content.unconfirmed'))
      for (const entry of await readdir(path)) await visit(join(path, entry), folder.fileId, depth + 1)
      return
    }
    if (!metadata.isFile()) throw new Error(t('enterprise.knowledge.content.invalid_source'))
    const name = basename(path)
    if (!name.trim() || /[\p{Cc}/\\]/u.test(name) || name.length > 250)
      throw new Error(t('enterprise.knowledge.content.invalid_source'))
    const boundary = `mea-${randomUUID()}`
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n${id}\r\n` +
        (parent ? `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${parent}\r\n` : '') +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replace(/"/g, '%22')}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    )
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
    const result = (await client.uploadMultipart(
      '/api/v1/client/knowledge/file/upload',
      `multipart/form-data; boundary=${boundary}`,
      prefix.length + metadata.size + suffix.length,
      async function* (reset, signal) {
        active()
        yield prefix
        let bytes = 0
        for await (const chunk of createReadStream(path, { signal })) {
          active()
          bytes += chunk.length
          if (bytes > metadata.size) throw new Error(t('enterprise.knowledge.content.file_changed'))
          reset()
          yield chunk
        }
        if (bytes !== metadata.size) throw new Error(t('enterprise.knowledge.content.file_changed'))
        active()
        yield suffix
      },
      active
    )) as { knowledgeId?: string; fileId?: string }
    active()
    if (result.knowledgeId !== id || !/^[0-9a-f]{32}$/.test(result.fileId ?? ''))
      throw new Error(t('enterprise.knowledge.content.unconfirmed'))
  }
  for (const path of picked.filePaths) await visit(path, parentId, 0)
  return true
}
