import { describe, test, expect, beforeEach } from 'bun:test'
import { encode, parseLines, type BridgeToRelay, type RelayToBridge } from './protocol.js'

// ── Isolated unit tests for relay daemon logic ─────────────────────────────
// We can't import relay-daemon.ts directly (it has side effects: Discord login,
// socket listen, etc.), so we re-implement and test the pure logic functions
// that the daemon uses internally.

// ── routeMessage logic ─────────────────────────────────────────────────────

interface MockBridge {
  id: string
  label?: string
  channels: Set<string>
  threads: Set<string>
  received: RelayToBridge[]
}

function createMockBridge(id: string, channels: string[], threads: string[] = [], label?: string): MockBridge {
  return { id, label, channels: new Set(channels), threads: new Set(threads), received: [] }
}

function routeMessage(
  bridges: Map<string, MockBridge>,
  channelId: string,
  threadId: string | null,
  payload: RelayToBridge,
): void {
  for (const [, bridge] of bridges) {
    if (threadId && bridge.threads.has(threadId)) {
      bridge.received.push(payload)
      continue
    }
    if (bridge.channels.has(channelId) || bridge.channels.has('*')) {
      bridge.received.push(payload)
    }
  }
}

const sampleMessage: RelayToBridge = {
  type: 'message',
  channelId: 'ch1',
  messageId: 'm1',
  authorId: 'u1',
  authorUsername: 'TestUser',
  content: 'hello',
  ts: '2025-01-01T00:00:00.000Z',
  attachmentCount: 0,
  attachments: [],
}

describe('routeMessage', () => {
  let bridges: Map<string, MockBridge>

  beforeEach(() => {
    bridges = new Map()
  })

  test('routes to bridge subscribed to specific channel', () => {
    const b = createMockBridge('b1', ['ch1'])
    bridges.set('b1', b)
    routeMessage(bridges, 'ch1', null, sampleMessage)
    expect(b.received).toHaveLength(1)
  })

  test('does not route to bridge subscribed to different channel', () => {
    const b = createMockBridge('b1', ['ch2'])
    bridges.set('b1', b)
    routeMessage(bridges, 'ch1', null, sampleMessage)
    expect(b.received).toHaveLength(0)
  })

  test('routes to wildcard bridge', () => {
    const b = createMockBridge('b1', ['*'])
    bridges.set('b1', b)
    routeMessage(bridges, 'ch1', null, sampleMessage)
    expect(b.received).toHaveLength(1)
  })

  test('routes to bridge subscribed to thread', () => {
    const b = createMockBridge('b1', [], ['th1'])
    bridges.set('b1', b)
    routeMessage(bridges, 'ch1', 'th1', sampleMessage)
    expect(b.received).toHaveLength(1)
  })

  test('does not route thread message to bridge not subscribed to that thread', () => {
    const b = createMockBridge('b1', [], ['th2'])
    bridges.set('b1', b)
    routeMessage(bridges, 'ch1', 'th1', sampleMessage)
    expect(b.received).toHaveLength(0)
  })

  test('routes thread message to wildcard channel bridge', () => {
    const b = createMockBridge('b1', ['*'])
    bridges.set('b1', b)
    routeMessage(bridges, 'ch1', 'th1', sampleMessage)
    expect(b.received).toHaveLength(1)
  })

  test('routes to multiple bridges', () => {
    const b1 = createMockBridge('b1', ['ch1'])
    const b2 = createMockBridge('b2', ['*'])
    const b3 = createMockBridge('b3', ['ch2'])
    bridges.set('b1', b1)
    bridges.set('b2', b2)
    bridges.set('b3', b3)
    routeMessage(bridges, 'ch1', null, sampleMessage)
    expect(b1.received).toHaveLength(1)
    expect(b2.received).toHaveLength(1)
    expect(b3.received).toHaveLength(0)
  })

  test('thread subscriber takes priority but channel subscriber also receives', () => {
    const threadBridge = createMockBridge('b1', [], ['th1'])
    const channelBridge = createMockBridge('b2', ['ch1'])
    bridges.set('b1', threadBridge)
    bridges.set('b2', channelBridge)
    routeMessage(bridges, 'ch1', 'th1', sampleMessage)
    expect(threadBridge.received).toHaveLength(1)
    expect(channelBridge.received).toHaveLength(1)
  })

  test('no bridges means no routing errors', () => {
    routeMessage(bridges, 'ch1', null, sampleMessage)
    // no error thrown
  })
})

// ── Bridge registration/unregistration logic ───────────────────────────────

describe('bridge registration', () => {
  let bridges: Map<string, MockBridge>
  let socketToBridge: Map<string, string>

  beforeEach(() => {
    bridges = new Map()
    socketToBridge = new Map()
  })

  function handleRegister(msg: Extract<BridgeToRelay, { type: 'register' }>, socketId: string): RelayToBridge {
    const bridge: MockBridge = {
      id: msg.bridgeId,
      label: msg.label,
      channels: new Set(msg.channels),
      threads: new Set(msg.threads),
      received: [],
    }
    bridges.set(msg.bridgeId, bridge)
    socketToBridge.set(socketId, msg.bridgeId)
    return { type: 'registered', bridgeId: msg.bridgeId }
  }

  function handleUnregister(msg: Extract<BridgeToRelay, { type: 'unregister' }>, socketId: string): void {
    bridges.delete(msg.bridgeId)
    socketToBridge.delete(socketId)
  }

  function handleDisconnect(socketId: string): void {
    const bridgeId = socketToBridge.get(socketId)
    if (bridgeId) {
      bridges.delete(bridgeId)
      socketToBridge.delete(socketId)
    }
  }

  test('register adds bridge and returns confirmation', () => {
    const result = handleRegister({
      type: 'register',
      bridgeId: 'b1',
      label: 'test',
      channels: ['ch1'],
      threads: [],
    }, 'sock1')
    expect(result).toEqual({ type: 'registered', bridgeId: 'b1' })
    expect(bridges.has('b1')).toBe(true)
    expect(bridges.get('b1')!.channels.has('ch1')).toBe(true)
  })

  test('unregister removes bridge', () => {
    handleRegister({ type: 'register', bridgeId: 'b1', channels: ['ch1'], threads: [] }, 'sock1')
    handleUnregister({ type: 'unregister', bridgeId: 'b1' }, 'sock1')
    expect(bridges.has('b1')).toBe(false)
    expect(socketToBridge.has('sock1')).toBe(false)
  })

  test('disconnect cleans up bridge', () => {
    handleRegister({ type: 'register', bridgeId: 'b1', channels: ['ch1'], threads: [] }, 'sock1')
    handleDisconnect('sock1')
    expect(bridges.has('b1')).toBe(false)
  })

  test('disconnect with unknown socket is a no-op', () => {
    handleDisconnect('unknown')
    expect(bridges.size).toBe(0)
  })

  test('multiple bridges can coexist', () => {
    handleRegister({ type: 'register', bridgeId: 'b1', channels: ['ch1'], threads: [] }, 'sock1')
    handleRegister({ type: 'register', bridgeId: 'b2', channels: ['ch2'], threads: [] }, 'sock2')
    expect(bridges.size).toBe(2)
  })

  test('re-registering same bridgeId replaces bridge', () => {
    handleRegister({ type: 'register', bridgeId: 'b1', channels: ['ch1'], threads: [] }, 'sock1')
    handleRegister({ type: 'register', bridgeId: 'b1', channels: ['ch2'], threads: [] }, 'sock2')
    expect(bridges.size).toBe(1)
    expect(bridges.get('b1')!.channels.has('ch2')).toBe(true)
    expect(bridges.get('b1')!.channels.has('ch1')).toBe(false)
  })
})

// ── Subscribe/unsubscribe logic ────────────────────────────────────────────

describe('subscription management', () => {
  let bridges: Map<string, MockBridge>

  beforeEach(() => {
    bridges = new Map()
    bridges.set('b1', createMockBridge('b1', ['ch1'], ['th1']))
  })

  function handleSubscribe(bridgeId: string, channels?: string[], threads?: string[]): void {
    const bridge = bridges.get(bridgeId)
    if (!bridge) return
    for (const ch of channels ?? []) bridge.channels.add(ch)
    for (const th of threads ?? []) bridge.threads.add(th)
  }

  function handleUnsubscribe(bridgeId: string, channels?: string[], threads?: string[]): void {
    const bridge = bridges.get(bridgeId)
    if (!bridge) return
    for (const ch of channels ?? []) bridge.channels.delete(ch)
    for (const th of threads ?? []) bridge.threads.delete(th)
  }

  test('subscribe adds channels', () => {
    handleSubscribe('b1', ['ch2', 'ch3'])
    const b = bridges.get('b1')!
    expect(b.channels.has('ch1')).toBe(true)
    expect(b.channels.has('ch2')).toBe(true)
    expect(b.channels.has('ch3')).toBe(true)
  })

  test('subscribe adds threads', () => {
    handleSubscribe('b1', undefined, ['th2'])
    const b = bridges.get('b1')!
    expect(b.threads.has('th1')).toBe(true)
    expect(b.threads.has('th2')).toBe(true)
  })

  test('unsubscribe removes channels', () => {
    handleUnsubscribe('b1', ['ch1'])
    const b = bridges.get('b1')!
    expect(b.channels.has('ch1')).toBe(false)
  })

  test('unsubscribe removes threads', () => {
    handleUnsubscribe('b1', undefined, ['th1'])
    const b = bridges.get('b1')!
    expect(b.threads.has('th1')).toBe(false)
  })

  test('subscribe to unknown bridge is a no-op', () => {
    handleSubscribe('nonexistent', ['ch1'])
    // no error thrown
  })

  test('unsubscribe from unknown bridge is a no-op', () => {
    handleUnsubscribe('nonexistent', ['ch1'])
    // no error thrown
  })

  test('subscribe with empty arrays is a no-op', () => {
    handleSubscribe('b1', [], [])
    const b = bridges.get('b1')!
    expect(b.channels.size).toBe(1)
    expect(b.threads.size).toBe(1)
  })

  test('unsubscribe channel not subscribed to is a no-op', () => {
    handleUnsubscribe('b1', ['nonexistent'])
    const b = bridges.get('b1')!
    expect(b.channels.size).toBe(1)
  })
})

// ── Access control (gate logic) ────────────────────────────────────────────

describe('gate logic', () => {
  // Re-implement the gate logic as pure functions for testing
  interface Access {
    dmPolicy: 'pairing' | 'allowlist' | 'disabled'
    allowFrom: string[]
    groups: Record<string, { requireMention: boolean; allowFrom: string[] }>
    pending: Record<string, { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies?: number }>
    mentionPatterns?: string[]
  }

  type GateResult =
    | { action: 'deliver'; access: Access }
    | { action: 'drop' }
    | { action: 'pair'; code: string; isResend: boolean }

  interface MockMessage {
    authorId: string
    channelId: string
    isDM: boolean
    isThread: boolean
    parentId?: string
    isMentioned: boolean
    content: string
  }

  function gate(msg: MockMessage, access: Access, generateCode: () => string): GateResult {
    // Prune expired
    const now = Date.now()
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.expiresAt < now) delete access.pending[code]
    }

    if (access.dmPolicy === 'disabled') return { action: 'drop' }

    if (msg.isDM) {
      if (access.allowFrom.includes(msg.authorId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }

      // Pairing mode
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === msg.authorId) {
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          return { action: 'pair', code, isResend: true }
        }
      }
      if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

      const code = generateCode()
      access.pending[code] = {
        senderId: msg.authorId,
        chatId: msg.channelId,
        createdAt: now,
        expiresAt: now + 60 * 60 * 1000,
        replies: 1,
      }
      return { action: 'pair', code, isResend: false }
    }

    // Guild channel
    const channelId = msg.isThread ? (msg.parentId ?? msg.channelId) : msg.channelId
    const policy = access.groups[channelId] ?? access.groups['*']
    if (!policy) return { action: 'drop' }
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(msg.authorId)) {
      return { action: 'drop' }
    }
    if (policy.requireMention && !msg.isMentioned) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  function defaultAccess(): Access {
    return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
  }

  const dmMsg = (authorId: string): MockMessage => ({
    authorId,
    channelId: 'dm-ch',
    isDM: true,
    isThread: false,
    isMentioned: false,
    content: 'hello',
  })

  const guildMsg = (authorId: string, channelId: string, isMentioned = false): MockMessage => ({
    authorId,
    channelId,
    isDM: false,
    isThread: false,
    isMentioned,
    content: 'hello',
  })

  const threadMsg = (authorId: string, threadId: string, parentId: string, isMentioned = false): MockMessage => ({
    authorId,
    channelId: threadId,
    isDM: false,
    isThread: true,
    parentId,
    isMentioned,
    content: 'hello',
  })

  let codeCounter = 0
  const generateCode = () => `code-${++codeCounter}`

  beforeEach(() => { codeCounter = 0 })

  // DM policy tests
  describe('DM policy: disabled', () => {
    test('drops all DMs when disabled', () => {
      const access: Access = { ...defaultAccess(), dmPolicy: 'disabled' }
      const result = gate(dmMsg('user1'), access, generateCode)
      expect(result.action).toBe('drop')
    })
  })

  describe('DM policy: allowlist', () => {
    test('delivers DM from allowed user', () => {
      const access: Access = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['user1'] }
      const result = gate(dmMsg('user1'), access, generateCode)
      expect(result.action).toBe('deliver')
    })

    test('drops DM from non-allowed user', () => {
      const access: Access = { ...defaultAccess(), dmPolicy: 'allowlist', allowFrom: ['user1'] }
      const result = gate(dmMsg('user2'), access, generateCode)
      expect(result.action).toBe('drop')
    })
  })

  describe('DM policy: pairing', () => {
    test('delivers DM from allowed user', () => {
      const access: Access = { ...defaultAccess(), dmPolicy: 'pairing', allowFrom: ['user1'] }
      const result = gate(dmMsg('user1'), access, generateCode)
      expect(result.action).toBe('deliver')
    })

    test('generates pairing code for unknown user', () => {
      const access = defaultAccess()
      const result = gate(dmMsg('user1'), access, generateCode)
      expect(result.action).toBe('pair')
      if (result.action === 'pair') {
        expect(result.isResend).toBe(false)
        expect(result.code).toBe('code-1')
      }
    })

    test('resends pairing code on second message', () => {
      const access = defaultAccess()
      gate(dmMsg('user1'), access, generateCode)
      const result = gate(dmMsg('user1'), access, generateCode)
      expect(result.action).toBe('pair')
      if (result.action === 'pair') {
        expect(result.isResend).toBe(true)
      }
    })

    test('drops after too many replies from same user', () => {
      const access = defaultAccess()
      gate(dmMsg('user1'), access, generateCode)         // reply 1 (creates pending)
      gate(dmMsg('user1'), access, generateCode)          // reply 2 (resend, bumps to 2)
      const result = gate(dmMsg('user1'), access, generateCode)  // reply 3 (drops, replies >= 2)
      expect(result.action).toBe('drop')
    })

    test('drops when too many pending pairings (max 3)', () => {
      const access = defaultAccess()
      gate(dmMsg('user1'), access, generateCode)
      gate(dmMsg('user2'), access, generateCode)
      gate(dmMsg('user3'), access, generateCode)
      const result = gate(dmMsg('user4'), access, generateCode)
      expect(result.action).toBe('drop')
    })

    test('expired pairings are pruned', () => {
      const access = defaultAccess()
      // Add an expired pending pairing
      access.pending['old-code'] = {
        senderId: 'user1',
        chatId: 'dm-ch',
        createdAt: Date.now() - 2 * 60 * 60 * 1000,
        expiresAt: Date.now() - 1000,
        replies: 1,
      }
      // Should be pruned, allowing a new pairing
      const result = gate(dmMsg('user1'), access, generateCode)
      expect(result.action).toBe('pair')
      if (result.action === 'pair') {
        expect(result.isResend).toBe(false) // new code, not resend
      }
    })
  })

  // Guild channel tests
  describe('guild channels', () => {
    test('drops when no group policy matches', () => {
      const access = defaultAccess()
      const result = gate(guildMsg('user1', 'ch1'), access, generateCode)
      expect(result.action).toBe('drop')
    })

    test('delivers when wildcard group exists and mention present', () => {
      const access: Access = {
        ...defaultAccess(),
        groups: { '*': { requireMention: true, allowFrom: [] } },
      }
      const result = gate(guildMsg('user1', 'ch1', true), access, generateCode)
      expect(result.action).toBe('deliver')
    })

    test('drops when mention required but not present', () => {
      const access: Access = {
        ...defaultAccess(),
        groups: { 'ch1': { requireMention: true, allowFrom: [] } },
      }
      const result = gate(guildMsg('user1', 'ch1', false), access, generateCode)
      expect(result.action).toBe('drop')
    })

    test('delivers when mention not required', () => {
      const access: Access = {
        ...defaultAccess(),
        groups: { 'ch1': { requireMention: false, allowFrom: [] } },
      }
      const result = gate(guildMsg('user1', 'ch1', false), access, generateCode)
      expect(result.action).toBe('deliver')
    })

    test('drops when allowFrom set and user not in it', () => {
      const access: Access = {
        ...defaultAccess(),
        groups: { 'ch1': { requireMention: false, allowFrom: ['user2'] } },
      }
      const result = gate(guildMsg('user1', 'ch1'), access, generateCode)
      expect(result.action).toBe('drop')
    })

    test('delivers when user is in allowFrom', () => {
      const access: Access = {
        ...defaultAccess(),
        groups: { 'ch1': { requireMention: false, allowFrom: ['user1'] } },
      }
      const result = gate(guildMsg('user1', 'ch1'), access, generateCode)
      expect(result.action).toBe('deliver')
    })

    test('thread message uses parent channel for policy lookup', () => {
      const access: Access = {
        ...defaultAccess(),
        groups: { 'parent-ch': { requireMention: false, allowFrom: [] } },
      }
      const result = gate(threadMsg('user1', 'thread-1', 'parent-ch'), access, generateCode)
      expect(result.action).toBe('deliver')
    })

    test('thread message drops if no policy for parent channel', () => {
      const access: Access = {
        ...defaultAccess(),
        groups: { 'other-ch': { requireMention: false, allowFrom: [] } },
      }
      const result = gate(threadMsg('user1', 'thread-1', 'parent-ch'), access, generateCode)
      expect(result.action).toBe('drop')
    })
  })
})

// ── Text chunking ──────────────────────────────────────────────────────────

describe('chunk', () => {
  // Re-implement chunk for testing
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

  test('returns single element for short text', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('returns single element when exactly at limit', () => {
    expect(chunk('abc', 3, 'length')).toEqual(['abc'])
  })

  test('splits at limit in length mode', () => {
    const result = chunk('abcdef', 3, 'length')
    expect(result).toEqual(['abc', 'def'])
  })

  test('splits long text into multiple chunks in length mode', () => {
    const result = chunk('abcdefghij', 3, 'length')
    expect(result.length).toBe(4)
    expect(result.join('')).toBe('abcdefghij')
  })

  test('newline mode prefers paragraph breaks', () => {
    const text = 'first paragraph\n\nsecond paragraph that is quite long'
    const result = chunk(text, 30, 'newline')
    // lastIndexOf('\n\n', 30) finds the position of the first \n in the pair,
    // so the first chunk includes one trailing newline
    expect(result[0]).toBe('first paragraph\n')
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  test('newline mode falls back to line break', () => {
    const text = 'line one\nline two is here and it is longer'
    const result = chunk(text, 20, 'newline')
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  test('newline mode falls back to space', () => {
    const text = 'word1 word2 word3 word4 word5 word6'
    const result = chunk(text, 15, 'newline')
    expect(result.length).toBeGreaterThanOrEqual(2)
    // Each chunk should not exceed 15 chars (except possibly the last)
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].length).toBeLessThanOrEqual(15)
    }
  })

  test('empty text returns single element', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })

  test('strips leading newlines between chunks in newline mode', () => {
    const text = 'aaa\n\nbbb\n\nccc'
    const result = chunk(text, 5, 'newline')
    // After splitting at \n\n, leading newlines from remainder should be stripped
    for (const part of result) {
      expect(part.startsWith('\n')).toBe(false)
    }
  })
})

// ── noteSent / recentSentIds capping ───────────────────────────────────────

describe('noteSent capping', () => {
  test('Set-based LRU respects cap', () => {
    const recentSentIds = new Set<string>()
    const cap = 5

    function noteSent(id: string): void {
      recentSentIds.add(id)
      if (recentSentIds.size > cap) {
        const first = recentSentIds.values().next().value
        if (first) recentSentIds.delete(first)
      }
    }

    for (let i = 0; i < 10; i++) noteSent(`id-${i}`)
    expect(recentSentIds.size).toBe(cap)
    // Oldest entries should be evicted
    expect(recentSentIds.has('id-0')).toBe(false)
    expect(recentSentIds.has('id-4')).toBe(false)
    expect(recentSentIds.has('id-9')).toBe(true)
    expect(recentSentIds.has('id-5')).toBe(true)
  })
})
