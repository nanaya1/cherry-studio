import * as z from 'zod'

export const recoveryFileSchema = z.object({
  id: z.string().min(1),
  space_id: z.string().min(1),
  parent_id: z.string().nullable(),
  name: z.string(),
  is_dir: z.boolean(),
  has_original_file: z.boolean(),
  file_hash: z.string().nullable(),
  updated_at: z.string()
})
export type RecoveryFile = z.infer<typeof recoveryFileSchema>
export const cloudRecoverySchema = z.object({
  spaceId: z.string(),
  localBaseId: z.string(),
  phase: z.enum(['preparing', 'ready', 'delete-unknown', 'deleted', 'local-cleanup', 'completed']),
  deleteLocal: z.boolean().optional(),
  mode: z.literal('delete-only').optional(),
  localCopies: z.array(z.string()).optional(),
  cleanupScope: z
    .object({
      associationKeys: z.array(z.string()),
      cloudGroupId: z.string().nullable(),
      localGroups: z.record(z.string(), z.string().nullable()),
      assistantIds: z.array(z.string()),
      agentIds: z.array(z.string())
    })
    .optional(),
  snapshot: z.string(),
  restored: z.record(z.string(), z.string()),
  fingerprints: z.record(z.string(), z.string()).default({}),
  expectedHashes: z.record(z.string(), z.string()).default({}),
  missing: z.array(z.object({ id: z.string(), name: z.string() }))
})
export type CloudRecovery = z.infer<typeof cloudRecoverySchema>

type Ports = {
  load(): CloudRecovery | undefined
  save(state: CloudRecovery): void
  scan(): Promise<RecoveryFile[]>
  createBase(): Promise<string>
  localCopies(): string[]
  hasBase(baseId: string): Promise<boolean>
  // restore(file: RecoveryFile, baseId: string, parentItemId: string | null): Promise<string | null>
  restore(
    file: RecoveryFile,
    baseId: string,
    parentItemId: string | null,
    expectHash: (hash: string) => void
  ): Promise<string | null>
  fingerprint(itemId: string): Promise<string | null>
  hasRestoredItem(baseId: string, itemId: string): Promise<boolean>
  assertReady(baseId: string, itemIds: string[]): Promise<void>
  deleteSpace(): Promise<void>
  finish(baseId: string, preserveBaseId?: string): Promise<void>
  deleteLocalBase(baseId: string): Promise<void>
  active(): void
}

// MEA:enterprise-knowledge-page 恢复日志在删除前落盘；未知 DELETE 永不自动重放。
export class CloudKnowledgeRecovery {
  constructor(private readonly ports: Ports) {}

  private snapshot(files: RecoveryFile[]): string {
    return JSON.stringify([...files].sort((a, b) => a.id.localeCompare(b.id)))
  }

  async prepare(spaceId: string): Promise<CloudRecovery> {
    const p = this.ports
    p.active()
    let state = p.load()
    if (state?.phase === 'delete-unknown') throw new Error('云端删除结果待核查，禁止重复删除')
    if (state?.phase === 'deleted' || state?.phase === 'local-cleanup' || state?.phase === 'completed') return state
    const files = await p.scan()
    p.active()
    const snapshot = this.snapshot(files)
    if (!state) {
      state = {
        spaceId,
        localBaseId: await p.createBase(),
        phase: 'preparing',
        snapshot,
        restored: {},
        fingerprints: {},
        expectedHashes: {},
        missing: []
      }
      p.active()
      p.save(state)
    }
    if (state.spaceId !== spaceId) throw new Error('恢复空间身份不匹配')
    if (!(await p.hasBase(state.localBaseId))) {
      state.localBaseId = await p.createBase()
      state.restored = {}
      state.fingerprints = {}
      state.expectedHashes = {}
      state.missing = []
      p.active()
      p.save(state)
    }
    if (state.snapshot !== snapshot && Object.keys(state.restored).length) {
      throw new Error('恢复期间云端内容已变化，请保留本机恢复副本并重新核查')
    }
    state.snapshot = snapshot
    state.missing = []
    state.phase = 'preparing'
    p.save(state)
    const pending = new Map(files.map((file) => [file.id, file]))
    const visited = new Set<string>()
    const restore = async (file: RecoveryFile): Promise<void> => {
      p.active()
      if (visited.has(file.id)) throw new Error('云端目录存在循环')
      visited.add(file.id)
      if (file.space_id !== spaceId) throw new Error('云端文件归属不匹配')
      if (file.parent_id) {
        const parent = pending.get(file.parent_id)
        if (!parent?.is_dir) throw new Error('云端父目录不完整')
        if (!state.restored[parent.id]) await restore(parent)
      }
      const restoredItemId = state.restored[file.id]
      if (restoredItemId && !(await p.hasRestoredItem(state.localBaseId, restoredItemId))) {
        delete state.restored[file.id]
        delete state.fingerprints[restoredItemId]
        delete state.expectedHashes[file.id]
        p.save(state)
      }
      if (!state.restored[file.id]) {
        // const itemId = await p.restore(file, state.localBaseId, file.parent_id ? state.restored[file.parent_id] : null)
        const itemId = await p.restore(
          file,
          state.localBaseId,
          file.parent_id ? state.restored[file.parent_id] : null,
          (hash) => {
            p.active()
            state.expectedHashes[file.id] = hash
            p.save(state)
          }
        )
        p.active()
        if (itemId) {
          const fingerprint = await p.fingerprint(itemId)
          p.active()
          if (!file.is_dir && (!state.expectedHashes[file.id] || fingerprint !== state.expectedHashes[file.id]))
            throw new Error('本地导入原件校验失败，禁止删除云端')
          state.restored[file.id] = itemId
          if (fingerprint) state.fingerprints[itemId] = fingerprint
        } else state.missing.push({ id: file.id, name: file.name })
        p.save(state)
      }
      visited.delete(file.id)
    }
    for (const file of files) await restore(file)
    await p.assertReady(state.localBaseId, Object.values(state.restored))
    p.active()
    if (this.snapshot(await p.scan()) !== snapshot) throw new Error('云端内容已变化，禁止删除，请重新核查')
    p.active()
    state.phase = 'ready'
    p.save(state)
    return state
  }

  // MEA:enterprise-knowledge-page 删除不恢复资料；未知结果保留意图，成功后才允许本机续作。
  async remove(spaceId: string, localCopies: string[], confirmed: boolean): Promise<string> {
    const p = this.ports
    p.active()
    let state = p.load()
    if (state && state.spaceId !== spaceId) throw new Error('删除空间身份不匹配')
    if (state?.phase === 'delete-unknown') throw new Error('云端删除结果待核查，禁止重复删除')
    if (state?.phase === 'completed') {
      if (!state.deleteLocal) throw new Error('已取消分享，请从本机知识库删除')
      return state.localBaseId
    }
    if (state?.phase !== 'deleted' && state?.phase !== 'local-cleanup') {
      if (!confirmed) throw new Error('请确认删除范围及其他设备受影响')
      const copies = [...new Set([...(state?.localCopies ?? []), ...localCopies, state?.localBaseId ?? ''])].filter(
        Boolean
      )
      state = {
        spaceId,
        localBaseId: state?.localBaseId || copies[0] || '',
        phase: 'delete-unknown',
        mode: 'delete-only',
        deleteLocal: true,
        localCopies: copies,
        snapshot: '',
        restored: {},
        fingerprints: {},
        expectedHashes: {},
        missing: []
      }
      p.active()
      p.save(state)
      await p.deleteSpace()
      state.phase = 'deleted'
      p.save(state)
      p.active()
    }
    if (!state.deleteLocal) throw new Error('已取消分享，请从本机知识库删除')
    state.mode = 'delete-only'
    state.phase = 'local-cleanup'
    p.save(state)
    p.active()
    for (const id of new Set([state.localBaseId, ...(state.localCopies ?? [])].filter(Boolean))) {
      p.active()
      await p.deleteLocalBase(id)
    }
    p.active()
    await p.finish(state.localBaseId, state.deleteLocal ? undefined : p.localCopies()[0])
    p.active()
    state.phase = 'completed'
    p.save(state)
    return state.localBaseId
  }

  async cancel(confirmMissing: boolean, confirmDevicesStopped: boolean, deleteLocal = false): Promise<string> {
    const p = this.ports
    const state = p.load()
    if (!state) throw new Error('请先恢复并预检本地资料')
    p.active()
    if (state.phase === 'completed') return state.localBaseId
    if (state.phase === 'delete-unknown') throw new Error('云端删除结果待核查，禁止重复删除')
    if (state.phase !== 'deleted' && state.phase !== 'local-cleanup') {
      if (state.phase !== 'ready' || !confirmDevicesStopped || (state.missing.length > 0 && !confirmMissing))
        throw new Error('请确认缺失资料及其他设备已停止操作')
      await p.assertReady(state.localBaseId, Object.values(state.restored))
      // for (const itemId of Object.values(state.restored)) {
      for (const [fileId, itemId] of Object.entries(state.restored)) {
        const fingerprint = await p.fingerprint(itemId)
        // if (fingerprint !== null && fingerprint !== state.fingerprints[itemId])
        if (
          fingerprint !== null &&
          (!state.expectedHashes[fileId] ||
            fingerprint !== state.expectedHashes[fileId] ||
            fingerprint !== state.fingerprints[itemId])
        )
          throw new Error('本地恢复副本已变化，禁止删除云端')
      }
      if (this.snapshot(await p.scan()) !== state.snapshot) throw new Error('云端内容已变化，请重新恢复后取消')
      p.active()
      state.deleteLocal = deleteLocal
      state.phase = 'delete-unknown'
      p.save(state)
      await p.deleteSpace()
      // 删除成功属于原账号，先保存结果再检查租约，避免重启误发 DELETE。
      state.phase = 'deleted'
      p.save(state)
      p.active()
    }
    const localCopies = [...new Set([...(state.localCopies ?? []), ...p.localCopies()])]
    if (state.phase !== 'local-cleanup') {
      // await p.finish(state.localBaseId, state.deleteLocal ? undefined : localCopies[0])
      // 普通取消分享以云端恢复库作为最终本地库，避免已在云端删除的文件从旧副本回流。
      await p.finish(state.localBaseId, undefined)
      p.active()
      if (state.deleteLocal || localCopies.length > 0) {
        state.localCopies = localCopies
        state.phase = 'local-cleanup'
        p.save(state)
      }
    }
    if (state.deleteLocal || (state.localCopies ?? []).length > 0) {
      p.active()
      // const localBaseIds = state.deleteLocal ? [state.localBaseId, ...(state.localCopies ?? [])] : [state.localBaseId]
      const localBaseIds = state.deleteLocal ? [state.localBaseId, ...(state.localCopies ?? [])] : [...(state.localCopies ?? [])]
      for (const baseId of new Set(localBaseIds)) {
        if (!baseId) continue
        p.active()
        await p.deleteLocalBase(baseId)
      }
      p.active()
    }
    state.phase = 'completed'
    p.save(state)
    return state.localBaseId
  }
}
