import {
  Activity,
  Bell,
  CalendarClock,
  Cloud,
  Command,
  Crop,
  Database,
  FileBox,
  FileCode,
  Globe,
  HardDrive,
  Info,
  MonitorSmartphone,
  Package,
  Palette,
  PictureInPicture2,
  Radio,
  ScanText,
  Search,
  Settings2,
  Terminal,
  TextCursorInput,
  ToolCase,
  Zap
} from 'lucide-react'
import type { ReactNode } from 'react'
import { createElement } from 'react'

import { GatewayIcon } from '@renderer/components/icons/GatewayIcon'
import { McpLogo } from '@renderer/components/icons/SvgIcon'
import { isSettingsPath } from '@shared/data/types/settingsPath'

/** Resolve the section label without changing the default settings tab title. */
export function getSettingsSectionTitleKey(url: string): string | undefined {
  if (!isSettingsPath(url)) return undefined
  const pathname = new URL(url, 'https://www.cherry-ai.com').pathname
  return (
    settingsMenu.find(({ route }) => pathname === route || pathname.startsWith(`${route}/`))?.titleKey ??
    (pathname === '/settings/search' ? 'common.search' : undefined)
  )
}

export interface SettingsMenuEntry {
  /** Settings section route; also the aggregation key for `.search.ts` leaves */
  route: string
  /** i18n key of the menu title — always searchable as the section baseline */
  titleKey: string
  icon: ReactNode
  /** Group title key (`settings.menuGroups.*`); omitted for the ungrouped head section */
  groupKey?: string
}

// MEA：设置侧栏隐藏的条目（入口由技能连接器页统一承载）。侧栏菜单（SettingsPage）
// 与设置搜索索引（settingsSearch/aggregate.ts）共用此清单，新增隐藏消费方时务必接入。
export const MEA_HIDDEN_SETTINGS_ROUTES: readonly string[] = ['/settings/mcp', '/settings/skills']

/**
 * Single source of truth for the settings sidebar menu.
 * Array order = menu render order = search tie-break order.
 * Adding a settings section requires registering it here, which also makes its
 * title searchable — the settings search baseline is structural, not manual.
 */
export const settingsMenu: readonly SettingsMenuEntry[] = [
  { route: '/settings/provider', titleKey: 'settings.provider.title', icon: createElement(Cloud) },
  { route: '/settings/model', titleKey: 'settings.model', icon: createElement(Package) },
  {
    route: '/settings/local-models',
    titleKey: 'settings.dependencies.localModels.title',
    icon: createElement(FileBox)
  },
  { route: '/settings/api-gateway', titleKey: 'apiGateway.title', icon: createElement(GatewayIcon) },
  // MEA：远端服务从「工具」分组提升为设置侧栏顶部无分组入口（改名「远端服务」）。
  {
    route: '/settings/remote-knowledge',
    titleKey: 'settings.remoteKnowledge.title',
    icon: createElement(Database)
  },
  {
    route: '/settings/mcp',
    titleKey: 'agent.settings.toolsMcp.mcp.tab',
    icon: createElement(McpLogo, { width: 16, height: 16, className: 'text-foreground' }),
    groupKey: 'settings.menuGroups.capabilities'
  },
  // 停用原「工具」分组下的远端知识服务入口（已提升至上方无分组区）。
  // {
  //   route: '/settings/remote-knowledge',
  //   titleKey: 'settings.remoteKnowledge.title',
  //   icon: createElement(Database),
  //   groupKey: 'settings.menuGroups.capabilities'
  // },
  {
    route: '/settings/skills',
    titleKey: 'settings.skills.title',
    icon: createElement(ToolCase),
    groupKey: 'settings.menuGroups.capabilities'
  },
  {
    route: '/settings/prompts',
    titleKey: 'settings.prompts.title',
    icon: createElement(Zap),
    groupKey: 'settings.menuGroups.capabilities'
  },
  {
    route: '/settings/browser',
    titleKey: 'settings.browser.title',
    icon: createElement(Globe),
    groupKey: 'settings.menuGroups.capabilities'
  },
  {
    route: '/settings/websearch',
    titleKey: 'settings.tool.websearch.title',
    icon: createElement(Search),
    groupKey: 'settings.menuGroups.capabilities'
  },
  {
    route: '/settings/file-processing',
    titleKey: 'settings.tool.file_processing.features.document_to_markdown.title',
    icon: createElement(FileCode),
    groupKey: 'settings.menuGroups.capabilities'
  },
  {
    route: '/settings/ocr',
    titleKey: 'settings.tool.file_processing.features.image_to_text.title',
    icon: createElement(ScanText),
    groupKey: 'settings.menuGroups.capabilities'
  },
  {
    route: '/settings/general',
    titleKey: 'settings.general.common.title',
    icon: createElement(Settings2),
    groupKey: 'settings.menuGroups.personal'
  },
  {
    route: '/settings/appearance',
    titleKey: 'settings.appearance.title',
    icon: createElement(Palette),
    groupKey: 'settings.menuGroups.personal'
  },
  {
    route: '/settings/notifications',
    titleKey: 'settings.notification.title',
    icon: createElement(Bell),
    groupKey: 'settings.menuGroups.personal'
  },
  {
    route: '/settings/data',
    titleKey: 'settings.data.title',
    icon: createElement(HardDrive),
    groupKey: 'settings.menuGroups.personal'
  },
  {
    route: '/settings/usage',
    titleKey: 'settings.usage.title',
    icon: createElement(Activity),
    groupKey: 'settings.menuGroups.personal'
  },
  {
    route: '/settings/channels',
    titleKey: 'settings.channels.title',
    icon: createElement(Radio),
    groupKey: 'settings.menuGroups.automation'
  },
  {
    route: '/settings/device-connections',
    titleKey: 'deviceConnections.title',
    icon: createElement(MonitorSmartphone),
    groupKey: 'settings.menuGroups.automation'
  },
  {
    route: '/settings/scheduled-tasks',
    titleKey: 'settings.scheduledTasks.title',
    icon: createElement(CalendarClock),
    groupKey: 'settings.menuGroups.automation'
  },
  {
    route: '/settings/shortcut',
    titleKey: 'settings.shortcuts.title',
    icon: createElement(Command),
    groupKey: 'settings.menuGroups.automation'
  },
  {
    route: '/settings/quick-assistant',
    titleKey: 'settings.quickAssistant.title',
    icon: createElement(PictureInPicture2),
    groupKey: 'settings.menuGroups.automation'
  },
  {
    route: '/settings/selection-assistant',
    titleKey: 'selection.name',
    icon: createElement(TextCursorInput),
    groupKey: 'settings.menuGroups.automation'
  },
  {
    route: '/settings/screenshot',
    titleKey: 'settings.screenshot.title',
    icon: createElement(Crop),
    groupKey: 'settings.menuGroups.automation'
  },
  {
    route: '/settings/dependencies',
    titleKey: 'settings.dependencies.title',
    icon: createElement(Terminal),
    groupKey: 'settings.menuGroups.system'
  },
  {
    route: '/settings/about',
    titleKey: 'settings.about.label',
    icon: createElement(Info),
    groupKey: 'settings.menuGroups.system'
  }
]
