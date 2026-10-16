import { useTranslation } from 'react-i18next'

import { Badge } from '@cherrystudio/ui'
import type { OrgKnowledgeSyncStatus } from '@shared/data/types/enterpriseKnowledge'

export default function KnowledgeSyncBadge({ status }: { status: OrgKnowledgeSyncStatus }) {
  const { t } = useTranslation()
  return (
    <Badge variant="outline" title={status.lastSyncedAt ?? undefined}>
      {t(
        {
          unshared: 'knowledge.sync.state.unshared',
          shared: 'knowledge.sync.state.shared',
          pending: 'knowledge.sync.state.pending',
          syncing: 'knowledge.sync.state.syncing',
          failed: 'knowledge.sync.state.failed',
          unknown: 'knowledge.sync.state.unknown',
          incomplete: 'knowledge.sync.state.incomplete',
          unconfirmed: 'knowledge.sync.state.unconfirmed'
        }[status.state]
      )}
    </Badge>
  )
}
