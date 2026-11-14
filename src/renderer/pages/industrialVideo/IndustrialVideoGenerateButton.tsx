import { useRef, useState } from 'react'

import { Button } from '@cherrystudio/ui'

interface Props {
  sendMessage: (message: { text: string }) => Promise<boolean>
}

// 单一来源：审核按钮确认成功后也发送同一条生成消息，避免多处硬编码。
export const START_VIDEO_MESSAGE = '开始生成视频'

export default function IndustrialVideoGenerateButton({ sendMessage }: Props) {
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const sendingRef = useRef(false)

  const handleClick = async () => {
    if (sendingRef.current || sent) return
    sendingRef.current = true
    setSending(true)
    try {
      const succeeded = await sendMessage({ text: START_VIDEO_MESSAGE })
      if (succeeded) setSent(true)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <Button type="button" size="sm" disabled={sending || sent} onClick={handleClick}>
      {sent ? '已发送' : START_VIDEO_MESSAGE}
    </Button>
  )
}
