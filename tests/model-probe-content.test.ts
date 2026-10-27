/**
 * The connection test must send content the host can read.
 *
 * The bug this replaces was silent in the worst way: `probeModelConnectivity`
 * passed `content: PROBE_PROMPT` — a bare string. The host validates history
 * with `message.content.some(...)` (`dsh-llm-pi-ai/lib/index.js:1213` for
 * assertSupportedHistory, `dsh-llm/lib/types/content.js:93` for contentHasImage),
 * so every click on 连接测试 came back `{"ok":false,"error":"content.some is not a
 * function"}` and no request was ever made.
 *
 * The fake below validates the way the host does, on purpose: a test that
 * accepts `unknown` content would have passed against the broken code.
 */
import { describe, expect, it } from 'vitest'
import { probeModelConnectivity } from '../src/model-probe.ts'
import type { ModelProbeStream, ProbeMessage } from '../src/model-probe.ts'

/** A content block, as a caller might hand one over unchecked. */
interface LooseBlock {
  type?: unknown
  text?: unknown
}

/** Stand-in for a host validator that walks `content.some(...)`. */
function assertSupportedHistory(messages: readonly { role: string; content: unknown }[]): void {
  for (const message of messages) {
    // This line IS the bug: a string has no `.some`, and the host throws here.
    const blocks = message.content as LooseBlock[]
    if (!blocks.some(block => block !== null && typeof block === 'object')) {
      throw new Error('history has no usable content block')
    }
  }
}

/** An `llm` that validates like the host, then answers with `answer`. */
function fakeLlm(answer: string, seen: ProbeMessage[][]): ModelProbeStream {
  return {
    stream(options) {
      assertSupportedHistory(options.messages)
      seen.push(options.messages)
      return (async function* () {
        yield { type: 'text', text: answer }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

describe('the probe sends blocks the host can validate', () => {
  it('reports a working connection instead of crashing on its own history', async () => {
    const seen: ProbeMessage[][] = []
    const result = await probeModelConnectivity(fakeLlm('ready', seen), 'xdpool-global', 'deepseek-v4.1-flash')
    expect(result.ok).toBe(true)
    expect(result.outputChars).toBeGreaterThan(0)
    expect(result.error).toBeUndefined()
    // The shape that was wrong: one user message whose content is one text block.
    expect(seen).toHaveLength(1)
    const blocks = seen[0]?.[0]?.content
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks?.[0]?.type).toBe('text')
    expect(typeof blocks?.[0]?.text).toBe('string')
    expect(blocks?.[0]?.text.length).toBeGreaterThan(0)
  })

  it('turns a host-side rejection into a visible failure, never a throw', async () => {
    const hostRejects: ModelProbeStream = {
      stream() {
        throw new Error('content.some is not a function')
      },
    }
    const result = await probeModelConnectivity(hostRejects, 'xdpool', 'deepseek-v4.1-flash')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('content.some')
  })

  it('reports an empty answer as a failure worth showing', async () => {
    const result = await probeModelConnectivity(fakeLlm('', []), 'xdpool', 'deepseek-v4.1-flash')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})
