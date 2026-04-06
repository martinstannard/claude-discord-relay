#!/usr/bin/env bun
/**
 * Discord Relay Daemon
 *
 * Long-lived process that owns the Discord bot connection and routes messages
 * to/from multiple Claude Code sessions (bridges) via a Unix domain socket.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type Attachment,
} from 'discord.js'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, unlinkSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import {
  type BridgeToRelay,
  type RelayToBridge,
  type DiscordAction,
  type Access,
  type AttachmentMeta,
  encode,
  parseLines,
  STATE_DIR,
  SOCKET_PATH,
  PID_FILE,
  ACCESS_FILE,
  APPROVED_DIR,
  INBOX_DIR,
  ENV_FILE,
} from './protocol.js'

// ── Bootstrap ───────────────────────────────────────────────────────────────

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

// Load bot token
let TOKEN = process.env.DISCORD_BOT_TOKEN ?? ''
if (!TOKEN) {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && m[1] === 'DISCORD_BOT_TOKEN') TOKEN = m[2]
    }
  } catch {}
}
if (!TOKEN) {
  process.stderr.write('discord-relay: no DISCORD_BOT_TOKEN found\n')
  process.exit(1)
}

// Write PID file
writeFileSync(PID_FILE, String(process.pid) + '\n')

// Clean up stale socket
if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH) } catch {}
}

process.on('unhandledRejection', err => {
  process.stderr.write(`discord-relay: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`discord-relay: uncaught exception: ${err}\n`)
})

// ── Access control ──────────────────────────────────────────────────────────

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write('discord-relay: access.json corrupt, moved aside\n')
    return defaultAccess()
  }
}

function saveAccess(a: Access): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

// ── Discord client ──────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

const MAX_CHUNK_LIMIT = 2000
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// Track sent message IDs for mention detection
const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200

function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true
  const refId = msg.reference?.messageId
  if (refId) {
    if (recentSentIds.has(refId)) return true
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch {}
  }
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(msg.content)) return true } catch {}
  }
  return false
}

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

async function gate(msg: Message): Promise<GateResult> {
  const access = readAccessFile()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: msg.channelId,
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  // Guild channel
  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId
  const policy = access.groups[channelId] ?? access.groups['*']
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  const requireMention = policy.requireMention ?? true
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }
  if (requireMention && !(await isMentioned(msg, access.mentionPatterns))) {
    return { action: 'drop' }
  }
  return { action: 'deliver', access }
}

// ── Approval polling ────────────────────────────────────────────────────────

function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    let dmChannelId: string
    try { dmChannelId = readFileSync(file, 'utf8').trim() } catch { rmSync(file, { force: true }); continue }
    if (!dmChannelId) { rmSync(file, { force: true }); continue }

    void (async () => {
      try {
        const ch = await client.channels.fetch(dmChannelId)
        if (ch && 'send' in ch) await ch.send('Paired! Say hi to Claude.')
        rmSync(file, { force: true })
      } catch (err) {
        process.stderr.write(`discord-relay: approval confirm failed: ${err}\n`)
        rmSync(file, { force: true })
      }
    })()
  }
}

setInterval(checkApprovals, 5000).unref()

// ── Text chunking ───────────────────────────────────────────────────────────

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function assertSendable(f: string): void {
  let real: string, stateReal: string
  try { real = realpathSync(f); stateReal = realpathSync(STATE_DIR) } catch { return }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

// ── Bridge connection management ────────────────────────────────────────────

interface BridgeConnection {
  id: string
  label?: string
  channels: Set<string>  // subscribed channel IDs ('*' for wildcard)
  threads: Set<string>   // subscribed thread IDs
  socket: any            // Bun socket
  buffer: string
}

const bridges = new Map<string, BridgeConnection>()
// Reverse map: socket -> bridgeId
const socketToBridge = new Map<any, string>()

function routeMessage(channelId: string, threadId: string | null, payload: RelayToBridge): void {
  for (const [, bridge] of bridges) {
    // Check explicit thread subscription first
    if (threadId && bridge.threads.has(threadId)) {
      sendToBridge(bridge, payload)
      continue
    }
    // Check channel subscription
    if (bridge.channels.has(channelId) || bridge.channels.has('*')) {
      // But skip if another bridge has an explicit thread subscription and this is a thread
      sendToBridge(bridge, payload)
    }
  }
}

function sendToBridge(bridge: BridgeConnection, msg: RelayToBridge): void {
  try {
    bridge.socket.write(encode(msg))
  } catch (err) {
    process.stderr.write(`discord-relay: failed to send to bridge ${bridge.id}: ${err}\n`)
  }
}

// ── Discord action execution ────────────────────────────────────────────────

async function executeAction(action: DiscordAction): Promise<unknown> {
  switch (action.name) {
    case 'reply': {
      const ch = await client.channels.fetch(action.chatId)
      if (!ch || !('send' in ch)) throw new Error('channel not sendable')

      for (const f of action.files ?? []) {
        assertSendable(f)
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: ${f}`)
      }

      const access = readAccessFile()
      const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
      const mode = access.chunkMode ?? 'length'
      const replyMode = access.replyToMode ?? 'first'
      const chunks = chunk(action.text, limit, mode)
      const sentIds: string[] = []
      const files = action.files ?? []

      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo = action.replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
        const sent = await (ch as any).send({
          content: chunks[i],
          ...(i === 0 && files.length > 0 ? { files } : {}),
          ...(shouldReplyTo ? { reply: { messageReference: action.replyTo, failIfNotExists: false } } : {}),
        })
        noteSent(sent.id)
        sentIds.push(sent.id)
      }
      return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    }

    case 'react': {
      const ch = await client.channels.fetch(action.chatId)
      if (!ch || !('messages' in ch)) throw new Error('channel not found')
      const msg = await (ch as any).messages.fetch(action.messageId)
      await msg.react(action.emoji)
      return `reacted ${action.emoji}`
    }

    case 'edit_message': {
      const ch = await client.channels.fetch(action.chatId)
      if (!ch || !('messages' in ch)) throw new Error('channel not found')
      const msg = await (ch as any).messages.fetch(action.messageId)
      await msg.edit(action.text)
      return `edited message ${action.messageId}`
    }

    case 'fetch_messages': {
      const ch = await client.channels.fetch(action.channel)
      if (!ch || !ch.isTextBased()) throw new Error('channel not found or not text-based')
      const limit = Math.min(action.limit ?? 20, 100)
      const msgs = await ch.messages.fetch({ limit })
      const me = client.user?.id
      const arr = [...msgs.values()].reverse()
      if (arr.length === 0) return '(no messages)'
      return arr.map(m => {
        const who = m.author.id === me ? 'me' : m.author.username
        const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
        const clean = m.content.replace(/\n/g, ' ').slice(0, 300)
        return `[${m.createdAt.toISOString()}] ${who}: ${clean}${atts}  (id: ${m.id})`
      }).join('\n')
    }

    case 'create_channel': {
      const guild = await client.guilds.fetch(action.guildId)
      const channel = await guild.channels.create({
        name: action.channelName,
        type: ChannelType.GuildText,
        ...(action.topic ? { topic: action.topic } : {}),
        ...(action.categoryId ? { parent: action.categoryId } : {}),
      })
      return `created #${channel.name} (id: ${channel.id})`
    }

    case 'list_channels': {
      const guild = await client.guilds.fetch(action.guildId)
      const channels = await guild.channels.fetch()
      const lines = [...channels.values()]
        .filter(c => c !== null)
        .sort((a, b) => (a!.position ?? 0) - (b!.position ?? 0))
        .map(c => {
          const type = c!.type === ChannelType.GuildText ? 'text'
            : c!.type === ChannelType.GuildVoice ? 'voice'
            : c!.type === ChannelType.GuildCategory ? 'category'
            : c!.type === ChannelType.GuildForum ? 'forum'
            : String(c!.type)
          const parent = c!.parentId ? ` (in ${c!.parentId})` : ''
          return `${type}: #${c!.name} — ${c!.id}${parent}`
        })
      return lines.join('\n') || '(no channels)'
    }

    case 'create_thread': {
      const ch = await client.channels.fetch(action.chatId)
      if (!ch || !('messages' in ch)) throw new Error('channel not found')
      const msg = await (ch as any).messages.fetch(action.messageId)
      const thread = await msg.startThread({ name: action.threadName })
      return `created thread "${thread.name}" (id: ${thread.id})`
    }

    case 'pin_message': {
      const ch = await client.channels.fetch(action.chatId)
      if (!ch || !('messages' in ch)) throw new Error('channel not found')
      const msg = await (ch as any).messages.fetch(action.messageId)
      await msg.pin()
      return `pinned message ${action.messageId}`
    }

    case 'unpin_message': {
      const ch = await client.channels.fetch(action.chatId)
      if (!ch || !('messages' in ch)) throw new Error('channel not found')
      const msg = await (ch as any).messages.fetch(action.messageId)
      await msg.unpin()
      return `unpinned message ${action.messageId}`
    }

    case 'delete_channel': {
      const ch = await client.channels.fetch(action.channelId)
      if (!ch) throw new Error('channel not found')
      const name = 'name' in ch ? ch.name : action.channelId
      await ch.delete()
      return `deleted channel #${name}`
    }

    case 'move_channel': {
      const ch = await client.channels.fetch(action.channelId)
      if (!ch || !('setParent' in ch)) throw new Error('channel not found or cannot be moved')
      await (ch as any).setParent(action.categoryId)
      return `moved #${(ch as any).name} into category ${action.categoryId}`
    }

    case 'set_channel_topic': {
      const ch = await client.channels.fetch(action.channelId)
      if (!ch || !('setTopic' in ch)) throw new Error('channel not found or does not support topics')
      await (ch as any).setTopic(action.topic)
      return `set topic on #${(ch as any).name}: ${action.topic}`
    }

    case 'download_attachment': {
      const ch = await client.channels.fetch(action.chatId)
      if (!ch || !('messages' in ch)) throw new Error('channel not found')
      const msg = await (ch as any).messages.fetch(action.messageId)
      const paths: string[] = []
      for (const att of msg.attachments.values()) {
        if (att.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment too large: ${att.name}`)
        const res = await fetch(att.url)
        const buf = Buffer.from(await res.arrayBuffer())
        const name = (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_')
        const path = join(INBOX_DIR, `${msg.id}-${name}`)
        writeFileSync(path, buf)
        paths.push(path)
      }
      return paths.length > 0 ? paths.join('\n') : '(no attachments)'
    }

    case 'relay_status': {
      const sessions = [...bridges.values()].map(b => ({
        id: b.id,
        label: b.label,
        channels: [...b.channels],
        threads: [...b.threads],
      }))
      return JSON.stringify({ connectedBridges: sessions.length, sessions }, null, 2)
    }

    case 'spawn_session': {
      const channels = action.channels.join(',')
      const threads = action.threads.join(',')
      const label = action.label ?? `session-${Date.now()}`
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        DISCORD_RELAY_CHANNELS: channels,
        DISCORD_RELAY_THREADS: threads,
        DISCORD_RELAY_LABEL: label,
      }
      const args = action.prompt
        ? ['claude', '-p', action.prompt]
        : ['claude']
      const proc = Bun.spawn(args, { env, stdio: ['inherit', 'inherit', 'inherit'] })
      return `spawned Claude session "${label}" (pid: ${proc.pid})`
    }

    default:
      throw new Error(`unknown action: ${(action as any).name}`)
  }
}

// ── Handle bridge messages ──────────────────────────────────────────────────

async function handleBridgeMessage(msg: BridgeToRelay, socket: any): Promise<void> {
  switch (msg.type) {
    case 'register': {
      const bridge: BridgeConnection = {
        id: msg.bridgeId,
        label: msg.label,
        channels: new Set(msg.channels),
        threads: new Set(msg.threads),
        socket,
        buffer: '',
      }
      bridges.set(msg.bridgeId, bridge)
      socketToBridge.set(socket, msg.bridgeId)
      process.stderr.write(`discord-relay: bridge registered: ${msg.bridgeId} (${msg.label ?? 'no label'}) channels=[${msg.channels}] threads=[${msg.threads}]\n`)
      sendToBridge(bridge, { type: 'registered', bridgeId: msg.bridgeId })
      break
    }

    case 'unregister': {
      bridges.delete(msg.bridgeId)
      socketToBridge.delete(socket)
      process.stderr.write(`discord-relay: bridge unregistered: ${msg.bridgeId}\n`)
      break
    }

    case 'subscribe': {
      const bridge = bridges.get(msg.bridgeId)
      if (!bridge) return
      for (const ch of msg.channels ?? []) bridge.channels.add(ch)
      for (const th of msg.threads ?? []) bridge.threads.add(th)
      process.stderr.write(`discord-relay: bridge ${msg.bridgeId} subscribed to channels=[${msg.channels}] threads=[${msg.threads}]\n`)
      break
    }

    case 'unsubscribe': {
      const bridge = bridges.get(msg.bridgeId)
      if (!bridge) return
      for (const ch of msg.channels ?? []) bridge.channels.delete(ch)
      for (const th of msg.threads ?? []) bridge.threads.delete(th)
      break
    }

    case 'action': {
      try {
        const result = await executeAction(msg.action)
        const response: RelayToBridge = { type: 'action_result', requestId: msg.requestId, success: true, data: result }
        socket.write(encode(response))
      } catch (err) {
        const response: RelayToBridge = { type: 'action_result', requestId: msg.requestId, success: false, error: String(err) }
        socket.write(encode(response))
      }
      break
    }
  }
}

// ── Unix socket server ──────────────────────────────────────────────────────

const buffers = new Map<any, string>()

Bun.listen({
  unix: SOCKET_PATH,
  socket: {
    open(socket) {
      buffers.set(socket, '')
      process.stderr.write('discord-relay: bridge connected\n')
    },

    data(socket, data) {
      const existing = buffers.get(socket) ?? ''
      const combined = existing + data.toString()
      const { messages, remainder } = parseLines(combined)
      buffers.set(socket, remainder)

      for (const msg of messages) {
        handleBridgeMessage(msg as BridgeToRelay, socket).catch(err => {
          process.stderr.write(`discord-relay: error handling bridge message: ${err}\n`)
        })
      }
    },

    close(socket) {
      const bridgeId = socketToBridge.get(socket)
      if (bridgeId) {
        bridges.delete(bridgeId)
        socketToBridge.delete(socket)
        process.stderr.write(`discord-relay: bridge disconnected: ${bridgeId}\n`)
      }
      buffers.delete(socket)
    },

    error(socket, err) {
      process.stderr.write(`discord-relay: socket error: ${err}\n`)
    },
  },
})

process.stderr.write(`discord-relay: listening on ${SOCKET_PATH}\n`)

// ── Discord message handler ─────────────────────────────────────────────────

client.on('messageCreate', async (msg: Message) => {
  if (msg.author.bot) return

  const result = await gate(msg)

  if (result.action === 'pair') {
    const text = result.isResend
      ? `Your pairing code is still: \`${result.code}\`\nTell the Claude Code user to run: \`/discord:access pair ${result.code}\``
      : `Hi! To connect, tell the Claude Code user to run:\n\`/discord:access pair ${result.code}\``
    if ('send' in msg.channel) await msg.channel.send(text)
    return
  }

  if (result.action === 'drop') return

  // Ack reaction
  const access = result.access
  if (access.ackReaction !== undefined && access.ackReaction !== '') {
    try { await msg.react(access.ackReaction) } catch {}
  }

  // Build payload
  const attachments: AttachmentMeta[] = [...msg.attachments.values()].map(a => ({
    name: a.name ?? a.id,
    contentType: a.contentType ?? 'application/octet-stream',
    size: a.size,
  }))

  const channelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId
  const threadId = msg.channel.isThread() ? msg.channelId : null

  const payload: RelayToBridge = {
    type: 'message',
    channelId: msg.channelId, // actual channel/thread the message is in
    messageId: msg.id,
    authorId: msg.author.id,
    authorUsername: msg.author.username,
    content: msg.content,
    ts: msg.createdAt.toISOString(),
    attachmentCount: attachments.length,
    attachments,
  }

  // Route to subscribed bridges
  routeMessage(channelId, threadId, payload)
})

client.on('ready', () => {
  process.stderr.write(`discord-relay: bot logged in as ${client.user?.tag}\n`)
})

// ── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown() {
  process.stderr.write('discord-relay: shutting down\n')
  client.destroy()
  try { unlinkSync(SOCKET_PATH) } catch {}
  try { unlinkSync(PID_FILE) } catch {}
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ───────────────────────────────────────────────────────────────────

await client.login(TOKEN)
