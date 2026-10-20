/**
 * Outbound proxy injection tests.
 *
 * The contract under test: an account with a proxy chain NEVER reaches the
 * network directly, an account without one keeps the exact direct path it had
 * before proxies existed, and a dead chain fails as a transport error so the
 * pool cools that account down and rotates instead of retrying forever.
 *
 * No test here touches the network: the "proxy" endpoints are ports 1 and 2 on
 * loopback, which refuse the connection immediately.
 */

import { describe, expect, it } from 'vitest'
import { isStateFile } from '../src/account-store.ts'
import { workbuddyAccountId, type WorkBuddyCredential } from '../src/accounts.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'

/** Two loopback ports nothing can be listening on, used as guaranteed-dead hops. */
const DEAD_HOP_A = 'http://127.0.0.1:1'
const DEAD_HOP_B = 'http://127.0.0.1:2'

function credential(seed: string): WorkBuddyCredential {
  return {
    accessToken: `token-${seed}`,
    refreshToken: `refresh-${seed}`,
    expiresAtMs: Date.now() + 3_600_000,
    // Empty domain means CN, so the request goes to the CN chat gateway.
    domain: '',
    sourcePath: `/fake/${seed}.info`,
    nickname: `Account-${seed}`,
    uin: `1000000000${seed}`,
    uid: `uid-${seed}`,
  }
}

/**
 * A fetch stub that records every call and answers with an SSE stream.
 *
 * A successful answer is deliberate: it proves the request completed, so an
 * assertion that the stub was never called cannot be satisfied by a request that
 * simply failed before reaching it.
 */
function recordingFetch(state: { urls: string[] }): typeof fetch {
  return (async (url: unknown): Promise<Response> => {
    state.urls.push(String(url))
    return new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
}

describe('direct path', () => {
  it('uses fetchImpl directly when no chain resolver is configured', async () => {
    const state = { urls: [] as string[] }
    const client = new WorkBuddyUpstreamClient({ fetchImpl: recordingFetch(state) })
    const result = await client.chatStream(credential('a'), '{"messages":[]}')
    expect(result.ok).toBe(true)
    expect(state.urls).toHaveLength(1)
    expect(state.urls[0]).toContain('/v2/chat/completions')
  })

  it('stays direct when the resolver returns an empty chain', async () => {
    const state = { urls: [] as string[] }
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: recordingFetch(state),
      proxyFor: () => [],
    })
    const result = await client.chatStream(credential('a'), '{"messages":[]}')
    expect(result.ok).toBe(true)
    expect(state.urls).toHaveLength(1)
  })
})

describe('proxied path', () => {
  it('fails as a transport error and never falls back to direct', async () => {
    const state = { urls: [] as string[] }
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: recordingFetch(state),
      proxyFor: () => [DEAD_HOP_A],
      proxyConnectTimeoutMs: 2_000,
    })
    const result = await client.chatStream(credential('a'), '{"messages":[]}')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The pool reacts to this shape: status 0 plus kind 'server' is what it
    // treats as a transport failure, which is what cools the account down.
    expect(result.kind).toBe('server')
    expect(result.status).toBe(0)
    expect(result.message).toContain('transport error')
    // The load-bearing assertion: a bound account must not silently escape to
    // the bare fetch, or the whole feature degrades into "proxies are advisory".
    expect(state.urls).toHaveLength(0)
  })

  it('keeps each account on its own chain', async () => {
    const first = credential('a')
    const second = credential('b')
    const chains: Record<string, readonly string[]> = {
      [workbuddyAccountId(first)]: [DEAD_HOP_A],
      [workbuddyAccountId(second)]: [DEAD_HOP_B],
    }
    const state = { urls: [] as string[] }
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: recordingFetch(state),
      proxyFor: (holder) => chains[workbuddyAccountId(holder)] ?? [],
      proxyConnectTimeoutMs: 2_000,
    })

    const firstResult = await client.chatStream(first, '{"messages":[]}')
    const secondResult = await client.chatStream(second, '{"messages":[]}')
    expect(firstResult.ok).toBe(false)
    expect(secondResult.ok).toBe(false)
    if (firstResult.ok || secondResult.ok) return
    // Each error names the hop that was actually dialled, so a shared or
    // mis-keyed table shows up as the wrong port in the message.
    expect(firstResult.message).toContain('127.0.0.1:1')
    expect(firstResult.message).not.toContain('127.0.0.1:2')
    expect(secondResult.message).toContain('127.0.0.1:2')
    expect(secondResult.message).not.toContain('127.0.0.1:1')
    expect(state.urls).toHaveLength(0)
  })

  it('routes non-chat traffic through the chain too', async () => {
    const state = { urls: [] as string[] }
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: recordingFetch(state),
      proxyFor: () => [DEAD_HOP_A],
      proxyConnectTimeoutMs: 2_000,
    })
    // Credits are fetched on the billing host, a different origin from chat; a
    // proxy that only wrapped chat would leak this call from the user's own IP.
    await expect(client.fetchCredits(credential('a'))).rejects.toThrow()
    expect(state.urls).toHaveLength(0)
  })
})

describe('state files', () => {
  it('keeps proxies.json out of the credential snapshot scan', () => {
    // True means "plugin bookkeeping", and the snapshot scanner drops exactly
    // those names. A proxies.json parsed as a credential would add a phantom
    // account whose token is a routing table.
    expect(isStateFile('proxies.json')).toBe(true)
    expect(isStateFile('proxies.json')).not.toBe(isStateFile('abcd1234.info'))
  })
})
