import { application } from '@application'

const prefix = 'industrial-video-workbench:'

export class IndustrialVideoWorkbenchSecurity {
  private entries = new Map<string, { url: string; origin: string; run: string }>()

  register(sessionId: string, run: string, value: string, baseUrl: string): string {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin !== new URL(baseUrl).origin ||
      url.pathname !== '/workbench' ||
      url.searchParams.get('run') !== run
    ) {
      throw new Error('工业工作台地址与当前服务或项目不匹配。')
    }
    const partition = `${prefix}${sessionId}:${run}`
    this.entries.set(partition, { url: url.href, origin: url.origin, run })
    return partition
  }

  partitions(): string[] {
    return [...this.entries.keys()]
  }

  allowsEntry(partition: string, value: string): boolean {
    const entry = this.entries.get(partition)
    try {
      return Boolean(entry && new URL(value).href === entry.url)
    } catch {
      return false
    }
  }

  allowsRequest(partition: string, value: string): boolean {
    const entry = this.entries.get(partition)
    try {
      const url = new URL(value)
      return Boolean(
        entry &&
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.origin === entry.origin
      )
    } catch {
      return false
    }
  }

  attach(
    event: { preventDefault(): void },
    preferences: { preload?: string; nodeIntegration?: boolean },
    params: { partition?: string; src?: string }
  ): boolean {
    if (!params.partition?.startsWith(prefix)) return false
    const initialBlank = this.entries.has(params.partition) && (!params.src || params.src === 'about:blank')
    if (!initialBlank && !this.allowsEntry(params.partition, params.src ?? '')) {
      event.preventDefault()
      return true
    }
    // 仅为此专属 partition 注入受限桥 preload（不暴露通用 ipc/令牌）；保留 sandbox/contextIsolation/nodeIntegration=false。
    // MEA:industrial-video 旧逻辑为 delete preferences.preload（无桥），现已改为注入专属 preload：
    // delete preferences.preload
    try {
      preferences.preload = application.getPath('feature.industrialVideoWorkbench.preload_file')
    } catch {
      event.preventDefault()
      return true
    }
    Object.assign(preferences, {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true
    })
    return true
  }
}

export const industrialVideoWorkbenchSecurity = new IndustrialVideoWorkbenchSecurity()
