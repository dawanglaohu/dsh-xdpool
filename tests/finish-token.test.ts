/**
 * The finish-token rule, pinned where it is written.
 *
 * The rule exists because pi-ai throws on any token it cannot decode: an upstream
 * that ends a stream with `finish_reason: "error"` makes the host report
 * `本轮运行失败 Provider finish_reason: error` and throws away whatever had already
 * been generated. These tests are about the translation itself — the lanes' own
 * behaviour (keep the answer / refuse the attempt) is pinned beside the lanes.
 */
import { describe, expect, it } from 'vitest'
import {
  HOST_FINISH_TOKENS,
  finishTokenInFrame,
  hostFinishFrame,
  hostFinishToken,
  isHostFinishToken,
} from '../src/finish-token.ts'

describe('the tokens the host decodes', () => {
  it('lists exactly the terminal reasons pi-ai maps to a stop reason', () => {
    // Read off pi-ai's `mapStopReason`: these five (plus `null`) are decoded, and
    // every other spelling becomes `stopReason: "error"` and is thrown.
    expect([...HOST_FINISH_TOKENS]).toEqual(['stop', 'end', 'length', 'function_call', 'tool_calls'])
    for (const token of HOST_FINISH_TOKENS) expect(isHostFinishToken(token)).toBe(true)
  })

  it('does not accept the tokens a gateway invents to report its own failure', () => {
    // `error` is the one this plugin keeps meeting in the wild; the rest are the
    // same class of bug — a gateway reporting a non-answer as a terminal reason.
    for (const token of ['error', 'content_filter', 'network_error', 'aborted', 'stop_sequence', '']) {
      expect(isHostFinishToken(token)).toBe(false)
    }
  })
})

describe('what goes on the wire', () => {
  it('keeps a token the host understands', () => {
    // `length` is the one that carries meaning: the caller must learn the answer
    // was cut off by the output limit, so it is never rewritten.
    expect(hostFinishToken('length')).toBe('length')
    expect(hostFinishToken('tool_calls')).toBe('tool_calls')
    expect(hostFinishToken('end')).toBe('end')
  })

  it('answers with `stop` when there is nothing usable to pass through', () => {
    expect(hostFinishToken('error')).toBe('stop')
    expect(hostFinishToken('')).toBe('stop')
    expect(hostFinishToken(undefined)).toBe('stop')
  })
})

describe('reading and rewriting one frame', () => {
  it('reads the token from a bare payload and from a `data:` frame alike', () => {
    // The two shapes the lanes see: the free and aggregate lanes hand payloads
    // around, while the pool lane forwards whole frames.
    expect(finishTokenInFrame('{"choices":[{"delta":{},"finish_reason":"error"}]}')).toBe('error')
    expect(finishTokenInFrame('data: {"choices":[{"delta":{},"finish_reason":"error"}]}')).toBe('error')
    expect(finishTokenInFrame('data:{"choices":[{"delta":{},"finish_reason":"length"}]}')).toBe('length')
  })

  it('treats `null`, a missing token and no finish field at all as "no token yet"', () => {
    expect(finishTokenInFrame('{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}')).toBeUndefined()
    expect(finishTokenInFrame('{"choices":[{"delta":{"content":"hi"}}]}')).toBeUndefined()
    // The cheap gate: a frame that never mentions the field is not parsed at all,
    // which is what keeps this off the hot path of a long answer.
    expect(finishTokenInFrame('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBeUndefined()
    expect(finishTokenInFrame('   ')).toBeUndefined()
  })

  it('reads the first non-empty token when a frame carries several choices', () => {
    expect(finishTokenInFrame(
      '{"choices":[{"delta":{},"finish_reason":null},{"delta":{},"finish_reason":"error"}]}',
    )).toBe('error')
  })

  it('still classifies a frame the gateway wrote as something other than JSON', () => {
    // A frame with a trailing comma or a split payload is not worth failing the
    // turn over, and passing it through as complete is exactly the bug.
    expect(finishTokenInFrame('data: {"choices":[{"delta":{},"finish_reason":"error",}]}')).toBe('error')
  })

  it('rewrites an invented token to `stop` and leaves the rest of the frame alone', () => {
    const frame = 'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"error"}]}'
    expect(hostFinishFrame(frame)).toBe(
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}',
    )
  })

  it('returns an acceptable frame unchanged, without re-encoding it', () => {
    // Same string, not an equal one: the pool lane promises to forward what the
    // upstream wrote, and a re-serialised frame would break that promise in ways
    // only a byte comparison would notice.
    const frame = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
    expect(hostFinishFrame(frame)).toBe(frame)
    expect(hostFinishFrame('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBe('data: {"choices":[{"delta":{"content":"hi"}}]}')
  })

  it('does not touch an answer that merely talks about finish tokens', () => {
    // A model explaining this very bug writes `"finish_reason": "error"` inside
    // its content. Escaped quotes are what make it safe: the rewrite pattern
    // needs an unescaped quote, so it cannot reach into a string.
    const frame = 'data: {"choices":[{"delta":{"content":"{\\"finish_reason\\": \\"error\\"}"},"finish_reason":"stop"}]}'
    expect(hostFinishFrame(frame)).toBe(frame)
  })

  it('rewrites every occurrence in a multi-choice frame', () => {
    const frame = '{"choices":[{"delta":{},"finish_reason":"error"},{"delta":{},"finish_reason":"error"}]}'
    expect(hostFinishFrame(frame)).toBe(
      '{"choices":[{"delta":{},"finish_reason":"stop"},{"delta":{},"finish_reason":"stop"}]}',
    )
  })
})
