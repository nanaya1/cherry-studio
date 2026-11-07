import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '@cherrystudio/ui'
import type { ComposerContextValue } from '@renderer/components/composer/ComposerContext'
import ComposerSurface from '@renderer/components/composer/ComposerSurface'
import ConversationComposerSlot from '@renderer/components/composer/ConversationComposerSlot'
import { ComposerToolProvider } from '@renderer/components/composer/tools/ComposerToolProvider'

import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

type Props = {
  sessionId: string
  enabled: boolean
  composerContext?: ComposerContextValue
  blocked: boolean
  sendMessage: (message: { text: string }) => Promise<boolean>
  children: ReactNode
}

// 普通任务直接返回原输入，不订阅工业状态，不改变其发送与队列行为。
export default function IndustrialVideoAgentInput({ enabled, children, composerContext, ...props }: Props) {
  if (!enabled) return children
  const input = (
    <ComposerToolProvider key={props.sessionId} actions={{ addNewTopic: () => {}, onTextChange: () => {} }}>
      <VideoInput {...props} />
    </ComposerToolProvider>
  )
  return composerContext ? <ConversationComposerSlot composerContext={composerContext} fallback={input} /> : input
}

function VideoInput({ sessionId, blocked, sendMessage }: Omit<Props, 'enabled' | 'children'>) {
  const production = useIndustrialVideoProduction(sessionId)
  const key = `industrial-video-agent-input:${sessionId}`
  const [text, setText] = useState(() => localStorage.getItem(key) ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const sending = useRef(false)
  const latestText = useRef(text)
  latestText.current = text
  const { refresh } = production
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh])
  const unavailable =
    blocked ||
    Boolean(production.error) ||
    !['storyboard_submitted', 'confirming'].includes(production.record?.state ?? '') ||
    Boolean(production.record?.unknownSubmissions.length) ||
    ['queued', 'running'].includes(String(production.job?.status ?? ''))
  const update = (value: string) => {
    setText(value)
    localStorage.setItem(key, value)
  }
  const submit = async () => {
    const value = text.trim()
    if (!value || unavailable || sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      const accepted = await sendMessage({
        text: `请修改当前工业视频脚本与分镜：\n${value}\n\n修改完成后重新展示服务端审核快照，等待用户重新审核；本条仅为修改请求，不是批准，禁止据此开始付费生成。`
      })
      if (!accepted) throw new Error('修改未提交，草稿已保留，请手动重试。')
      // 发送期间新输入的内容属于下一份草稿，不能被本次成功回执清空。
      if (latestText.current === text) {
        setText('')
        localStorage.removeItem(key)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return (
    <section aria-label="工业视频修改" data-ui="industrial-video.agent-input">
      <ComposerSurface
        text={text}
        onTextChange={update}
        tokens={[]}
        managedTokenKinds={[]}
        onTokensChange={() => {}}
        placeholder="描述希望如何修改当前脚本与分镜…"
        sendDisabled={unavailable || busy || !text.trim()}
        isLoading={false}
        onSendDraft={submit}
        onPause={() => {}}
        supportedExts={[]}
        setFiles={() => {}}
        filesCount={0}
        isExpanded={expanded}
        onExpandedChange={setExpanded}
        quickPanelEnabled={false}
        enableDragDrop={false}
        enableSpellCheck={false}
        fontSize={14}
        narrowMode={false}
        hideSendAction
        topContent={<div className="px-3 pt-3 text-sm font-medium">修改视频需求</div>}
        renderLeftControls={() => (
          <div className="flex w-full items-center justify-between gap-3">
            <p role="status" className="text-xs text-muted-foreground">
              {unavailable
                ? '处理中可写草稿，本轮结束后手动提交，不会自动发送。'
                : '仅提交修改，不会自动批准或开始生成。'}
            </p>
            <Button size="sm" disabled={unavailable || busy || !text.trim()} onClick={() => void submit()}>
              提交修改
            </Button>
          </div>
        )}
      />
      {error && (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
