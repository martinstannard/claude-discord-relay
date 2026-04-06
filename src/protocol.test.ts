import { describe, test, expect } from 'bun:test'
import { encode, parseLines, type BridgeToRelay, type RelayToBridge } from './protocol.js'

// ── encode ─────────────────────────────────────────────────────────────────

describe('encode', () => {
  test('produces newline-delimited JSON', () => {
    const msg: RelayToBridge = { type: 'registered', bridgeId: 'abc' }
    const result = encode(msg)
    expect(result).toBe('{"type":"registered","bridgeId":"abc"}\n')
  })

  test('encodes complex nested objects', () => {
    const msg: BridgeToRelay = {
      type: 'action',
      bridgeId: 'b1',
      requestId: 'r1',
      action: { name: 'reply', chatId: 'ch1', text: 'hello' },
    }
    const result = encode(msg)
    expect(result.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(result.trim())
    expect(parsed.type).toBe('action')
    expect(parsed.action.name).toBe('reply')
  })

  test('handles special characters in text', () => {
    const msg: BridgeToRelay = {
      type: 'action',
      bridgeId: 'b1',
      requestId: 'r1',
      action: { name: 'reply', chatId: 'ch1', text: 'line1\nline2\ttab "quotes"' },
    }
    const result = encode(msg)
    // Should be valid JSON despite special chars
    const parsed = JSON.parse(result.trim())
    expect(parsed.action.text).toBe('line1\nline2\ttab "quotes"')
  })

  test('handles unicode and emoji', () => {
    const msg: BridgeToRelay = {
      type: 'action',
      bridgeId: 'b1',
      requestId: 'r1',
      action: { name: 'react', chatId: 'ch1', messageId: 'm1', emoji: '\u{1F44D}' },
    }
    const result = encode(msg)
    const parsed = JSON.parse(result.trim())
    expect(parsed.action.emoji).toBe('\u{1F44D}')
  })
})

// ── parseLines ─────────────────────────────────────────────────────────────

describe('parseLines', () => {
  test('parses a single complete message', () => {
    const input = '{"type":"registered","bridgeId":"abc"}\n'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(1)
    expect((messages[0] as RelayToBridge).type).toBe('registered')
    expect(remainder).toBe('')
  })

  test('parses multiple messages', () => {
    const input = '{"type":"registered","bridgeId":"a"}\n{"type":"registered","bridgeId":"b"}\n'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(2)
    expect((messages[0] as any).bridgeId).toBe('a')
    expect((messages[1] as any).bridgeId).toBe('b')
    expect(remainder).toBe('')
  })

  test('returns incomplete line as remainder', () => {
    const input = '{"type":"registered","bridgeId":"abc"}\n{"type":"regi'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(1)
    expect(remainder).toBe('{"type":"regi')
  })

  test('handles empty input', () => {
    const { messages, remainder } = parseLines('')
    expect(messages).toHaveLength(0)
    expect(remainder).toBe('')
  })

  test('handles input with only a newline', () => {
    const { messages, remainder } = parseLines('\n')
    expect(messages).toHaveLength(0)
    expect(remainder).toBe('')
  })

  test('skips empty lines between messages', () => {
    const input = '{"type":"registered","bridgeId":"a"}\n\n\n{"type":"registered","bridgeId":"b"}\n'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(2)
  })

  test('skips whitespace-only lines', () => {
    const input = '{"type":"registered","bridgeId":"a"}\n   \n{"type":"registered","bridgeId":"b"}\n'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(2)
  })

  test('skips malformed JSON lines', () => {
    const input = '{"type":"registered","bridgeId":"a"}\nnot-json\n{"type":"registered","bridgeId":"b"}\n'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(2)
    expect((messages[0] as any).bridgeId).toBe('a')
    expect((messages[1] as any).bridgeId).toBe('b')
  })

  test('skips truncated JSON lines (missing closing brace)', () => {
    const input = '{"type":"registered","bridgeId":"a"}\n{"type":"incomplete"\n{"type":"registered","bridgeId":"c"}\n'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(2)
  })

  test('handles no trailing newline (everything is remainder)', () => {
    const input = '{"type":"registered","bridgeId":"abc"}'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(0)
    expect(remainder).toBe('{"type":"registered","bridgeId":"abc"}')
  })

  test('handles multiple newlines at end', () => {
    const input = '{"type":"registered","bridgeId":"a"}\n\n\n'
    const { messages, remainder } = parseLines(input)
    expect(messages).toHaveLength(1)
    expect(remainder).toBe('')
  })
})

// ── encode + parseLines round-trip ─────────────────────────────────────────

describe('encode/parseLines round-trip', () => {
  test('round-trips a register message', () => {
    const original: BridgeToRelay = {
      type: 'register',
      bridgeId: 'bridge-123',
      label: 'test session',
      channels: ['ch1', 'ch2'],
      threads: ['th1'],
    }
    const encoded = encode(original)
    const { messages } = parseLines(encoded)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(original)
  })

  test('round-trips a message payload', () => {
    const original: RelayToBridge = {
      type: 'message',
      channelId: 'ch1',
      messageId: 'm1',
      authorId: 'u1',
      authorUsername: 'TestUser',
      content: 'Hello, world!\nSecond line.',
      ts: '2025-01-01T00:00:00.000Z',
      attachmentCount: 1,
      attachments: [{ name: 'file.png', contentType: 'image/png', size: 1234 }],
    }
    const encoded = encode(original)
    const { messages } = parseLines(encoded)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual(original)
  })

  test('round-trips an action_result', () => {
    const original: RelayToBridge = {
      type: 'action_result',
      requestId: 'req-1',
      success: true,
      data: { nested: { value: [1, 2, 3] } },
    }
    const encoded = encode(original)
    const { messages } = parseLines(encoded)
    expect(messages[0]).toEqual(original)
  })

  test('round-trips an error', () => {
    const original: RelayToBridge = {
      type: 'error',
      message: 'something went wrong',
    }
    const encoded = encode(original)
    const { messages } = parseLines(encoded)
    expect(messages[0]).toEqual(original)
  })

  test('round-trips multiple messages concatenated', () => {
    const msgs: (BridgeToRelay | RelayToBridge)[] = [
      { type: 'register', bridgeId: 'b1', channels: ['*'], threads: [] },
      { type: 'registered', bridgeId: 'b1' },
      { type: 'action', bridgeId: 'b1', requestId: 'r1', action: { name: 'relay_status' } },
    ]
    const encoded = msgs.map(encode).join('')
    const { messages, remainder } = parseLines(encoded)
    expect(messages).toHaveLength(3)
    expect(remainder).toBe('')
    for (let i = 0; i < msgs.length; i++) {
      expect(messages[i]).toEqual(msgs[i])
    }
  })

  test('simulates streaming: partial buffer accumulation', () => {
    const msg: BridgeToRelay = { type: 'register', bridgeId: 'b1', channels: ['c1'], threads: [] }
    const full = encode(msg)
    // Split the message in half to simulate partial reads
    const mid = Math.floor(full.length / 2)
    const part1 = full.slice(0, mid)
    const part2 = full.slice(mid)

    // First chunk: no complete messages
    const r1 = parseLines(part1)
    expect(r1.messages).toHaveLength(0)
    expect(r1.remainder).toBe(part1)

    // Second chunk appended: one complete message
    const r2 = parseLines(r1.remainder + part2)
    expect(r2.messages).toHaveLength(1)
    expect(r2.messages[0]).toEqual(msg)
    expect(r2.remainder).toBe('')
  })
})
