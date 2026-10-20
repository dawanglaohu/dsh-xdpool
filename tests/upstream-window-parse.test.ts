/**
 * Context-window resolution and the two recoverable 400 classes.
 *
 * The live WorkBuddy catalog (`GET /v2/enterprises/personal/models`) almost
 * never sends a scalar `contextWindow`: most entries declare only
 * `maxInputTokens` / `maxAllowedSize`, and the one entry that does send
 * `contextWindow` sends it as an OBJECT
 * (`{"defaultLength":300000,"supportedLengths":[300000,1000000]}`).
 *
 * `defaultLength` is only the default ASK of the upstream's own client. A live
 * probe on `deepseek-v4.1-flash-sg` was answered 200 at 1,000,019 prompt
 * tokens and refused with business code 11115 only at 1,150,035 — so the real
 * ceiling is the largest declared length, and that is what has to be
 * advertised.
 *
 * The same catalog answers two HTTP 400s that are repairable rather than
 * terminal — an oversized prompt (code 11115) and a broken tool
 * call/result pairing (code 11148) — so neither may fall through to
 * `client`, which ends the request in the shim loop.
 */

import { describe, expect, it } from 'vitest'
import { classifyUpstreamError, parseUpstreamModel } from '../src/upstream.ts'

/** A catalog entry that is otherwise valid, with the limits under test. */
function entry(extra: Record<string, unknown>): Record<string, unknown> {
  return { id: 'model-x', name: 'Model X', maxOutputTokens: 64_000, ...extra }
}

/** The live `deepseek-v4.1-flash-sg` entry, verbatim from the probe. */
const SG_ENTRY = entry({
  contextWindow: { defaultLength: 300_000, supportedLengths: [300_000, 1_000_000] },
  maxAllowedSize: 1_000_000,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 128_000,
})

describe('parseUpstreamModel — effective context window', () => {
  it('advertises the largest accepted length, not the default ask', () => {
    // defaultLength is 300000, but the server accepted 1,000,019 tokens and
    // refused 11115 only at 1,150,035 — advertising 300000 would cap a working
    // 1M window at 300K.
    const model = parseUpstreamModel(SG_ENTRY)
    expect(model?.contextWindow).toBe(1_000_000)
    expect(model?.defaultContextWindow).toBe(300_000)
    expect(model?.supportedContextWindows).toEqual([300_000, 1_000_000])
  })

  it('prefers a numeric contextWindow over every other field', () => {
    const model = parseUpstreamModel(entry({
      contextWindow: 400_000,
      maxAllowedSize: 300_000,
      maxInputTokens: 200_000,
    }))
    expect(model?.contextWindow).toBe(400_000)
    expect(model?.defaultContextWindow).toBeUndefined()
  })

  it('lets the largest supportedLengths entry beat maxAllowedSize', () => {
    const model = parseUpstreamModel(entry({
      contextWindow: { defaultLength: 200_000, supportedLengths: [200_000, 2_000_000] },
      maxAllowedSize: 1_000_000,
    }))
    expect(model?.contextWindow).toBe(2_000_000)
    expect(model?.defaultContextWindow).toBe(200_000)
  })

  it('falls back to defaultLength when no larger length is declared', () => {
    const model = parseUpstreamModel(entry({
      contextWindow: { defaultLength: 200_000 },
      maxInputTokens: 150_000,
    }))
    expect(model?.contextWindow).toBe(200_000)
    // Equal to the resolved window, so the extra field would add nothing.
    expect(model?.defaultContextWindow).toBeUndefined()
  })

  it('prefers maxAllowedSize over defaultLength', () => {
    const model = parseUpstreamModel(entry({
      contextWindow: { defaultLength: 200_000 },
      maxAllowedSize: 300_000,
      maxInputTokens: 150_000,
    }))
    expect(model?.contextWindow).toBe(300_000)
    expect(model?.defaultContextWindow).toBe(200_000)
  })

  it('uses maxAllowedSize when nothing else declares a window', () => {
    const model = parseUpstreamModel(entry({ maxAllowedSize: 300_000, maxInputTokens: 200_000 }))
    expect(model?.contextWindow).toBe(300_000)
  })

  it('still uses maxInputTokens when nothing else declares a window', () => {
    // This is the shape tests/catalog-resilience.test.ts builds its fixtures
    // from; the fallback chain has to keep it working.
    const model = parseUpstreamModel(entry({ maxInputTokens: 200_000 }))
    expect(model?.contextWindow).toBe(200_000)
    expect(model?.supportedContextWindows).toBeUndefined()
    expect(model?.defaultContextWindow).toBeUndefined()
  })

  it('ignores non-positive and non-integer declarations', () => {
    const model = parseUpstreamModel(entry({
      contextWindow: 0,
      maxAllowedSize: -5,
      maxInputTokens: 200_000,
    }))
    expect(model?.contextWindow).toBe(200_000)
  })

  it('drops the entry when no source declares a usable window', () => {
    expect(parseUpstreamModel(entry({}))).toBeUndefined()
    expect(parseUpstreamModel(entry({ contextWindow: {}, maxAllowedSize: 0 }))).toBeUndefined()
    expect(parseUpstreamModel(entry({ maxInputTokens: 0 }))).toBeUndefined()
  })

  it('drops the entry when maxOutputTokens is unusable', () => {
    expect(parseUpstreamModel({ id: 'model-x', maxInputTokens: 200_000, maxOutputTokens: 0 })).toBeUndefined()
  })
})

describe('parseUpstreamModel — supportedContextWindows', () => {
  it('carries supportedLengths filtered, de-duplicated and ascending', () => {
    const model = parseUpstreamModel(entry({
      contextWindow: { defaultLength: 200_000, supportedLengths: [1_000_000, 200_000, 200_000, -1, 0] },
    }))
    expect(model?.supportedContextWindows).toEqual([200_000, 1_000_000])
  })

  it('omits the field entirely when the entry declares no list', () => {
    const model = parseUpstreamModel(entry({ contextWindow: 200_000 }))
    expect(model).toBeDefined()
    expect(model === undefined || 'supportedContextWindows' in model).toBe(false)
  })

  it('omits the field when every declared length is unusable', () => {
    const model = parseUpstreamModel(entry({
      contextWindow: { defaultLength: 200_000, supportedLengths: [0, -1] },
    }))
    expect(model === undefined || 'supportedContextWindows' in model).toBe(false)
  })
})

describe('classifyUpstreamError — recoverable 400 classes', () => {
  it('routes context overflow to context_overflow', () => {
    for (const body of [
      '{"code":11115,"msg":"prompt too long"}',
      '{"code": 11115}',
      '"prompt is too long"',
      'maximum context length is 200000 tokens',
      '{"error":"context_length_exceeded"}',
      'input length too long',
    ]) {
      expect(classifyUpstreamError(400, body), `body: ${body}`).toBe('context_overflow')
    }
  })

  it('routes tool pairing breakage to tool_pairing', () => {
    for (const body of [
      '{"code":11148}',
      '{"code": 11148}',
      'tool calls and tool results do not match',
      'Incomplete tool records',
    ]) {
      expect(classifyUpstreamError(400, body), `body: ${body}`).toBe('tool_pairing')
    }
  })

  it('leaves the status-based rules untouched', () => {
    expect(classifyUpstreamError(401, '')).toBe('session_dead')
    expect(classifyUpstreamError(403, '')).toBe('session_dead')
    expect(classifyUpstreamError(402, '')).toBe('hard_credit')
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(404, 'no such route')).toBe('not_found')
    expect(classifyUpstreamError(500, 'boom')).toBe('server')
  })

  it('keeps an unremarkable 400 terminal', () => {
    expect(classifyUpstreamError(400, 'bad request')).toBe('client')
  })
})
