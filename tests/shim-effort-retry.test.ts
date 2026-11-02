/**
 * The shim's answer to a 11133 that survives the clamp.
 *
 * Why this file exists
 * --------------------
 * The user's turn died on `{"code":11133,"msg":"Invalid request parameters",
 * "extError":{"message":"the request parameters were rejected by the model
 * provider"}}` in a session whose model (`kimi-k3.1-pro`) declares `low/high/max`
 * and was asking for `max` — a level the row accepts. Replaying that exact body
 * against the same gateway answered 200 twenty times in a row, so the refusal is
 * the provider's, not the request's.
 *
 * Two behaviours follow from that, and each is pinned below:
 *
 *   A. a level the catalog does not declare is CLAMPED before it is sent, so the
 *      common case (a `max`-defaulted session on a row that only admits `high`)
 *      never reaches the upstream at all
 *   B. when a 11133 arrives anyway, the level is dropped and the body re-sent
 *      once, then the same body is tried one more time, because the provider that
 *      refused it is known to accept it moments later
 *
 * The second half of B is what a user notices: without it the failure surfaces as
 * "Invalid request parameters", which reads as something they did.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** The live 11133 body, verbatim. */
const EFFORT_BODY = JSON.stringify({
  code: 11133,
  msg: 'Invalid request parameters',
  requestId: 'de9e5289-c18d-4e8b-a1c7-fa71c52da7dd',
  retry_policy: { retry: false },
  extError: {
    code: '400001',
    message: 'the request parameters were rejected by the model provider',
    type: 'invalid_request_error',
  },
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

function poolWith(count: number): WorkBuddyAccountPool {
  const dir = mkdtempSync(join(tmpdir(), 'wbpool-effort-'))
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
}

/**
 * Run one request through a real shim, keeping every chat body it sent.
 *
 * `reply` decides what the Nth chat call answers, so a test can assert both what
 * went on the wire and how many attempts the shim spent.
 */
async function withShim(
  reply: (call: number, body: Record<string, unknown>) => Response,
  send: (harness: ShimHarness) => Promise<Response>,
): Promise<{ response: Response; bodies: Record<string, unknown>[] }> {
  const pool = poolWith(1)
  await pool.scan()
  const bodies: Record<string, unknown>[] = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: (async (url: unknown, init: RequestInit) => {
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
    saturationRetryDelaysMs: [],
  })
  await shim.ready
  try {
    const response = await send({ baseUrl: shim.baseUrl(), token: shim.token() })
    return { response, bodies }
  } finally {
    await shim.close()
  }
}

function post(harness: ShimHarness, model: string, effort?: string): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  }
  if (effort !== undefined) body['reasoning_effort'] = effort
  return fetch(`${harness.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${harness.token}` },
    body: JSON.stringify(body),
  })
}

describe('A. the level is clamped to what the row declares', () => {
  it('sends `high` for a max-defaulted session on a row that only admits high', async () => {
    // `hy4-preview` declares `['high']` and refuses `max` every time — the one
    // reproducible 11133 in the corpus.
    const { response, bodies } = await withShim(() => served(), harness => post(harness, 'hy4-preview', 'max'))
    expect(response.status).toBe(200)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]['reasoning_effort']).toBe('high')
  })

  it('leaves the level alone when the row declares it', async () => {
    const { bodies } = await withShim(() => served(), harness => post(harness, 'kimi-k3.1-pro', 'max'))
    expect(bodies[0]['reasoning_effort']).toBe('max')
  })
})

describe('B. a 11133 that survives the clamp is retried, not surfaced', () => {
  it('drops the level after the first refusal and succeeds on the retry', async () => {
    const { response, bodies } = await withShim(
      call => (call === 1 ? refused(EFFORT_BODY) : served()),
      harness => post(harness, 'kimi-k3.1-pro', 'max'),
    )
    expect(response.status).toBe(200)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]['reasoning_effort']).toBe('max')
    // The retry asks for no level at all: every row measured accepts that shape.
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('re-sends the level-free body once more when the provider keeps refusing', async () => {
    // The exact shape of the incident: the provider answers 11133 to a body it
    // accepts moments later. Two refusals in a row still leave one attempt, and
    // that attempt is what keeps the user's turn alive.
    const { response, bodies } = await withShim(
      call => (call <= 2 ? refused(EFFORT_BODY) : served()),
      harness => post(harness, 'kimi-k3.1-pro', 'max'),
    )
    expect(response.status).toBe(200)
    expect(bodies).toHaveLength(3)
    expect(bodies[0]['reasoning_effort']).toBe('max')
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
    // Attempt 3 is the same level-free body again, not the level restored.
    expect(bodies[2]).not.toHaveProperty('reasoning_effort')
  })

  it('gives up once every attempt has been spent, and says which code it was', async () => {
    const { response, bodies } = await withShim(() => refused(EFFORT_BODY), harness => post(harness, 'kimi-k3.1-pro', 'max'))
    // 1 level-dropping retry + 1 same-body retry, then the pool has nothing left
    // to offer for this model and the request fails with the upstream's own words.
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('11133')
  })

  it('does not spend a retry on a 400 that is not about the thinking level', async () => {
    // A malformed body is not a provider hiccup: re-sending it would cost the
    // user a round trip and teach nothing.
    const other = JSON.stringify({ code: 11101, msg: 'Unmarshal chat params failed' })
    const { response, bodies } = await withShim(() => refused(other), harness => post(harness, 'kimi-k3.1-pro', 'max'))
    expect(bodies).toHaveLength(1)
    expect(response.status).toBe(400)
  })
})
