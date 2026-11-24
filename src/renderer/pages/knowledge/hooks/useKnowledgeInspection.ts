import { useState } from 'react'

import type { InspectionSpace } from '@shared/data/types/knowledgeInspection'

/** 管理目录及选中项仅属于此页面，绝不写入 useOrgKnowledge 的聊天目录。 */
export function useKnowledgeInspection(authorized: boolean, session: number, category: string) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [selected, select] = useState<InspectionSpace | null>(null)
  const [identity, setIdentity] = useState({ authorized, session, category })
  if (identity.authorized !== authorized || identity.session !== session || identity.category !== category) {
    setIdentity({ authorized, session, category })
    setScope('mine')
    select(null)
  }
  return {
    scope,
    setScope: (value: 'mine' | 'all') => {
      select(null)
      setScope(value)
    },
    selected,
    select,
    active: authorized && category === 'shared' && scope === 'all'
  }
}
