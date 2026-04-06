/**
 * Shared types for relay <-> bridge communication.
 * Messages are newline-delimited JSON over a Unix domain socket.
 */

// ── Bridge → Relay ──────────────────────────────────────────────────────────

export type BridgeToRelay =
  | { type: 'register'; bridgeId: string; label?: string; channels: string[]; threads: string[] }
  | { type: 'unregister'; bridgeId: string }
  | { type: 'subscribe'; bridgeId: string; channels?: string[]; threads?: string[] }
  | { type: 'unsubscribe'; bridgeId: string; channels?: string[]; threads?: string[] }
  | { type: 'action'; bridgeId: string; requestId: string; action: DiscordAction }

export type DiscordAction =
  | { name: 'reply'; chatId: string; text: string; replyTo?: string; files?: string[] }
  | { name: 'react'; chatId: string; messageId: string; emoji: string }
  | { name: 'edit_message'; chatId: string; messageId: string; text: string }
  | { name: 'fetch_messages'; channel: string; limit?: number }
  | { name: 'create_channel'; guildId: string; channelName: string; topic?: string; categoryId?: string }
  | { name: 'list_channels'; guildId: string }
  | { name: 'create_thread'; chatId: string; messageId: string; threadName: string }
  | { name: 'pin_message'; chatId: string; messageId: string }
  | { name: 'unpin_message'; chatId: string; messageId: string }
  | { name: 'delete_channel'; channelId: string }
  | { name: 'move_channel'; channelId: string; categoryId: string }
  | { name: 'set_channel_topic'; channelId: string; topic: string }
  | { name: 'download_attachment'; chatId: string; messageId: string }
  | { name: 'relay_status' }
  | { name: 'spawn_session'; channels: string[]; threads: string[]; label?: string; prompt?: string }

// ── Relay → Bridge ──────────────────────────────────────────────────────────

export type RelayToBridge =
  | { type: 'registered'; bridgeId: string }
  | { type: 'message'; channelId: string; messageId: string; authorId: string; authorUsername: string; content: string; ts: string; attachmentCount: number; attachments: AttachmentMeta[] }
  | { type: 'action_result'; requestId: string; success: boolean; data?: unknown; error?: string }
  | { type: 'error'; message: string }

export interface AttachmentMeta {
  name: string
  contentType: string
  size: number
}

// ── Access control (shared with relay daemon) ───────────────────────────────

export interface GroupPolicy {
  requireMention: boolean
  allowFrom: string[]
}

export interface Access {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingPairing>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export interface PendingPairing {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies?: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function encode(msg: BridgeToRelay | RelayToBridge): string {
  return JSON.stringify(msg) + '\n'
}

export function parseLines(buf: string): { messages: (BridgeToRelay | RelayToBridge)[]; remainder: string } {
  const lines = buf.split('\n')
  const remainder = lines.pop() ?? '' // last element is either empty or incomplete
  const messages: (BridgeToRelay | RelayToBridge)[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      // skip malformed lines
    }
  }
  return { messages, remainder }
}

// Paths
export const STATE_DIR = process.env.DISCORD_RELAY_STATE_DIR
  ?? `${process.env.HOME ?? require('os').homedir()}/.claude/channels/discord-relay`
export const SOCKET_PATH = `${STATE_DIR}/relay.sock`
export const PID_FILE = `${STATE_DIR}/relay.pid`
export const ACCESS_FILE = `${STATE_DIR}/access.json`
export const APPROVED_DIR = `${STATE_DIR}/approved`
export const ENV_FILE = `${STATE_DIR}/.env`
export const INBOX_DIR = `${STATE_DIR}/inbox`
