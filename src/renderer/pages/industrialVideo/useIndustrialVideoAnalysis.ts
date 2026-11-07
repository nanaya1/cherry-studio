import { useCallback, useEffect, useRef, useState } from 'react'

import { ipcApi } from '@renderer/ipc'
import type { FileUIPart } from '@shared/data/types/message'
import type { Model } from '@shared/data/types/model'
import { withCherryMeta } from '@shared/data/types/uiParts'

export function useIndustrialVideoAnalysis() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const cancel = () => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setRunning(false)
  }
  useEffect(
    () => () => {
      controllerRef.current?.abort()
      controllerRef.current = null
    },
    []
  )

  const analyze = async (
    model: Model,
    prompt: string,
    content: string,
    files: FileUIPart[] = []
  ): Promise<string | undefined> => {
    if (controllerRef.current) return undefined
    const controller = new AbortController()
    controllerRef.current = controller
    setRunning(true)
    setResult('')
    setError('')
    const requestId = crypto.randomUUID()
    const relayAbort = () => void ipcApi.request('ai.text.abort', { requestId }).catch(() => undefined)
    controller.signal.addEventListener('abort', relayAbort, { once: true })
    try {
      const textPart = withCherryMeta(
        { type: 'text' as const, text: content },
        {
          composer: {
            version: 1,
            tokens: files.flatMap((file) => {
              const sourceId = file.providerMetadata?.cherry?.fileTokenSourceId
              return typeof sourceId === 'string'
                ? [
                    {
                      id: `file:${sourceId}`,
                      kind: 'file' as const,
                      label: file.filename ?? 'file',
                      index: 0,
                      textOffset: 0
                    }
                  ]
                : []
            })
          }
        }
      )
      const response = await ipcApi.request('ai.text.generate', {
        requestId,
        uniqueModelId: model.id,
        reasoningEffort: 'none',
        system: prompt,
        uiMessages: [{ id: crypto.randomUUID(), role: 'user', parts: [textPart, ...files] }]
      })
      const text = response.text
      if (controllerRef.current !== controller || controller.signal.aborted) return
      if (!text.trim()) throw new Error('industrial_video.empty_analysis')
      setResult(text)
      return text
    } catch (cause) {
      if (controllerRef.current === controller && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      controller.signal.removeEventListener('abort', relayAbort)
      if (controllerRef.current === controller) {
        controllerRef.current = null
        setRunning(false)
      }
    }
    return undefined
  }
  const invalidate = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setRunning(false)
    setResult('')
    setError('')
  }, [])
  return { running, result, error, analyze, cancel, invalidate }
}
