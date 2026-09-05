import { cacheService } from '@data/CacheService'
import { useIsActiveTab, useTabSelfVisuals } from '@renderer/hooks/tab'
import type { ActiveTopicSource } from '@renderer/hooks/useTopic'
import { useEffect } from 'react'

type Props = {
  title: string
  preserveVisuals: boolean
  activeTopicId?: string | null
  activeTopicSource: ActiveTopicSource
}

export function HomeTabRuntime({ title, preserveVisuals, activeTopicId, activeTopicSource }: Props) {
  const isActiveTab = useIsActiveTab()

  useTabSelfVisuals({
    title,
    appId: 'assistants',
    preserveVisuals
  })

  useEffect(() => {
    if (!isActiveTab) return
    if (activeTopicId && activeTopicSource === 'query') {
      cacheService.setPersist('ui.chat.last_used_topic_id', activeTopicId)
    }
  }, [isActiveTab, activeTopicId, activeTopicSource])

  return null
}
