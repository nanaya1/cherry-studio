import type { ISeeder } from '../types'
import { BrowserCapabilityUpgradeSeeder } from './seeders/browserCapabilityUpgradeSeeder'
import { BuiltinAssistantMcpBindingSeeder } from './seeders/builtinAssistantMcpBindingSeeder'
import { BuiltinMcpServerSeeder } from './seeders/builtinMcpServerSeeder'
// import { ChatbiMcpSeeder } from './seeders/chatbiMcpSeeder'
import { CherryAiDefaultModelSeeder } from './seeders/cherryaiDefaultModelSeeder'
import { CherryAssistantSeeder } from './seeders/cherryAssistantSeeder'
import { CherrySupportSeeder } from './seeders/cherrySupportSeeder'
import { DefaultAssistantSeeder } from './seeders/defaultAssistantSeeder'
import { EnterpriseMcpServersSeeder } from './seeders/enterpriseMcpServersSeeder'
// import { HufuMcpSeeder } from './seeders/hufuMcpSeeder'
import { LegacyFileCleanupPolicySeeder } from './seeders/legacyFileCleanupPolicySeeder'
import { LocalModelSeeder } from './seeders/LocalModelSeeder'
import { LongTextPastePreferenceUpgradeSeeder } from './seeders/longTextPastePreferenceUpgradeSeeder'
import { MiniAppSeeder } from './seeders/miniAppSeeder'
import { PreferenceSeeder } from './seeders/preferenceSeeder'
import { PresetProviderSeeder } from './seeders/presetProviderSeeder'
import { SidebarShortcutMigrationSeeder } from './seeders/sidebarShortcutMigrationSeeder'
import { TestMcpRetirementSeeder } from './seeders/testMcpRetirementSeeder'
import { TranslateLanguageSeeder } from './seeders/translateLanguageSeeder'
// import { TuringDrawingSearchSeeder } from './seeders/turingDrawingSearchSeeder'
import { WebSearchPreferenceUpgradeSeeder } from './seeders/WebSearchPreferenceUpgradeSeeder'
import { XuelangDefaultModelSeeder } from './seeders/xuelangDefaultModelSeeder'

/**
 * All seeders in execution order.
 *
 * To add a new seeder: create an ISeeder class, add it to this array.
 * No changes to DbService needed.
 */
export const seeders: ISeeder[] = [
  new BrowserCapabilityUpgradeSeeder(),
  new LegacyFileCleanupPolicySeeder(),
  new XuelangDefaultModelSeeder(),
  new CherryAiDefaultModelSeeder(),
  new CherryAssistantSeeder(),
  new CherrySupportSeeder(),
  new DefaultAssistantSeeder(),
  new LongTextPastePreferenceUpgradeSeeder(),
  new WebSearchPreferenceUpgradeSeeder(),
  new SidebarShortcutMigrationSeeder(),
  new PreferenceSeeder(),
  new TranslateLanguageSeeder(),
  new PresetProviderSeeder(),
  new LocalModelSeeder(),
  new MiniAppSeeder(),
  new BuiltinMcpServerSeeder(),
  // MEA:chatbi-builtin-mcp 独立日志替换旧服务，不重放历史安装。
  // new TuringDrawingSearchSeeder(),
  // new HufuMcpSeeder(),
  // new ChatbiMcpSeeder(),
  // MEA:chatbi-builtin-mcp 独立退役清理覆盖未执行旧替换升级的用户。
  new TestMcpRetirementSeeder(),
  // MEA:enterprise-builtin-mcp 先退役旧测试项，再独立安装并绑定企业五项。
  new EnterpriseMcpServersSeeder(),
  // Keep binding after default server installation; do not replay installation versions.
  new BuiltinAssistantMcpBindingSeeder()
]
