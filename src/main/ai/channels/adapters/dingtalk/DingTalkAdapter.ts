import { DWClient, EventAck, type RobotMessage, TOPIC_ROBOT } from 'dingtalk-stream'
import { net } from 'electron'

import { ChannelAdapter, type ChannelAdapterConfig, type SendMessageOptions } from '../../ChannelAdapter'
import { isSlashCommand } from '../../constants'
import { splitMessage } from '../../utils'

type DingTalkRobotMessage = RobotMessage & {
  conversationId: string
  msgId: string
  senderId: string
  senderStaffId?: string
  senderNick?: string
  conversationType: string
  isInAtList?: boolean
  sessionWebhook: string
  sessionWebhookExpiredTime: number
  robotCode?: string
  chatbotUserId?: string
}

type ReplyContext = { webhook: string; expiresAt: number; chatId: string }
type ProactiveTarget = { kind: 'group' | 'user'; userId?: string }
type AccessToken = { value: string; expiresAt: number }

const MAX_MESSAGE_LENGTH = 4000
const MAX_CONTEXTS = 500
const CONTEXT_TTL_MS = 10 * 60 * 1000
const STREAM_CONNECT_TIMEOUT_MS = 15_000
const WEBHOOK_REQUEST_TIMEOUT_MS = 15_000
const ACCESS_TOKEN_REQUEST_TIMEOUT_MS = 15_000
const TOKEN_REFRESH_MARGIN_MS = 60_000
const DINGTALK_API_BASE = 'https://api.dingtalk.com'

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

class DingTalkAdapter extends ChannelAdapter {
  private client: DWClient | null = null
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly allowedChatIds: Set<string>
  private readonly requireMention: boolean
  /**
   * Robot code used by proactive OpenAPI delivery. DingTalk's own robot equals its AppKey
   * (= client_id); only the newer in-app robots expose a distinct code, so an explicit
   * robot_code overrides the default.
   */
  private readonly robotCode: string
  private readonly proactiveTargets = new Map<string, ProactiveTarget>()
  private accessToken: AccessToken | undefined
  private accessTokenRequest: Promise<string> | undefined
  private readonly replyContexts = new Map<string, ReplyContext>()
  private readonly seenMessages = new Map<string, number>()

  constructor(config: ChannelAdapterConfig<'dingtalk'>) {
    super(config)
    this.clientId = config.channelConfig.client_id
    this.clientSecret = config.channelConfig.client_secret
    this.allowedChatIds = new Set(config.channelConfig.allowed_chat_ids ?? [])
    this.requireMention = config.channelConfig.require_mention ?? true
    this.robotCode = config.channelConfig.robot_code?.trim() || this.clientId
    this.notifyChatIds = [...this.allowedChatIds]
  }

  protected override async performConnect(signal: AbortSignal): Promise<void> {
    if (!this.clientId || !this.clientSecret) throw new Error('DingTalk Client ID and Client Secret are required')
    if (signal.aborted) return

    const client = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret
    })
    this.client = client
    client.registerCallbackListener(TOPIC_ROBOT, async (event) => {
      if (signal.aborted || this.client !== client) return
      try {
        const parsed: unknown = JSON.parse(event.data)
        if (!parsed || typeof parsed !== 'object') throw new Error('DingTalk callback payload must be an object')
        await this.handleRobotMessage(parsed as DingTalkRobotMessage)
        client.socketCallBackResponse(event.headers.messageId, { status: EventAck.SUCCESS })
      } catch (error) {
        this.log.error('Failed to process DingTalk callback', {
          error: error instanceof Error ? error.message : String(error)
        })
        client.socketCallBackResponse(event.headers.messageId, { status: EventAck.LATER })
      }
    })

    const disconnect = () => {
      void Promise.resolve(client.disconnect()).catch((error) => {
        this.log.debug('Failed to disconnect DingTalk Stream client', {
          error: error instanceof Error ? error.message : String(error)
        })
      })
    }
    const connectPromise = Promise.resolve(client.connect())
    signal.addEventListener('abort', disconnect, { once: true })
    try {
      await withTimeout(connectPromise, STREAM_CONNECT_TIMEOUT_MS, 'DingTalk Stream connection timed out')
    } catch (error) {
      if (this.client === client) this.client = null
      disconnect()
      throw error
    }
    if (!signal.aborted && this.client === client) {
      this.markConnected()
      this.log.info('DingTalk Stream connected')
    }
  }

  protected override async performDisconnect(): Promise<void> {
    const client = this.client
    this.client = null
    await Promise.resolve(client?.disconnect()).catch((error) => {
      this.log.debug('Failed to disconnect DingTalk Stream client', {
        error: error instanceof Error ? error.message : String(error)
      })
    })
    this.replyContexts.clear()
    this.proactiveTargets.clear()
    this.seenMessages.clear()
    this.markDisconnected()
  }

  private async handleRobotMessage(message: DingTalkRobotMessage): Promise<void> {
    if (!message.msgId || !message.conversationId || !message.senderId || !message.sessionWebhook) return
    this.pruneCaches()
    if (this.seenMessages.has(message.msgId)) return
    this.seenMessages.set(message.msgId, Date.now())

    if (this.allowedChatIds.size && !this.allowedChatIds.has(message.conversationId)) return

    const text = message.text?.content?.trim() ?? ''
    if (!text) return
    const isGroup = message.conversationType === '2'
    if (isGroup && this.requireMention && message.isInAtList !== true) return

    const userId = message.senderStaffId ?? message.senderId
    this.proactiveTargets.set(message.conversationId, isGroup ? { kind: 'group' } : { kind: 'user', userId })
    this.replyContexts.set(message.msgId, {
      webhook: message.sessionWebhook,
      expiresAt: message.sessionWebhookExpiredTime,
      chatId: message.conversationId
    })
    const identity = {
      chatId: message.conversationId,
      conversationId: message.conversationId,
      userId,
      userName: message.senderNick ?? message.senderId,
      messageId: message.msgId
    }
    if (isSlashCommand(text)) {
      const [rawCommand, ...args] = text.trim().split(/\s+/)
      this.emit('command', {
        ...identity,
        command: rawCommand.slice(1).toLowerCase() as 'new' | 'compact' | 'help' | 'whoami',
        args: args.join(' ') || undefined
      })
      return
    }
    this.emit('message', { ...identity, text })
  }

  override async sendMessage(chatId: string, text: string, opts?: SendMessageOptions): Promise<void> {
    const replyId = opts?.replyToMessageId?.toString()
    const context = replyId ? this.replyContexts.get(replyId) : undefined
    if (replyId) {
      if (!context || context.chatId !== chatId || context.expiresAt <= Date.now()) {
        this.replyContexts.delete(replyId)
        throw new Error('DingTalk reply context expired; this message was not delivered')
      }
      await this.sendViaWebhook(context.webhook, text)
      return
    }
    await this.sendProactiveMessage(chatId, text)
  }

  private async sendViaWebhook(webhook: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, MAX_MESSAGE_LENGTH)) {
      const response = await withTimeout(
        net.fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: chunk } })
        }),
        WEBHOOK_REQUEST_TIMEOUT_MS,
        'DingTalk reply request timed out'
      )
      if (!response.ok) throw new Error(`DingTalk reply failed: HTTP ${response.status}`)
    }
  }

  private async sendProactiveMessage(chatId: string, text: string): Promise<void> {
    const target = this.proactiveTargets.get(chatId)
    if (!target && !this.allowedChatIds.has(chatId)) {
      throw new Error('DingTalk proactive delivery target type is unknown; receive a message from this chat first')
    }
    const resolvedTarget = target ?? { kind: 'group' as const }
    if (resolvedTarget.kind === 'user' && !resolvedTarget.userId) {
      throw new Error('DingTalk proactive user delivery requires a sender user id')
    }
    const accessToken = await this.getAccessToken()
    for (const chunk of splitMessage(text, MAX_MESSAGE_LENGTH)) {
      const endpoint =
        resolvedTarget.kind === 'user'
          ? `${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`
          : `${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`
      const body =
        resolvedTarget.kind === 'user'
          ? {
              robotCode: this.robotCode,
              userIds: [resolvedTarget.userId],
              msgKey: 'sampleText',
              msgParam: JSON.stringify({ content: chunk })
            }
          : {
              msgKey: 'sampleText',
              msgParam: JSON.stringify({ content: chunk }),
              openConversationId: chatId,
              robotCode: this.robotCode
            }
      const response = await withTimeout(
        net.fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-acs-dingtalk-access-token': accessToken
          },
          body: JSON.stringify(body)
        }),
        WEBHOOK_REQUEST_TIMEOUT_MS,
        'DingTalk proactive message request timed out'
      )
      if (!response.ok) throw new Error(`DingTalk proactive message failed: HTTP ${response.status}`)
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      return this.accessToken.value
    }
    if (!this.accessTokenRequest) {
      this.accessTokenRequest = this.fetchAccessToken().finally(() => {
        this.accessTokenRequest = undefined
      })
    }
    return this.accessTokenRequest
  }

  private async fetchAccessToken(): Promise<string> {
    const response = await withTimeout(
      net.fetch(`${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret })
      }),
      ACCESS_TOKEN_REQUEST_TIMEOUT_MS,
      'DingTalk access token request timed out'
    )
    if (!response.ok) throw new Error(`DingTalk access token request failed: HTTP ${response.status}`)
    const payload = (await response.json()) as { accessToken?: string; expireIn?: number }
    if (!payload.accessToken) throw new Error('DingTalk access token response did not include accessToken')
    this.accessToken = {
      value: payload.accessToken,
      expiresAt: Date.now() + Math.max(60, payload.expireIn ?? 7200) * 1000
    }
    return payload.accessToken
  }

  override async sendTypingIndicator(): Promise<void> {
    // DingTalk text replies do not have a portable typing indicator.
  }

  private pruneCaches(): void {
    const now = Date.now()
    for (const [id, context] of this.replyContexts) {
      if (context.expiresAt <= now) this.replyContexts.delete(id)
    }
    for (const [id, seenAt] of this.seenMessages) {
      if (now - seenAt > CONTEXT_TTL_MS) this.seenMessages.delete(id)
    }
    while (this.replyContexts.size > MAX_CONTEXTS) this.replyContexts.delete(this.replyContexts.keys().next().value!)
    while (this.seenMessages.size > MAX_CONTEXTS) this.seenMessages.delete(this.seenMessages.keys().next().value!)
  }
}

export function createDingTalkAdapter(config: ChannelAdapterConfig<'dingtalk'>): ChannelAdapter {
  return new DingTalkAdapter(config)
}
