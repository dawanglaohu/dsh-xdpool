/**
 * In-place context recovery: business codes 11115 and 11148.
 *
 * Why this file exists
 * --------------------
 * Both codes used to fall through `classifyUpstreamError`'s default to `client`,
 * which is TERMINAL, so the shim gave up on a turn it could have salvaged and the
 * user saw "the conversation could not be compacted in place (upstream client
 * after compaction)". The upstream bodies are, verbatim:
 *
 *   {"code":11115,"msg":"prompt is too long: 1150035 tokens > 1048576 maximum"}
 *   {"code":11148,"msg":"tool calls and tool results do not match, ..."}
 *
 * The first needs the prompt made SMALLER, the second needs it made WELL-FORMED.
 * Treating them as one failure is the trap this file guards against: halving the
 * budget for a 11148 throws away half a conversation that already fitted, and
 * summarising it spends an account on the one thing the upstream did not object
 * to. The tests below pin each repair to its own failure.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, effectiveWindowOf, isContextTooLong } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** The live overflow body, exactly as the gateway sends it. */
const OVERFLOW_BODY = JSON.stringify({
  code: 11115,
  msg: 'prompt is too long: 1150035 tokens > 1048576 maximum',
  requestId: 'a7a1fcbd-6d3c-4d0b-9a5e-2f1c8b6d4e10',
})

/** The live broken-pairing body, exactly as the gateway sends it. */
const PAIRING_BODY = JSON.stringify({
  code: 11148,
  msg: 'tool calls and tool results do not match, please start a new conversation and retry',
  requestId: 'c1d2e3f4-0000-4000-8000-111122223333',
})

function served(): Response {
  return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function refused(body: string): Response {
  return new Response(body, { status: 400, headers: { 'Content-Type': 'application/json' } })
}

/** A pool holding `count` CN accounts. */
function poolWith(count: number): WorkBuddyAccountPool {
  const dir = mkdtempSync(join(tmpdir(), 'wbpool-recovery-'))
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `workbuddy-desktop.c${i}.info`), JSON.stringify({
      auth: {
        accessToken: `token-${i}`,
        refreshToken: 'r',
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.workbuddy.cn',
      },
      account: { uid: `uid-${i}`, uin: `uin-${i}`, nickname: `acct${i}` },
    }))
  }
  return new WorkBuddyAccountPool({ authDirs: [dir], logger: { warn() {} } })
}

interface ShimHarness {
  baseUrl: string
  token: string
  close: () => Promise<void>
}

/**
 * Run one request through a real shim and record every chat body it sends.
 *
 * `reply` decides what the upstream answers for the Nth chat call; the bodies are
 * kept so a test can assert what the shim actually put on the wire.
 */
async function withShim(
  reply: (call: number, body: Record<string, unknown>) => Response,
  send: (harness: ShimHarness) => Promise<Response>,
): Promise<{ response: Response; bodies: Record<string, unknown>[] }> {
  const pool = poolWith(2)
  await pool.scan()
  const bodies: Record<string, unknown>[] = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: (async (url: unknown, init: RequestInit) => {
      // Only chat calls count: a served turn also fires a background balance
      // refresh, which is not a retry.
      if (!String(url).endsWith('/v2/chat/completions')) return served()
      const raw = typeof init.body === 'string' ? init.body : ''
      let parsed: Record<string, unknown> = {}
      try {
        const value: unknown = JSON.parse(raw)
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          parsed = value as Record<string, unknown>
        }
      } catch {
        parsed = {}
      }
      bodies.push(parsed)
      return reply(bodies.length, parsed)
    }) as unknown as typeof fetch,
  })
  const shim = createWorkBuddyShim({
    pool,
    client,
    catalog: new WorkBuddyCatalog(),
    region: 'cn',
    saturationRetryDelaysMs: [1],
  })
  await shim.ready
  try {
    const response = await send({ baseUrl: shim.baseUrl(), token: shim.token(), close: shim.close })
    return { response, bodies }
  } finally {
    await shim.close()
  }
}

function post(harness: ShimHarness, messages: unknown[], model = 'deepseek-v4.1-flash'): Promise<Response> {
  return fetch(`${harness.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${harness.token}` },
    body: JSON.stringify({ model, messages, stream: true }),
  })
}

/** Does this outbound message array still carry a tool result nothing declared? */
function hasOrphanToolResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  const declared = new Set<string>()
  for (const value of messages) {
    if (typeof value !== 'object' || value === null) continue
    const message = value as Record<string, unknown>
    if (message['role'] === 'tool') {
      const id = message['tool_call_id']
      if (typeof id !== 'string' || !declared.has(id)) return true
      continue
    }
    const calls = message['tool_calls']
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (typeof call !== 'object' || call === null) continue
      const id = (call as Record<string, unknown>)['id']
      if (typeof id === 'string') declared.add(id)
    }
  }
  return false
}

/* ------------------------------------------------------------------ *
 * The window the Harness was told about, not the raw catalog value
 * ------------------------------------------------------------------ */

describe('effectiveWindowOf follows the window the Harness advertises', () => {
  it('prefers the budget-capped visible window over the raw catalog', () => {
    const catalog = new WorkBuddyCatalog()
    // The user capped this model at 64K in the pool card. `visible()` applies it;
    // `current()` does not — and reading `current()` here is what let the shim
    // compact to a target derived from the upstream's 1M while the Harness had
    // been told 64K.
    catalog.applySelection({ contextBudgets: { 'deepseek-v4.1-flash': 64_000 } })

    expect(catalog.current().find(m => m.id === 'deepseek-v4.1-flash')?.contextWindow).toBe(1_000_000)
    expect(catalog.visible().find(m => m.id === 'deepseek-v4.1-flash')?.contextWindow).toBe(64_000)
    expect(effectiveWindowOf(catalog, 'deepseek-v4.1-flash')).toBe(64_000)
  })

  it('falls back to the raw catalog for a model the selection hides', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.applySelection({ enabledModelIds: ['hy3'] })

    expect(catalog.visible().some(m => m.id === 'deepseek-v4.1-flash')).toBe(false)
    // A request already in flight must still recover, so the unfiltered row is
    // the closest honest answer left.
    expect(effectiveWindowOf(catalog, 'deepseek-v4.1-flash')).toBe(1_000_000)
  })

  it('reports nothing for an unknown or absent model', () => {
    const catalog = new WorkBuddyCatalog()
    expect(effectiveWindowOf(catalog, 'no-such-model')).toBeUndefined()
    expect(effectiveWindowOf(catalog, undefined)).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * The overflow predicate must recognise the body the gateway sends
 * ------------------------------------------------------------------ */

describe('isContextTooLong reads the real overflow wording', () => {
  it('matches the live 11115 body', () => {
    expect(isContextTooLong(OVERFLOW_BODY)).toBe(true)
    expect(isContextTooLong('prompt is too long: 1150035 tokens > 1048576 maximum')).toBe(true)
  })

  it('matches the code however the gateway spaces or quotes it', () => {
    for (const body of ['{"code":11115}', '{"code": 11115}', '{"code":"11115"}', '"code" : "11115"']) {
      expect(isContextTooLong(body), `should match: ${body}`).toBe(true)
    }
  })

  it('matches every wording seen in the field', () => {
    for (const body of [
      'context_length_exceeded',
      'input length too long',
      'maximum context length',
      'prompt is too large',
      'the prompt is too large for model deepseek-v4.1-flash-sg',
      'too large for model',
      'context window exceeded',
      'context length exceeded',
      'Your input exceeds the model context window',
    ]) {
      expect(isContextTooLong(body), `should match: ${body}`).toBe(true)
    }
  })

  it('leaves an ordinary rejection and a broken pairing alone', () => {
    // A miss here is the bug this whole file is about, so is a FALSE hit: filing
    // 11148 as an overflow would compact a prompt that already fitted.
    for (const body of ['', 'bad request', 'model_param_invalid', '{"code":11128}', PAIRING_BODY]) {
      expect(isContextTooLong(body), `should miss: ${body}`).toBe(false)
    }
  })

  it('does not read a longer number as the code', () => {
    expect(isContextTooLong('{"code":111150}')).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * 11148 is repaired, not compacted
 * ------------------------------------------------------------------ */

describe('a broken tool pairing is repaired without compacting', () => {
  it('drops the orphaned half and retries, without spending a summariser call', async () => {
    const { response, bodies } = await withShim(
      call => (call === 1 ? refused(PAIRING_BODY) : served()),
      harness => post(harness, [
        { role: 'user', content: 'hi' },
        // A head drop left this result without the assistant turn that declared
        // its tool_call_id — exactly what the upstream answers 11148 for.
        { role: 'tool', tool_call_id: 'call-orphan', content: 'stale result' },
      ]),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')

    // Two calls: the refused one and one repair retry.
    expect(bodies).toHaveLength(2)
    expect(hasOrphanToolResult(bodies[0]?.['messages'])).toBe(true)
    expect(hasOrphanToolResult(bodies[1]?.['messages'])).toBe(false)
    // The summariser is the only caller that sets `max_tokens`; the repair must
    // not need it, because the prompt was never oversized.
    expect(bodies.some(body => 'max_tokens' in body)).toBe(false)
  }, 60_000)

  it('gives up on a second 11148 instead of retrying forever', async () => {
    const { response, bodies } = await withShim(
      () => refused(PAIRING_BODY),
      harness => post(harness, [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'call-orphan', content: 'stale result' },
      ]),
    )

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.message).toContain('upstream tool_pairing after compaction')
    // The repair is attempted once: the second refusal is terminal.
    expect(bodies).toHaveLength(2)
    expect(hasOrphanToolResult(bodies[1]?.['messages'])).toBe(false)
    // The user-facing wording stays the contract with the Harness even here.
    expect(body.error.message).toMatch(/maximum context length/i)
    expect(body.error.message).toContain('deepseek-v4.1-flash')
  }, 60_000)

  it('treats a 11148 after a compaction as terminal rather than looping', async () => {
    const long = 'x'.repeat(4000)
    const { response, bodies } = await withShim(
      call => (call === 1 ? refused(OVERFLOW_BODY) : refused(PAIRING_BODY)),
      harness => post(harness, [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: long },
        { role: 'tool', tool_call_id: 'call-orphan', content: 'stale result' },
      ]),
    )

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.message).toContain('upstream tool_pairing after compaction')
    // One refusal, one retry — no third attempt.
    expect(bodies).toHaveLength(2)
  }, 60_000)
})
