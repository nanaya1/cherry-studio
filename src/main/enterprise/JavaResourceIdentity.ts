import { createHash } from 'node:crypto'

import { parseJavaResourceKey, type JavaResourceSource } from '@shared/utils/javaResourceKey'

export { parseJavaResourceKey, type JavaResourceSource } from '@shared/utils/javaResourceKey'

// MEA:enterprise-java-resources 实例标识仅要求非空，编码分隔符以保留原值。
// const INSTANCE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/
// const RESOURCE_KEY = /^java-resource:([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}):(skill|mcp):([1-9][0-9]*)$/

export function javaResourceKey(
  serverInstanceId: string,
  resourceType: JavaResourceSource['resourceType'],
  resourceId: string
): string {
  // if (!INSTANCE_ID.test(serverInstanceId)) throw new Error('服务实例标识无效')
  if (typeof serverInstanceId !== 'string' || !serverInstanceId.trim()) throw new Error('服务实例标识无效')
  if (resourceType !== 'skill' && resourceType !== 'mcp') throw new Error('资源类型无效')
  if (!/^[1-9][0-9]*$/.test(resourceId) || !Number.isSafeInteger(Number(resourceId))) {
    throw new Error('资源ID无效或超出安全整数范围')
  }
  // return `java-resource:${serverInstanceId}:${resourceType}:${resourceId}`
  return `java-resource:${encodeURIComponent(serverInstanceId)}:${resourceType}:${resourceId}`
}

// 原UUID专用解析由主进程与IPC共用的规范编码解析替代。
// export function parseJavaResourceKey(value: string | null | undefined): JavaResourceSource | null {
//   const match = value?.match(RESOURCE_KEY)
//   if (!match || !Number.isSafeInteger(Number(match[3]))) return null
//   return {
//     serverInstanceId: match[1],
//     resourceType: match[2] as JavaResourceSource['resourceType'],
//     resourceId: match[3]
//   }
// }

export function javaResourceFolderName(key: string): string {
  const source = parseJavaResourceKey(key)
  if (!source) throw new Error('资源来源标识无效')
  return `java-${source.resourceType}-${createHash('sha256').update(key).digest('hex')}`
}
