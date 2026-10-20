/**
 * Tool-call / tool-result pairing after a head drop.
 *
 * Dropping the oldest turns can slice a tool exchange in half: the `tool` result
 * survives while the assistant message that declared its `tool_call_id` is gone,
 * or an assistant `tool_calls` outlives the result it was waiting for. The
 * upstream rejects such a prompt outright:
 *
 *   {"code":11148,"msg":"tool calls and tool results do not match, ..."}
 *
 * Probes against the live upstream confirmed every shape fails — an orphan
 * result at the head, an orphan result mid-array, a result with no
 * `tool_call_id`, and an unanswered assistant `tool_calls` — while a properly
 * paired exchange answers 200. `repairToolPairing` is the guard the three
 * head-dropping paths run their survivors through; this suite pins the function
 * itself and each call site.
 */

import { describe, expect, it } from 'vitest'
import {
  compactMessages,
  compactWithSummary,
  estimateMessagesTokens,
  hardTruncate,
  repairToolPairing,
  type ChatMessage,
} from '../src/context-budget.ts'

/** An assistant turn declaring `ids` as its tool calls. */
function callTurn(ids: readonly string[], text = ''): ChatMessage {
  return {
    role: 'assistant',
    content: text,
    tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } })),
  }
}

/** A tool result answering `id`. */
function toolResult(id: string, text = 'ok'): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: text }
}

/**
 * The invariant the upstream enforces, derived independently of the repair
 * function so that a broken repair cannot satisfy its own test.
 */
function pairingProblems(messages: readonly ChatMessage[]): string[] {
  const problems: string[] = []
  const declared = new Set<string>()
  const answered = new Set<string>()
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      const id = message['tool_call_id']
      if (typeof id !== 'string') {
        problems.push(`#${index} tool result carries no tool_call_id`)
      } else if (!declared.has(id)) {
        problems.push(`#${index} tool result ${id} has no earlier assistant call`)
      } else {
        answered.add(id)
      }
      continue
    }
    const entries = message['tool_calls']
    if (!Array.isArray(entries)) continue
    for (const entry of entries as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = (entry as Record<string, unknown>)['id']
      if (typeof id === 'string' && id !== '') declared.add(id)
    }
  }
  for (const id of declared) {
    if (!answered.has(id)) problems.push(`call ${id} was never answered`)
  }
  return problems
}

/** A conversation whose newest turn is a tool result. */
function toolTailConversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'x'.repeat(8_000) },
    callTurn(['call-1'], 'y'.repeat(8_000)),
    toolResult('call-1', 'z'.repeat(8_000)),
  ]
}

/** The same shape, with a stale tool result already stranded at the head. */
function orphanHeadConversation(): ChatMessage[] {
  return [toolResult('call-0', 'stale'), ...toolTailConversation()]
}

describe('repairToolPairing', () => {
  it('drops an orphan tool result at the head of the array', () => {
    const messages: ChatMessage[] = [
      toolResult('call-1'),
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const repaired = repairToolPairing(messages)
    expect(repaired.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(pairingProblems(repaired)).toEqual([])
    // The input array is untouched.
    expect(messages).toHaveLength(3)
  })

  it('drops an orphan tool result in the middle of the array', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read a' },
      callTurn(['call-1']),
      toolResult('call-1'),
      toolResult('call-9'), // the assistant turn that declared call-9 is gone
      { role: 'assistant', content: 'done' },
    ]
    const repaired = repairToolPairing(messages)
    expect(repaired.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(repaired.some(m => m['tool_call_id'] === 'call-9')).toBe(false)
    expect(pairingProblems(repaired)).toEqual([])
  })

  it('drops a tool result that carries no tool_call_id', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      callTurn(['call-1'], 'let me look'),
      toolResult('call-1'),
      { role: 'tool', content: 'stray' },
    ]
    const repaired = repairToolPairing(messages)
    expect(repaired).toHaveLength(3)
    expect(pairingProblems(repaired)).toEqual([])
  })

  it('drops an assistant tool_calls that no later tool result answers', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      callTurn(['call-1'], 'looking'),
      { role: 'user', content: 'never mind' },
    ]
    const repaired = repairToolPairing(messages)
    // The turn existed only to call tools; its text cannot stand in for the call.
    expect(repaired.map(m => m.role)).toEqual(['user', 'user'])
    expect(pairingProblems(repaired)).toEqual([])
  })

  it('narrows partially answered tool_calls to the satisfied ids', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      callTurn(['call-1', 'call-2'], 'two reads'),
      toolResult('call-1'),
      { role: 'assistant', content: 'partial' },
    ]
    const repaired = repairToolPairing(messages)
    expect(repaired).toHaveLength(4)
    const kept = repaired[1]
    expect(kept?.role).toBe('assistant')
    const entries = kept?.['tool_calls'] as { id?: unknown }[]
    expect(entries.map(entry => entry.id)).toEqual(['call-1'])
    // Narrowing is the only place a message is rebuilt; the rest keep identity.
    expect(repaired[0]).toBe(messages[0])
    expect(repaired[2]).toBe(messages[2])
    expect(pairingProblems(repaired)).toEqual([])
  })

  it('returns a fully paired conversation unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'go' },
      callTurn(['call-1', 'call-2']),
      toolResult('call-1'),
      toolResult('call-2'),
      { role: 'assistant', content: 'done' },
    ]
    const repaired = repairToolPairing(messages)
    expect(repaired).toBe(messages)
    expect(pairingProblems(repaired)).toEqual([])
  })

  it('tolerates a single tool_calls object in place of an array', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: { id: 'call-1' } },
      toolResult('call-1'),
    ]
    expect(repairToolPairing(messages)).toBe(messages)
  })

  it('drops a turn whose tool_calls carry no usable id', () => {
    // An id-less call can never be matched by a tool result, so leaving it on
    // the wire is exactly the mismatch the upstream reports.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'hi', tool_calls: [{ function: { name: 'read' } }, { id: 42 }] },
      { role: 'assistant', content: 'still here' },
    ]
    expect(repairToolPairing(messages).map(m => m.content)).toEqual(['go', 'still here'])
  })

  it('never drops a pinned instruction', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'developer', content: 'dev' },
      toolResult('call-1'),
    ]
    expect(repairToolPairing(messages).map(m => m.role)).toEqual(['system', 'developer'])
  })
})

describe('compactMessages repairs the kept messages', () => {
  it('drops the kept tool result once the cut orphans it', () => {
    const messages = toolTailConversation()
    const compacted = compactMessages(messages, { budget: 2_100, keepRecent: 1 })

    expect(compacted.changed).toBe(true)
    // The cut lands on the assistant turn that declared call-1, so the newest
    // message — the tool result — is exactly the orphan the upstream rejects.
    expect(compacted.dropped).toHaveLength(2)
    expect(compacted.messages.map(m => m.role)).toEqual(['system'])
    expect(pairingProblems(compacted.messages)).toEqual([])
    // `dropped` is still the contiguous prefix that was removed.
    expect(compacted.dropped).toEqual(messages.slice(1, 1 + compacted.dropped.length))
    // The reported token count follows the repaired array.
    expect(compacted.tokens).toBe(estimateMessagesTokens(compacted.messages))
  })

  it('keeps a tail exchange whose call and result both survive', () => {
    const messages = toolTailConversation()
    const compacted = compactMessages(messages, { budget: 4_100, keepRecent: 1 })

    expect(compacted.changed).toBe(true)
    expect(compacted.dropped).toHaveLength(1)
    expect(compacted.messages.map(m => m.role)).toEqual(['system', 'assistant', 'tool'])
    expect(pairingProblems(compacted.messages)).toEqual([])
    expect(compacted.tokens).toBe(estimateMessagesTokens(compacted.messages))
  })

  it('repairs a conversation that already starts with an orphan', () => {
    const messages = orphanHeadConversation()
    const compacted = compactMessages(messages, { budget: 4_100, keepRecent: 1 })

    expect(compacted.messages.some(m => m['tool_call_id'] === 'call-0')).toBe(false)
    expect(pairingProblems(compacted.messages)).toEqual([])
    expect(compacted.tokens).toBe(estimateMessagesTokens(compacted.messages))
  })

  it('repairs even when nothing needed dropping', () => {
    const messages: ChatMessage[] = [
      toolResult('call-1'),
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const compacted = compactMessages(messages, { budget: 1_000_000 })
    expect(compacted.changed).toBe(false)
    expect(compacted.dropped).toEqual([])
    expect(pairingProblems(compacted.messages)).toEqual([])
    expect(compacted.messages.map(m => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('hardTruncate repairs the head it leaves behind', () => {
  it('drops the orphan tool result at the head and keeps the newest turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(40_000) },
      callTurn(['call-1'], 'y'.repeat(40_000)),
      toolResult('call-1', 'z'.repeat(8_000)),
      { role: 'user', content: 'latest' },
    ]
    const truncated = hardTruncate(messages, 2_500)

    expect(truncated.changed).toBe(true)
    // The truncation lands on the tool result, which is then orphaned by the cut.
    expect(truncated.dropped.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(truncated.messages.map(m => m.role)).toEqual(['user'])
    expect(pairingProblems(truncated.messages)).toEqual([])
    // The newest message still survives, which is the contract of this path.
    expect(truncated.messages.at(-1)).toEqual(messages.at(-1))
    expect(truncated.tokens).toBe(estimateMessagesTokens(truncated.messages))
  })

  it('leaves a plain conversation untouched', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ]
    const truncated = hardTruncate(messages, 1_000_000)
    expect(truncated.changed).toBe(false)
    expect(truncated.messages).toEqual(messages)
  })
})

describe('compactWithSummary returns a pairable prompt', () => {
  it('keeps the surviving tool pair around the injected summary', async () => {
    const messages = toolTailConversation()
    const result = await compactWithSummary(
      messages,
      { budget: 4_100, keepRecent: 1 },
      { complete: async () => 'SUMMARY: one file was read.' },
    )

    expect(result.summary).toBeDefined()
    expect(result.messages.map(m => m.role)).toEqual(['system', 'system', 'assistant', 'tool'])
    expect(result.messages.some(m => String(m.content).includes('SUMMARY: one file was read.'))).toBe(true)
    expect(pairingProblems(result.messages)).toEqual([])
    expect(result.tokens).toBe(estimateMessagesTokens(result.messages))
  })

  it('repairs the summary path when the tool result outlives its call', async () => {
    const messages = toolTailConversation()
    const result = await compactWithSummary(
      messages,
      { budget: 2_100, keepRecent: 1 },
      { complete: async () => 'SUMMARY: only the newest turn survived.' },
    )

    expect(result.summary).toBeDefined()
    expect(pairingProblems(result.messages)).toEqual([])
    expect(result.messages.some(m => m.role === 'tool')).toBe(false)
    expect(result.tokens).toBe(estimateMessagesTokens(result.messages))
  })

  it('repairs the plain-truncation fallback when the summariser throws', async () => {
    const messages = toolTailConversation()
    const result = await compactWithSummary(
      messages,
      { budget: 2_100, keepRecent: 1 },
      { complete: async () => { throw new Error('upstream 429') } },
    )

    expect(result.summary).toBeUndefined()
    expect(pairingProblems(result.messages)).toEqual([])
    expect(result.messages.some(m => m.role === 'tool')).toBe(false)
    expect(result.tokens).toBe(estimateMessagesTokens(result.messages))
  })
})
