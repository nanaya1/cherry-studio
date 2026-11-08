// import { useEffect, useState, type ComponentProps } from 'react'
import { useEffect, useRef, useState, type ComponentProps } from 'react'

import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'

import AgentComposerSlot from '../agents/AgentComposerSlot'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

const logger = loggerService.withContext('IndustrialVideoAgentComposerSlot')

export default function IndustrialVideoAgentComposerSlot(props: ComponentProps<typeof AgentComposerSlot>) {
  const { record, job, error, refresh } = useIndustrialVideoProduction(props.sessionId)
  const [ready, setReady] = useState(false)
  const stoppingSession = useRef<string | null>(null)
  const [stopState, setStopState] = useState<{ sessionId: string; stopping: boolean; failed: boolean } | null>(null)
  const taskStopping = stopState?.sessionId === props.sessionId && stopState.stopping
  const stopFailed = stopState?.sessionId === props.sessionId && stopState.failed
  const stoppedEpoch = useRef<number | null>(null)
  const [stopAcknowledged, setStopAcknowledged] = useState<string | null>(null)
  const stopped =
    (stopAcknowledged === props.sessionId &&
      (record?.control?.epoch === undefined || stoppedEpoch.current === record.control.epoch)) ||
    Boolean(record?.control?.stopRequested)
  const verifiedStopped = record?.control?.phase === 'stopped'
  const taskBusy =
    (!verifiedStopped && props.isStreaming) ||
    taskStopping ||
    stopFailed ||
    Boolean(record?.unknownSubmissions.length) ||
    (!verifiedStopped && ['parsing', 'planning', 'generating', 'assembling'].includes(record?.state ?? '')) ||
    (!verifiedStopped && ['queued', 'running'].includes(String(job?.status ?? ''))) ||
    // ['active', 'stopping', 'reconcile_required'].includes(record?.control?.phase ?? '') ||
    (record?.control?.phase === 'active' && !['done', 'failed'].includes(record.state)) ||
    ['stopping', 'reconcile_required'].includes(record?.control?.phase ?? '') ||
    Boolean(record?.control?.stopRequested && record.control.phase !== 'stopped')
  const stop = async () => {
    const sessionId = props.sessionId
    if (stoppingSession.current === sessionId) return
    stoppingSession.current = sessionId
    setStopState({ sessionId, stopping: true, failed: false })
    let failed = false
    try {
      // await ipcApi.request('industrial_video.stop', { sessionId })
      const control = await ipcApi.request('industrial_video.stop', { sessionId })
      stoppedEpoch.current = control.epoch
      setStopAcknowledged(sessionId)
      await props.stop()
    } catch (cause) {
      failed = true
      logger.error('停止工业视频任务失败', { sessionId, error: cause })
    } finally {
      try {
        await refresh()
      } catch (cause) {
        failed = true
        logger.error('刷新工业视频停止状态失败', { sessionId, error: cause })
      }
      if (stoppingSession.current === sessionId) {
        stoppingSession.current = null
        setStopState({ sessionId, stopping: false, failed })
      }
    }
  }
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
    (!verifiedStopped && ['parsing', 'planning', 'generating', 'assembling'].includes(record?.state ?? '')) ||
    (!verifiedStopped && ['queued', 'running'].includes(String(job?.status ?? '')))
  return (
    // <AgentComposerSlot {...props} attachmentOnly sendDisabled={props.sendDisabled || props.isStreaming || blocked} />
    <div>
      {stopped && taskBusy && !taskStopping && !stopFailed && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          任务已请求停止，正在核实服务端状态，暂不可发送。
        </p>
      )}
      <AgentComposerSlot
        {...props}
        attachmentOnly
        taskBusy={taskStopping || stopFailed || (!stopped && taskBusy)}
        taskStopping={taskStopping}
        isStreaming={!stopped && props.isStreaming}
        stop={stop}
        sendDisabled={props.sendDisabled || taskBusy || blocked}
      />
    </div>
  )
}
