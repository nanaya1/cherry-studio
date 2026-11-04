import fs from 'fs'

import { DWClient } from 'dingtalk-stream'
import { net } from 'electron'

const DINGTALK_CONNECTION_TIMEOUT_MS = 15_000
const DINGTALK_TOKEN_TIMEOUT_MS = 15_000
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

import { application } from '@application'
import { createAgentChannel, deleteAgentChannel, updateAgentChannel } from '@main/ai/channels'
import { ErrorCode, isDataApiError } from '@shared/data/api/errors'
import { channelErrorCodes } from '@shared/ipc/errors/channel'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { channelRequestSchemas } from '@shared/ipc/schemas/channel'
import type { IpcHandlersFor } from '@shared/ipc/types'

async function exposeChannelError<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isDataApiError(error) && error.code === ErrorCode.NOT_FOUND) {
      throw new IpcError(channelErrorCodes.CHANNEL_NOT_FOUND, error.message)
    }
    if (isDataApiError(error) && error.code === ErrorCode.VALIDATION_ERROR) {
      throw new IpcError(channelErrorCodes.CHANNEL_CONFIG_INVALID, error.message, error.details)
    }
    throw error
  }
}

/**
 * Channel-domain request handlers. `wechat.has_credentials` is self-contained (reads the
 * bot token file, returns whether it exists) — it does not touch ChannelManager; the log /
 * log queries delegate to ChannelManager. The channel.* events are emitted by the adapters / ChannelManager.
 */
export const channelHandlers: IpcHandlersFor<typeof channelRequestSchemas> = {
  'channel.create': async (input) => exposeChannelError(() => createAgentChannel(input)),
  'channel.update': async ({ channelId, updates }) => exposeChannelError(() => updateAgentChannel(channelId, updates)),
  'channel.delete': async ({ channelId }) => {
    await exposeChannelError(async () => {
      if (!(await deleteAgentChannel(channelId))) {
        throw new IpcError(channelErrorCodes.CHANNEL_NOT_FOUND, `Channel with id '${channelId}' not found`)
      }
    })
  },
  'channel.wechat.has_credentials': async (channelId) => {
    const tokenPath = application.getPath('feature.agents.channels', `weixin_bot_${channelId}.json`)
    try {
      const raw = await fs.promises.readFile(tokenPath, 'utf8')
      const parsed = JSON.parse(raw)
      return { exists: true, userId: parsed.userId as string | undefined }
    } catch {
      return { exists: false }
    }
  },
  'channel.dingtalk.test_connection': async ({ client_id, client_secret }) => {
    const client = new DWClient({ clientId: client_id, clientSecret: client_secret })
    try {
      const tokenResponse = await withTimeout(
        net.fetch(`${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appKey: client_id, appSecret: client_secret })
        }),
        DINGTALK_TOKEN_TIMEOUT_MS,
        'DingTalk access token test timed out'
      )
      if (!tokenResponse.ok) return { connected: false, message: 'credentials_invalid' }
      const tokenPayload = (await tokenResponse.json()) as { accessToken?: string }
      if (!tokenPayload.accessToken) return { connected: false, message: 'credentials_invalid' }

      await withTimeout(
        Promise.resolve(client.connect()),
        DINGTALK_CONNECTION_TIMEOUT_MS,
        'DingTalk connection test timed out'
      )
      return { connected: true, message: 'connected' }
    } catch (error) {
      return {
        connected: false,
        message: error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'connection_failed'
      }
    } finally {
      await Promise.resolve(client.disconnect()).catch(() => undefined)
    }
  },
  'channel.get_logs': async (channelId) => application.get('ChannelManager').getChannelLogs(channelId)
}
