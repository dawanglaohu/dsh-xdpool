/**
 * An account the gateway RESTRICTED is not an account with a bad key.
 *
 * The reported symptom: the international provider died with "本轮运行失败 API
 * 密钥无效" while nine accounts were signed in. Four of them answered every chat
 * call with
 *
 *   HTTP 403 {"code":11140,"msg":"request illegal",
 *             "displayMsg":{"en":"Your account has been restricted due to unusual activity"}}
 *
 * Two things went wrong with that answer:
 *
 *   1. `classifyUpstreamError` read any 401/403 as `session_dead`, so the shim
 *      spent a token refresh on the account — the gateway happily hands a
 *      restricted account a NEW token and then refuses it again — and cooled it
 *      as if the sign-in had been revoked.
 *   2. The terminal message quoted the upstream status. pi-ai copies that status
 *      into the error text and the Harness turns any "401"/"403" into AUTH, which
 *      the chat UI titles "API 密钥无效" — a claim about a key that is provably
 *      valid.
 *
 * A restriction is its own class: the credential is fine, re-signing in cannot
 * lift it, and the fix is to rotate to another account (or wait). These tests pin
 * all of that, including the wording contract with the Harness classifier.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { classifyUpstreamError, WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { poolWebStatus } from '../src/web-status.ts'

/** Verbatim off the wire from www.workbuddy.ai for a restricted account. */
const RESTRICTED_BODY = JSON.stringify({
  code: 11140,
  msg: 'request illegal',
  displayMsg: {
    en: 'Your account has been restricted due to unusual activity',
    zh: '账号存在异常活动，已被限制使用',
  },
})

const shims: { close(): Promise<void> }[] = []

/** Write a fake auth directory holding `count` distinct GLOBAL accounts. */
async function fakeGlobalAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbpool-restricted-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: 'www.workbuddy.ai',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.2026-09-0${i}T00-00-00-000Z.1.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A pool over `count` global accounts, counting every token refresh it asks for. */
async function poolWith(count: number): Promise<{ pool: WorkBuddyAccountPool; refreshes: string[] }> {
  const refreshes: string[] = []
  const pool = new WorkBuddyAccountPool({
    authDirs: [await fakeGlobalAuthDir(count)],
    logger: { warn() {}, info() {}, error() {} },
    client: {
      async refreshToken(credential) {
        refreshes.push(credential.accessToken)
        // A restricted account CAN be refreshed — that is exactly why the old
        // "refresh and see" recovery looked plausible and wasted a call.
        return { accessToken: `fresh-${credential.accessToken}`, expiresInSec: 3600 }
      },
    },
  })
  await pool.scan()
  return { pool, refreshes }
}

describe('classifyUpstreamError — a restriction is not a dead sign-in', () => {
  it('recognises the real 11140 body that arrives as HTTP 403', () => {
    expect(classifyUpstreamError(403, RESTRICTED_BODY)).toBe('restricted')
  })

  it('recognises it by wording alone, at whatever status the gateway wraps it in', () => {
    for (const body of [
      '{"code":11140,"msg":"request illegal"}',
      'Your account has been restricted due to unusual activity',
      '账号存在异常',
      '{"displayMsg":{"zh":"账号被限制使用"}}',
    ]) {
      expect(classifyUpstreamError(403, body), `body: ${body}`).toBe('restricted')
    }
    // A 200 envelope carries the same meaning: the body, not the status, decides.
    expect(classifyUpstreamError(200, RESTRICTED_BODY)).toBe('restricted')
  })

  it('does not mistake the 11128 request-shape rejection for a restriction', () => {
    // Same `msg`, different business code: this one is fixable by sending the
    // headers the gateway wants, so cooling the account over it hides the bug.
    const shape = '{"code":11128,"msg":"request illegal","displayMsg":{"en":"request illegal"}}'
    expect(classifyUpstreamError(400, shape)).not.toBe('restricted')
    expect(classifyUpstreamError(400, shape)).toBe('client')
    expect(classifyUpstreamError(403, shape)).toBe('session_dead')
  })

  it('leaves every other 401/403 a dead session, so a revoked token still re-signs', () => {
    for (const body of ['', 'forbidden', 'unauthorized', 'api密钥无效', '<html>401</html>']) {
      expect(classifyUpstreamError(403, body), `body: ${body}`).toBe('session_dead')
      expect(classifyUpstreamError(401, body), `body: ${body}`).toBe('session_dead')
    }
  })
})

describe('a restricted account is cooled on its own, without paying for a refresh', () => {
  it('marks only the restricted account and reports it as the reason', async () => {
    const { pool } = await poolWith(2)
    const restricted = pool.list('global')[0]!
    pool.penalizeRestricted(restricted.id)

    const why = pool.unavailableReason('deepseek-v4.1-flash', 'global')
    expect(why.restricted).toBe(1)
    // Not misreported as a revoked sign-in: the remedy is the opposite one.
    expect(why.dead).toBe(0)
    expect(why.cooling).toBe(0)
    // The count is informational; what matters is that the other account still
    // serves. `reason` is only ever consulted when `acquire` finds nothing, so a
    // restricted account must not cost the pool the healthy one.
    const picked = await pool.acquire('deepseek-v4.1-flash', 'global')
    expect(picked).toBeDefined()
    expect(picked!.id).not.toBe(restricted.id)
  })

  it('reports "restricted" when the whole pool is restricted', async () => {
    const { pool } = await poolWith(2)
    for (const account of pool.list('global')) pool.penalizeRestricted(account.id)
    const why = pool.unavailableReason('deepseek-v4.1-flash', 'global')
    expect(why.reason).toBe('restricted')
    expect(why.restricted).toBe(2)
    expect(await pool.acquire('deepseek-v4.1-flash', 'global')).toBeUndefined()
  })

  it('never refreshes a restricted account, which the gateway would oblige and then refuse', async () => {
    const { pool, refreshes } = await poolWith(1)
    const account = pool.list('global')[0]!
    pool.penalizeRestricted(account.id)
    // The acquisition path must not treat the restriction as a stale token.
    expect(await pool.acquire('deepseek-v4.1-flash', 'global')).toBeUndefined()
    expect(refreshes).toEqual([])
  })

  it('puts restricted accounts back on the card\'s "clear all cooldowns" button', async () => {
    const { pool } = await poolWith(1)
    pool.penalizeRestricted(pool.list('global')[0]!.id)
    expect(pool.restrictedAccounts()).toHaveLength(1)
    pool.resetCooldowns()
    expect(pool.restrictedAccounts()).toHaveLength(0)
    expect(pool.status().restricted).toBe(0)
  })
})

describe('the shim rotates past a restricted account instead of failing the turn', () => {
  /** 403 + the 11140 body for the restricted tokens; a normal SSE stream otherwise. */
  function restrictedFetch(restrictedTokens: readonly string[], hits: string[]): typeof fetch {
    return (async (_url: unknown, init: RequestInit): Promise<Response> => {
      const headers = init.headers as Record<string, string>
      const token = (headers['Authorization'] ?? '').replace('Bearer ', '')
      hits.push(token)
      if (restrictedTokens.includes(token)) {
        return new Response(RESTRICTED_BODY, {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch
  }

  it('serves from a healthy account when the first one in the pool is restricted', async () => {
    const { pool, refreshes } = await poolWith(2)
    const hits: string[] = []
    const client = new WorkBuddyUpstreamClient({ fetchImpl: restrictedFetch(['token-0'], hits) })
    const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog('global'), region: 'global' })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    expect(pool.restrictedAccounts()).toHaveLength(1)
    // One refusal, then the next account: no refresh was paid for the restricted
    // account, and the dead mark was never set.
    expect(refreshes).toEqual([])
    expect(pool.deadCredentials()).toHaveLength(0)
    expect(hits.filter(token => token === 'token-0')).toHaveLength(1)
  })

  it('answers a non-auth failure when every account is restricted', async () => {
    const { pool } = await poolWith(2)
    for (const account of pool.list('global')) pool.penalizeRestricted(account.id)
    const shim = createWorkBuddyShim({
      pool,
      client: new WorkBuddyUpstreamClient({ fetchImpl: restrictedFetch([], []) }),
      catalog: new WorkBuddyCatalog('global'),
      region: 'global',
    })
    shims.push(shim)
    await shim.ready

    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await response.json() as { error?: { code?: string; message?: string } }
    const text = body.error?.message ?? ''

    expect(body.error?.code).toBe('restricted')
    expect(response.status).toBe(429)
    // The Harness classifies by TEXT: any 401/403 digit run becomes AUTH, i.e.
    // "API 密钥无效". None may appear, and neither may the wording that steers it
    // into INVALID_REQUEST or TRANSPORT.
    expect(text).not.toMatch(/\b(?:401|403)\b/)
    expect(text).not.toMatch(/unauthori[sz]ed|invalid.?request|network|connection|socket|fetch|timeout/i)
    // It must still say what happened and what the user can do.
    expect(text).toContain('11140')
    expect(text).toContain('signing in again will not help')
  })

  it('flags the account on the card so the row stops claiming a rejected sign-in', async () => {
    const { pool } = await poolWith(1)
    const account = pool.list('global')[0]!
    pool.penalizeRestricted(account.id)

    const status = await poolWebStatus({
      pool,
      catalogs: { cn: new WorkBuddyCatalog('cn'), global: new WorkBuddyCatalog('global') },
      client: new WorkBuddyUpstreamClient({
        fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      }),
    }, 'global')

    const row = status.accounts[0]!
    expect(row.restricted).toBe(true)
    expect(row.restrictedUntil).toBeDefined()
    expect(row.credentialDead).toBe(false)
    // No upstream probe while the account is out of rotation.
    expect(row.creditsError).toBeUndefined()
  })
})
