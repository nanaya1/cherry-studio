import type { SettingsSearchEntry } from '../settingsSearch/types'

export const route = '/settings/about'

// Actionable rows only: version info lines stay out per D8. The update rows
// sit inside `!isPortable` (portable builds hide them) — acceptable declared
// exception: normal builds always render them, portable jumps degrade silently.
export const entries: SettingsSearchEntry[] = [
  // MEA：自动更新行已随 32d08a59e2 有意隐藏（不走 Cherry 更新通道），索引一并停用；
  // 恢复自动更新功能时取消注释即可。
  // {
  //   anchorId: 'auto-check-update',
  //   titleKey: 'settings.general.auto_check_update.title',
  //   groupKey: 'settings.about.label',
  //   aliases: ['update', '更新']
  // },
  {
    anchorId: 'diagnostics',
    titleKey: 'settings.about.diagnostics.entry.title',
    groupKey: 'settings.about.label',
    aliases: ['diagnostics', '诊断']
  },
  {
    anchorId: 'debug-tools',
    titleKey: 'settings.about.debug.title',
    groupKey: 'settings.about.label'
  }
]
