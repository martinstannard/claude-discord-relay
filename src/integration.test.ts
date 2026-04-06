import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { encode, parseLines, type BridgeToRelay, type RelayToBridge } from './protocol.js'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Integration tests using a real Unix socket.
 *
 * We spin up a minimal relay-like socket server (no Discord client) and
 * connect bridge clients to it, testing the full message flow:
 * register -> receive messages -> execute actions -> unregister -> cleanup.
 */

// ── Minimal relay server ───────────────────────────────────────────────────

interface BridgeConn {
  id: string
  label?: string
  channels: Set<string>
  threads: Set<string>
  socket: any
}

function createMiniRelay(socketPath: string) {
  const bridges = new Map<string, BridgeConn>()
  const socketToBridge = new Map<any, string>()
  const buffers = new Map<any, string>()

  function sendToBridge(bridge: BridgeConn, msg: RelayToBridge): void {
    bridge.socket.write(encode(msg))
  }

  function routeMessage(channelId: string, threadId: string | null, payload: RelayToBridge): void {
    for (const [, bridge] of bridges) {
      if (threadId && bridge.threads.has(threadId)) {
        sendToBridge(bridge, payload)
        continue
      }
      if (bridge.channels.has(channelId) || bridge.channels.has('*')) {
        sendToBridge(bridge, payload)
      }
    }
  }

  function handleMessage(msg: BridgeToRelay, socket: any): void {
    switch (msg.type) {
      case 'register': {
        const bridge: BridgeConn = {
          id: msg.bridgeId,
          label: msg.label,
          channels: new Set(msg.channels),
          threads: new Set(msg.threads),
          socket,
        }
        bridges.set(msg.bridgeId, bridge)
        socketToBridge.set(socket, msg.bridgeId)
        sendToBridge(bridge, { type: 'registered', bridgeId: msg.bridgeId })
        break
      }
      case 'unregister': {
        bridges.delete(msg.bridgeId)
        socketToBridge.delete(socket)
        break
      }
      case 'subscribe': {
        const bridge = bridges.get(msg.bridgeId)
        if (!bridge) return
        for (const ch of msg.channels ?? []) bridge.channels.add(ch)
        for (const th of msg.threads ?? []) bridge.threads.add(th)
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
        // Simulate action execution
        let result: unknown
        switch (msg.action.name) {
          case 'relay_status':
            result = JSON.stringify({
              connectedBridges: bridges.size,
              sessions: [...bridges.values()].map(b => ({
                id: b.id,
                channels: [...b.channels],
                threads: [...b.threads],
              })),
            })
            break
          case 'reply':
            result = `sent (id: fake-msg-${Date.now()})`
            break
          case 'react':
            result = `reacted ${msg.action.emoji}`
            break
          default:
            result = `executed ${msg.action.name}`
        }
        socket.write(encode({
          type: 'action_result',
          requestId: msg.requestId,
          success: true,
          data: result,
        }))
        break
      }
    }
  }

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        buffers.set(socket, '')
      },
      data(socket, data) {
        const existing = buffers.get(socket) ?? ''
        const combined = existing + data.toString()
        const { messages, remainder } = parseLines(combined)
        buffers.set(socket, remainder)
        for (const msg of messages) {
          handleMessage(msg as BridgeToRelay, socket)
        }
      },
      close(socket) {
        const bridgeId = socketToBridge.get(socket)
        if (bridgeId) {
          bridges.delete(bridgeId)
          socketToBridge.delete(socket)
        }
        buffers.delete(socket)
      },
      error(_socket, err) {
        // ignore in tests
      },
    },
  })

  return { server, bridges, routeMessage }
}

// ── Test client helper ─────────────────────────────────────────────────────

interface TestClient {
  socket: any
  messages: RelayToBridge[]
  waitForMessage(predicate: (msg: RelayToBridge) => boolean, timeoutMs?: number): Promise<RelayToBridge>
  send(msg: BridgeToRelay): void
  close(): void
}

async function connectClient(socketPath: string): Promise<TestClient> {
  const messages: RelayToBridge[] = []
  let buffer = ''
  const waiters: Array<{ predicate: (msg: RelayToBridge) => boolean; resolve: (msg: RelayToBridge) => void; reject: (err: Error) => void }> = []

  return new Promise<TestClient>((resolve, reject) => {
    let clientSocket: any
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          clientSocket = socket
          const client: TestClient = {
            socket,
            messages,
            waitForMessage(predicate, timeoutMs = 5000) {
              // Check already received messages first
              const existing = messages.find(predicate)
              if (existing) return Promise.resolve(existing)

              return new Promise<RelayToBridge>((res, rej) => {
                const timer = setTimeout(() => {
                  const idx = waiters.findIndex(w => w.resolve === res)
                  if (idx >= 0) waiters.splice(idx, 1)
                  rej(new Error(`waitForMessage timed out after ${timeoutMs}ms`))
                }, timeoutMs)
                waiters.push({
                  predicate,
                  resolve: (msg) => { clearTimeout(timer); res(msg) },
                  reject: rej,
                })
              })
            },
            send(msg: BridgeToRelay) {
              socket.write(encode(msg))
            },
            close() {
              socket.end()
            },
          }
          resolve(client)
        },
        data(_socket, data) {
          buffer += data.toString()
          const { messages: parsed, remainder } = parseLines(buffer)
          buffer = remainder
          for (const msg of parsed) {
            const typed = msg as RelayToBridge
            messages.push(typed)
            // Check waiters
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].predicate(typed)) {
                const w = waiters.splice(i, 1)[0]
                w.resolve(typed)
              }
            }
          }
        },
        close() {},
        error(_socket, err) { reject(err) },
      },
    })
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('integration: relay + bridge over Unix socket', () => {
  let tmpDir: string
  let socketPath: string
  let relay: ReturnType<typeof createMiniRelay>
  const clients: TestClient[] = []

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'discord-relay-test-'))
    socketPath = join(tmpDir, 'relay.sock')
    relay = createMiniRelay(socketPath)
  })

  afterEach(() => {
    for (const c of clients) {
      try { c.close() } catch {}
    }
    clients.length = 0
  })

  afterAll(() => {
    relay.server.stop(true)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function newClient(): Promise<TestClient> {
    const c = await connectClient(socketPath)
    clients.push(c)
    return c
  }

  test('register and receive confirmation', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-1', channels: ['ch1'], threads: [] })
    const msg = await client.waitForMessage(m => m.type === 'registered')
    expect(msg.type).toBe('registered')
    expect((msg as any).bridgeId).toBe('test-1')
  })

  test('receive routed message after registration', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-2', channels: ['ch1'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    // Simulate an inbound Discord message via the relay
    const payload: RelayToBridge = {
      type: 'message',
      channelId: 'ch1',
      messageId: 'm1',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'Hello from Discord!',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    }
    relay.routeMessage('ch1', null, payload)

    const msg = await client.waitForMessage(m => m.type === 'message')
    expect(msg.type).toBe('message')
    expect((msg as any).content).toBe('Hello from Discord!')
  })

  test('message not routed to unsubscribed channel', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-3', channels: ['ch1'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    const payload: RelayToBridge = {
      type: 'message',
      channelId: 'ch2',
      messageId: 'm2',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'wrong channel',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    }
    relay.routeMessage('ch2', null, payload)

    // Wait a bit to make sure nothing arrives
    await new Promise(r => setTimeout(r, 200))
    const received = client.messages.filter(m => m.type === 'message')
    expect(received).toHaveLength(0)
  })

  test('wildcard subscription receives all channels', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-4', channels: ['*'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    for (const ch of ['ch1', 'ch2', 'ch3']) {
      relay.routeMessage(ch, null, {
        type: 'message',
        channelId: ch,
        messageId: `m-${ch}`,
        authorId: 'u1',
        authorUsername: 'TestUser',
        content: `msg in ${ch}`,
        ts: new Date().toISOString(),
        attachmentCount: 0,
        attachments: [],
      })
    }

    // Wait for all 3
    await client.waitForMessage(m => m.type === 'message' && (m as any).channelId === 'ch3')
    const received = client.messages.filter(m => m.type === 'message')
    expect(received).toHaveLength(3)
  })

  test('execute action and get result', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-5', channels: [], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    client.send({
      type: 'action',
      bridgeId: 'test-5',
      requestId: 'req-1',
      action: { name: 'relay_status' },
    })

    const result = await client.waitForMessage(m => m.type === 'action_result')
    expect(result.type).toBe('action_result')
    expect((result as any).requestId).toBe('req-1')
    expect((result as any).success).toBe(true)
  })

  test('execute reply action returns sent confirmation', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-6', channels: [], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    client.send({
      type: 'action',
      bridgeId: 'test-6',
      requestId: 'req-2',
      action: { name: 'reply', chatId: 'ch1', text: 'Hello!' },
    })

    const result = await client.waitForMessage(m => m.type === 'action_result' && (m as any).requestId === 'req-2')
    expect((result as any).success).toBe(true)
    expect(typeof (result as any).data).toBe('string')
    expect((result as any).data).toContain('sent')
  })

  test('subscribe dynamically adds channels', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-7', channels: ['ch1'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    // Subscribe to ch2
    client.send({ type: 'subscribe', bridgeId: 'test-7', channels: ['ch2'] })

    // Small delay for subscription to process
    await new Promise(r => setTimeout(r, 100))

    relay.routeMessage('ch2', null, {
      type: 'message',
      channelId: 'ch2',
      messageId: 'm-sub',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'after subscribe',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    })

    const msg = await client.waitForMessage(m => m.type === 'message' && (m as any).channelId === 'ch2')
    expect((msg as any).content).toBe('after subscribe')
  })

  test('unsubscribe stops message delivery', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-8', channels: ['ch1', 'ch2'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    // Unsubscribe from ch1
    client.send({ type: 'unsubscribe', bridgeId: 'test-8', channels: ['ch1'] })
    await new Promise(r => setTimeout(r, 100))

    relay.routeMessage('ch1', null, {
      type: 'message',
      channelId: 'ch1',
      messageId: 'm-unsub',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'should not arrive',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    })

    await new Promise(r => setTimeout(r, 200))
    const received = client.messages.filter(m => m.type === 'message')
    expect(received).toHaveLength(0)
  })

  test('unregister stops all message delivery', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-9', channels: ['*'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    // Unregister
    client.send({ type: 'unregister', bridgeId: 'test-9' })
    await new Promise(r => setTimeout(r, 100))

    relay.routeMessage('ch1', null, {
      type: 'message',
      channelId: 'ch1',
      messageId: 'm-unreg',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'should not arrive',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    })

    await new Promise(r => setTimeout(r, 200))
    const received = client.messages.filter(m => m.type === 'message')
    expect(received).toHaveLength(0)
  })

  test('cleanup on disconnect removes bridge', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'test-10', channels: ['ch1'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')
    expect(relay.bridges.has('test-10')).toBe(true)

    // Close the socket
    client.close()
    // Remove from our tracking so afterEach doesn't double-close
    clients.splice(clients.indexOf(client), 1)

    await new Promise(r => setTimeout(r, 200))
    expect(relay.bridges.has('test-10')).toBe(false)
  })

  test('multiple bridges receive messages independently', async () => {
    const client1 = await newClient()
    const client2 = await newClient()

    client1.send({ type: 'register', bridgeId: 'multi-1', channels: ['ch1'], threads: [] })
    client2.send({ type: 'register', bridgeId: 'multi-2', channels: ['ch1', 'ch2'], threads: [] })

    await client1.waitForMessage(m => m.type === 'registered')
    await client2.waitForMessage(m => m.type === 'registered')

    // Message to ch1 — both should get it
    relay.routeMessage('ch1', null, {
      type: 'message',
      channelId: 'ch1',
      messageId: 'm-multi-1',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'to both',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    })

    // Message to ch2 — only client2
    relay.routeMessage('ch2', null, {
      type: 'message',
      channelId: 'ch2',
      messageId: 'm-multi-2',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'only client2',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    })

    await client2.waitForMessage(m => m.type === 'message' && (m as any).channelId === 'ch2')
    await new Promise(r => setTimeout(r, 100))

    const c1msgs = client1.messages.filter(m => m.type === 'message')
    const c2msgs = client2.messages.filter(m => m.type === 'message')
    expect(c1msgs).toHaveLength(1)
    expect(c2msgs).toHaveLength(2)
  })

  test('thread subscription routes correctly', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'thread-1', channels: [], threads: ['th1'] })
    await client.waitForMessage(m => m.type === 'registered')

    // Route a thread message
    relay.routeMessage('ch1', 'th1', {
      type: 'message',
      channelId: 'th1',
      messageId: 'm-thread',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'thread message',
      ts: new Date().toISOString(),
      attachmentCount: 0,
      attachments: [],
    })

    const msg = await client.waitForMessage(m => m.type === 'message')
    expect((msg as any).content).toBe('thread message')
  })

  test('rapid sequential messages are all delivered', async () => {
    const client = await newClient()
    client.send({ type: 'register', bridgeId: 'rapid-1', channels: ['ch1'], threads: [] })
    await client.waitForMessage(m => m.type === 'registered')

    const count = 20
    for (let i = 0; i < count; i++) {
      relay.routeMessage('ch1', null, {
        type: 'message',
        channelId: 'ch1',
        messageId: `m-rapid-${i}`,
        authorId: 'u1',
        authorUsername: 'TestUser',
        content: `msg ${i}`,
        ts: new Date().toISOString(),
        attachmentCount: 0,
        attachments: [],
      })
    }

    // Wait for the last one
    await client.waitForMessage(m => m.type === 'message' && (m as any).messageId === `m-rapid-${count - 1}`)
    const received = client.messages.filter(m => m.type === 'message')
    expect(received).toHaveLength(count)
  })
})
