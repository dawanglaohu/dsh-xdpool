/**
 * Model saturation (upstream business code 14003) is NOT a rate limit.
 *
 * The bug, restated
 * -----------------
 * The gateway answers "this model's queue is full" with HTTP 429 and
 * `msg: "too many requests"`, so `classifyUpstreamError` filed it as
 * `soft_rate`. The shim then cooled that model on the account that happened to
 * be holding the request, and rotated. Six accounts later every account was
 * cooling the same model, and the NEXT request found nothing to try at all:
 *
 *   every account is rate-limited for model deepseek-v4.1-flash
 *   (6/6 cooling, tried 0) — deepseek-v4.1-flash-sg is the same model on a
 *   paid row (x0.03 credits) and is rate-limited separately
 *
 * "tried 0" is the tell: no request left the machine. Nothing was wrong with
 * any account — one model was busy for a few seconds.
 *
 * Saturation is a property of the MODEL, so the only sane response is to wait a
 * moment and ask the SAME account again. Cooling an account for it, or rotating
 * to another account that stands in the same queue, both turn a two-second
 * upstream hiccup into a minute of downtime.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { classifyUpstreamError, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** The upstream's real 14003 envelope, trimmed to the fields that matter. */
const SATURATED_BODY = JSON.stringify({
  code: 14003,
  msg: 'too many requests',
  requestId: 'a7a1fcbd-6d3c-4d0b-9a5e-2f1c8b6d4e10',
  displayMsg: {
    en: 'Model busy. Please switch models or retry later',
    zh: '模型繁忙，请换模型或稍后重试',
  },
  displayTips: {
    en: 'This model is currently saturated. It is not a network issue.',
    zh: '这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。',
  },
  actions: ['SWITCH_MODEL', 'SUBMIT_FEEDBACK', 'RETRY'],
})

/** The real 6004 envelope, which IS an account rate limit. */
const RATE_LIMITED_BODY = JSON.stringify({
  code: 6004,
  msg: '您的使用量已超出频率限制，将在 2026-09-04 15:14:46 UTC+8 重置',
})

function saturated(status = 429): Response {
  return new Response(SATURATED_BODY, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function served(): Response {
  return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** A pool holding `count` CN accounts. */
function poolWith(count: number): WorkBuddyAccountPool {
  const dir = mkdtempSync(join(tmpdir(), 'wbpool-saturation-'))
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

function post(shim: { baseUrl: () => string; token: () => string }, model = 'deepseek-v4.1-flash') {
  return fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
}

describe('classifyUpstreamError separates saturation from a rate limit', () => {
  it('reads a 429 carrying 14003 as model_busy, not soft_rate', () => {
    // The whole bug in one assertion: the status says 429, the BODY says the
    // model is busy. The body has to win, or the pool cools the wrong thing.
    expect(classifyUpstreamError(429, SATURATED_BODY)).toBe('model_busy')
  })

  it('recognises the wording even when the code is restated as a string', () => {
    expect(classifyUpstreamError(429, '{"code":"14003","msg":"too many requests"}')).toBe('model_busy')
    expect(classifyUpstreamError(429, '{"msg":"模型繁忙，请换模型或稍后重试"}')).toBe('model_busy')
    expect(classifyUpstreamError(429, 'Model busy. Please switch models or retry later')).toBe('model_busy')
    expect(classifyUpstreamError(429, 'This model is currently saturated.')).toBe('model_busy')
  })

  it('leaves a real rate limit a rate limit', () => {
    // The regression guard in the other direction. `too many requests` appears
    // in BOTH bodies, so a lazy pattern would swallow 6004 into model_busy and
    // stop cooling a genuinely exhausted account.
    expect(classifyUpstreamError(429, '')).toBe('soft_rate')
    expect(classifyUpstreamError(429, RATE_LIMITED_BODY)).toBe('soft_rate')
    expect(classifyUpstreamError(400, '"code":6004')).toBe('soft_rate')
    expect(classifyUpstreamError(400, '频率限制')).toBe('soft_rate')
  })
})

describe('a saturated model does not poison the pool', () => {
  it('re-asks the SAME account instead of rotating', async () => {
    const pool = poolWith(3)
    await pool.scan()
    const hit: string[] = []
    let calls = 0
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async (url: unknown, init: RequestInit) => {
        // Only chat calls count: a successful turn also fires a background
        // balance refresh, which is not a retry.
        if (!String(url).endsWith('/v2/chat/completions')) return served()
        const headers = init.headers as Record<string, string>
        hit.push((headers['Authorization'] ?? '').replace('Bearer ', ''))
        calls += 1
        // Busy once, then fine — exactly the live behaviour (one 14003, retry
        // succeeds).
        return calls === 1 ? saturated() : served()
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

    const response = await post(shim)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')

    // One account, asked twice: saturation never costs the pool an account.
    expect(new Set(hit).size).toBe(1)
    expect(hit).toHaveLength(2)
    expect(pool.list().every(a => a.cooldownUntilMs === 0)).toBe(true)
    expect(pool.list().every(a => Object.keys(a.modelCooldowns).length === 0)).toBe(true)
    await shim.close()
  }, 60_000)

  it('reports saturation as saturation when the model stays busy', async () => {
    const pool = poolWith(3)
    await pool.scan()
    const hit: string[] = []
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        const headers = init.headers as Record<string, string>
        hit.push((headers['Authorization'] ?? '').replace('Bearer ', ''))
        return saturated()
      }) as unknown as typeof fetch,
    })
    const shim = createWorkBuddyShim({
      pool,
      client,
      catalog: new WorkBuddyCatalog(),
      region: 'cn',
      saturationRetryDelaysMs: [1, 1],
    })
    await shim.ready

    const response = await post(shim)
    expect(response.status).toBe(429)
    const body = await response.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('model_busy')

    // The message has to name the MODEL and clear the accounts, because the
    // generic "after N account(s) [...]" line sends the user to re-sign in over
    // a busy queue.
    expect(body.error.message).toContain('deepseek-v4.1-flash')
    expect(body.error.message).toContain('saturated')
    expect(body.error.message).toContain('no account was cooled')
    expect(body.error.message).not.toContain('account(s)')

    // Three in-place attempts on ONE account — not one attempt each on three.
    expect(hit).toHaveLength(3)
    expect(new Set(hit).size).toBe(1)
    expect(pool.list().every(a => a.cooldownUntilMs === 0)).toBe(true)
    expect(pool.list().every(a => Object.keys(a.modelCooldowns).length === 0)).toBe(true)
    await shim.close()
  }, 60_000)

  it('leaves the pool usable for the very next request', async () => {
    // The reported symptom was the SECOND request: "6/6 cooling, tried 0".
    // After a saturation refusal the pool must still have an account to offer,
    // so the next turn reaches the upstream instead of failing before it starts.
    const pool = poolWith(2)
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => saturated()) as unknown as typeof fetch,
    })
    const shim = createWorkBuddyShim({
      pool,
      client,
      catalog: new WorkBuddyCatalog(),
      region: 'cn',
      saturationRetryDelaysMs: [],
    })
    await shim.ready

    const first = await post(shim)
    expect(first.status).toBe(429)
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe('model_busy')

    // No cooling was written, so the pool still reports a usable account...
    expect(pool.unavailableReason('deepseek-v4.1-flash', 'cn').reason).toBe('none')
    // ...and the next request really does leave the machine.
    const second = await post(shim)
    expect(second.status).toBe(429)
    const body = (await second.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('model_busy')
    expect(body.error.message).not.toContain('cooling')
    await shim.close()
  }, 60_000)
})
