import { assistantTable } from '@data/db/schemas/assistant'
import { messageTable } from '@data/db/schemas/message'
import { topicTable } from '@data/db/schemas/topic'
import { insertWithOrderKey } from '@data/services/utils/orderKey'
import { DEFAULT_ASSISTANT_SEED, getDefaultAssistantNameForLocale } from '@shared/data/presets/defaultAssistant'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { app } from 'electron'

import type { DbOrTx, DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'

export class DefaultAssistantSeeder implements ISeeder {
  readonly name = 'defaultAssistant'
  readonly description = 'Insert the default assistant and roll stock renames forward'
  readonly executionPolicy = 'run-on-change' as const
  readonly version: string

  constructor() {
    this.version = hashObject({
      assistant: DEFAULT_ASSISTANT_SEED,
      freshGuard: 'no active assistant/topic/message',
      localizedName: 'MEA Cowork for every locale',
      stockRename: 'unique stock name=>MEA Cowork+builtinRole'
    })
  }

  run(db: DbType): void {
    db.transaction((tx) => {
      this.renameStockNames(tx)

      if (!this.isFreshUserDatabase(tx)) {
        return
      }

      const insertValues = {
        ...DEFAULT_ASSISTANT_SEED,
        name: getDefaultAssistantNameForLocale(this.getPreferredSystemLanguage()),
        builtinRole: 'assistant',
        settings: { ...DEFAULT_ASSISTANT_SEED.settings }
      } satisfies Omit<typeof assistantTable.$inferInsert, 'orderKey'>

      insertWithOrderKey(tx, assistantTable, insertValues, {
        pkColumn: assistantTable.id,
        scope: isNull(assistantTable.deletedAt)
      })
    })
  }

  /**
   * Roll prior stock Chinese names forward to the current one. Exact-match only:
   * any other name (including the English default and user renames) is preserved.
   */
  private renameStockNames(tx: DbOrTx): void {
    const [builtin] = tx
      .select({ id: assistantTable.id, name: assistantTable.name })
      .from(assistantTable)
      .where(eq(assistantTable.builtinRole, 'assistant'))
      .limit(1)
      .all()
    if (builtin) {
      if (['默认助手', 'Cherry 助手', '工匠助手', 'Cherry Assistant'].includes(builtin.name)) {
        tx.update(assistantTable).set({ name: 'MEA Cowork' }).where(eq(assistantTable.id, builtin.id)).run()
      }
      return
    }

    const candidates = tx
      .select({ id: assistantTable.id, name: assistantTable.name })
      .from(assistantTable)
      .where(
        and(
          inArray(assistantTable.name, ['默认助手', 'Cherry 助手', '工匠助手', 'Cherry Assistant']),
          isNull(assistantTable.deletedAt)
        )
      )
      .limit(2)
      .all()
    if (candidates.length !== 1) return

    const [candidate] = candidates
    tx.update(assistantTable)
      .set({ builtinRole: 'assistant', name: 'MEA Cowork' })
      .where(eq(assistantTable.id, candidate.id))
      .run()
  }

  private getPreferredSystemLanguage(): string | undefined {
    try {
      return app.getPreferredSystemLanguages()[0]
    } catch {
      return undefined
    }
  }

  private isFreshUserDatabase(tx: Pick<DbType, 'select'>): boolean {
    const [assistant] = tx
      .select({ id: assistantTable.id })
      .from(assistantTable)
      .where(isNull(assistantTable.deletedAt))
      .limit(1)
      .all()
    if (assistant) return false

    const [topic] = tx.select({ id: topicTable.id }).from(topicTable).where(isNull(topicTable.deletedAt)).limit(1).all()
    if (topic) return false

    const [message] = tx
      .select({ id: messageTable.id })
      .from(messageTable)
      .leftJoin(topicTable, eq(messageTable.topicId, topicTable.id))
      .where(and(isNull(messageTable.deletedAt), isNull(topicTable.deletedAt)))
      .limit(1)
      .all()
    return !message
  }
}
