import type * as z from 'zod'

import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'
import { industrialVideoRequestSchemas } from '@shared/ipc/schemas/industrialVideo'

export type IndustrialVideoInput = Omit<
  z.infer<(typeof industrialVideoRequestSchemas)['industrial_video.parse']['input']>,
  'sessionId' | 'run'
>

export function getIndustrialVideoInput(record: IndustrialVideoProductionRecord | null): IndustrialVideoInput {
  const round = record?.rounds.findLast(
    (item) => item.operation === 'parse' && item.outcome === 'ok' && item.detail?.inputSnapshot
  )
  return (round?.detail?.inputSnapshot as IndustrialVideoInput | undefined) ?? {}
}

// MEA:industrial-video parse 接收增量，但发往服务端与落盘的始终是全量快照。
export function mergeIndustrialVideoInput(
  previous: IndustrialVideoInput,
  update: IndustrialVideoInput
): IndustrialVideoInput {
  const parsed = industrialVideoRequestSchemas['industrial_video.parse'].input.parse({
    sessionId: 'snapshot',
    ...update
  })
  const changes: IndustrialVideoInput = { ...parsed }
  delete (changes as Partial<typeof parsed>).sessionId
  delete (changes as Partial<typeof parsed>).run
  const next = {
    ...previous,
    ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined))
  }
  next.texts = [...(previous.texts ?? []), ...(changes.texts ?? [])].filter(
    (item, index, all) => all.findIndex((other) => other.text === item.text && other.title === item.title) === index
  )
  next.media = [
    ...new Map([...(previous.media ?? []), ...(changes.media ?? [])].map((item) => [item.name, item])).values()
  ]
  for (const item of [...next.media, ...(next.logo ? [next.logo] : [])]) {
    if (/[\\/]|^[a-z]+:/i.test(item.name)) throw new Error('素材必须使用已上传的服务端句柄，不能使用本地路径或 URL。')
  }
  return structuredClone(next)
}
