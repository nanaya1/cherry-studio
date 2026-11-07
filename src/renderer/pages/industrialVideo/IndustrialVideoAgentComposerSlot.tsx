import { useEffect, useState, type ComponentProps } from 'react'

import AgentComposerSlot from '../agents/AgentComposerSlot'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

export default function IndustrialVideoAgentComposerSlot(props: ComponentProps<typeof AgentComposerSlot>) {
  const { record, job, error, refresh } = useIndustrialVideoProduction(props.sessionId)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refresh()
      if (!active) return
      setReady(true)
      timer = setTimeout(() => void poll(), 3000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [refresh])
  const blocked =
    !ready ||
    Boolean(error) ||
    Boolean(record?.unknownSubmissions.length) ||
    ['parsing', 'planning', 'generating', 'assembling'].includes(record?.state ?? '') ||
    ['queued', 'running'].includes(String(job?.status ?? ''))
  return (
    <AgentComposerSlot {...props} attachmentOnly sendDisabled={props.sendDisabled || props.isStreaming || blocked} />
  )
}
