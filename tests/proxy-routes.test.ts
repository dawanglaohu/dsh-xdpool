/**
 * Per-account proxy route tests.
 *
 * Two things can silently rot here and neither shows up in review. A save route
 * that refuses the empty chain takes away the only way back to a direct dial,
 * and a chain entry that is accepted without being dialable turns into a
 * connect failure the user cannot trace to the line they typed. So the parser's
 * accept/reject boundary is asserted entry by entry, and the round trip through
 * the dependency is asserted with the exact values that travelled.
 *
 * The status document is covered from the same angle: a row must report the
 * chain the host masked for it, and must report a direct dial when the host
 * wired nothing at all, rather than an empty chain that reads as "broken".
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkBuddyAccountPool } from '../src/accounts.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import {
  POOL_ACCOUNT_PROXY_PATH,
  POOL_PROXY_TEST_PATH,
  type PoolWebProxyProbeResult,
} from '../src/status-paths.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { poolWebStatus, registerPoolStatusRoute } from '../src/web-status.ts'
import type { PoolStatusRouteOptions } from '../src/web-status.ts'

/** Write a fake auth directory holding `count` distinct accounts. */
async function fakeAuthDir(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-proxy-routes-'))
  const auth = join(dir, 'auth')
  await mkdir(auth, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const document = {
      auth: {
        accessToken: `token-${i}`,
        refreshToken: `refresh-${i}`,
        expiresAt: Date.now() + 3_600_000,
        refreshExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        domain: '',
      },
      account: { uid: `uid-${i}-${'0'.repeat(24)}`, uin: `10000000000${i}`, nickname: `Account${i}` },
    }
    const name = i === 0 ? 'workbuddy-desktop.info' : `workbuddy-desktop.r.${i}.uuid.info`
    await writeFile(join(auth, name), JSON.stringify(document), 'utf8')
  }
  return auth
}

/** A context stand-in that records every registration, plus the mount-time disposers. */
function fakeContext(routes: Map<string, unknown>): { ctx: unknown; disposers: (() => void)[] } {
  const disposers: (() => void)[] = []
  return {
    disposers,
    ctx: {
      effect(fn: () => unknown) {
        // Real cordis runs the effect body at mount and keeps its returned
        // disposer, so calling `fn()` is what makes the routes register.
        const result = fn()
        if (typeof result === 'function') disposers.push(result as () => void)
        return () => {}
      },
      webServer: {
        register(entry: { path: string; handler: unknown }) {
          routes.set(entry.path, entry.handler)
          return () => { routes.delete(entry.path) }
        },
      },
    },
  }
}

/** A scanned pool over `count` fake accounts, plus the route table it mounts into. */
async function mount(
  deps: Partial<PoolStatusRouteOptions> = {},
  count = 2,
): Promise<{ routes: Map<string, unknown>; pool: WorkBuddyAccountPool; disposers: (() => void)[] }> {
  const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(count)], logger: { warn() {} } })
  await pool.scan()
  const routes = new Map<string, unknown>()
  const { ctx, disposers } = fakeContext(routes)
  registerPoolStatusRoute(ctx as never, {
    pool,
    catalogs: { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() },
    client: new WorkBuddyUpstreamClient(),
    saveSelection() {},
    setCreditReserve() {},
    ...deps,
  })
  return { routes, pool, disposers }
}

/** A POST request carrying a small JSON body from the loopback origin. */
function postReq(body: unknown, origin = 'http://localhost:3000'): unknown {
  const text = JSON.stringify(body)
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {}
  const req = {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    on(event: string, listener: (arg?: unknown) => void) {
      ;(listeners[event] ??= []).push(listener)
      return req
    },
    destroy() {},
  }
  // Flush on the next tick so the handler can attach its listeners first.
  setTimeout(() => {
    if (listeners['data'] !== undefined) for (const fn of listeners['data']) fn(Buffer.from(text, 'utf8'))
    if (listeners['end'] !== undefined) for (const fn of listeners['end']) fn()
  }, 0)
  return req
}

/** Fake ServerResponse capturing what the handler wrote. */
function fakeRes(): { res: unknown; read: () => { status: number; body: Record<string, unknown> } } {
  const state = { status: 0, body: undefined as unknown }
  const res = {
    writableEnded: false,
    writeHead(status: number) { state.status = status },
    end(payload: string) {
      state.body = JSON.parse(payload)
      this.writableEnded = true
    },
  }
  return { res, read: () => ({ status: state.status, body: state.body as Record<string, unknown> }) }
}

/** The handler a route table holds for `path`. */
function handlerFor(routes: Map<string, unknown>, path: string): (req: unknown, res: unknown) => Promise<void> {
  const handler = routes.get(path)
  expect(handler, `${path} should be registered`).toBeDefined()
  return handler as (req: unknown, res: unknown) => Promise<void>
}

describe('the proxy save route', () => {
  it('mounts alongside the rest of the table and leaves with it', async () => {
    const { routes, disposers } = await mount()
    expect(routes.has(POOL_ACCOUNT_PROXY_PATH)).toBe(true)
    expect(routes.has(POOL_PROXY_TEST_PATH)).toBe(true)
    for (const dispose of disposers) dispose()
    expect(routes.has(POOL_ACCOUNT_PROXY_PATH)).toBe(false)
    expect(routes.has(POOL_PROXY_TEST_PATH)).toBe(false)
  })

  it('answers a non-POST with 405, because a prefetch must not rewrite a chain', async () => {
    const { routes } = await mount({ setAccountProxies() {} })
    const { res, read } = fakeRes()
    await handlerFor(routes, POOL_ACCOUNT_PROXY_PATH)(
      { method: 'GET', headers: { origin: 'http://localhost:3000' }, on() {}, destroy() {} },
      res,
    )
    expect(read().status).toBe(405)
  })

  it('refuses a foreign origin, so a page on the LAN cannot point an account elsewhere', async () => {
    const seen: string[][] = []
    const { routes } = await mount({ setAccountProxies: (_id, proxies) => { seen.push([...proxies]) } })
    const { res, read } = fakeRes()
    await handlerFor(routes, POOL_ACCOUNT_PROXY_PATH)(
      postReq({ accountId: 'whatever', proxies: ['http://h:8080'] }, 'http://192.168.1.50:3000'),
      res,
    )
    expect(read().status).toBe(403)
    expect(seen).toEqual([])
  })

  it('answers 503 when the host wired no store, rather than pretending to save', async () => {
    const { routes } = await mount()
    const { res, read } = fakeRes()
    const accountId = 'acct-1'
    await handlerFor(routes, POOL_ACCOUNT_PROXY_PATH)(postReq({ accountId, proxies: [] }), res)
    expect(read().status).toBe(503)
  })

  it('rejects an account id the pool cannot show', async () => {
    const seen: string[][] = []
    const { routes } = await mount({ setAccountProxies: (_id, proxies) => { seen.push([...proxies]) } })
    const { res, read } = fakeRes()
    await handlerFor(routes, POOL_ACCOUNT_PROXY_PATH)(
      postReq({ accountId: 'not-a-real-account', proxies: ['http://h:8080'] }),
      res,
    )
    expect(read().status).toBe(400)
    expect(read().body['error']).toBe('invalid proxy payload')
    expect(seen).toEqual([])
  })

  it('rejects a payload whose chain is not a list of dialable proxy URLs', async () => {
    const { routes, pool } = await mount({ setAccountProxies() {} })
    const accountId = pool.list()[0]!.id
    const handler = handlerFor(routes, POOL_ACCOUNT_PROXY_PATH)
    const bad: unknown[] = [
      { accountId },
      { accountId, proxies: 'http://h:8080' },
      { accountId, proxies: [1] },
      { accountId, proxies: ['http://h:8080', null] },
      // A scheme the transport cannot dial, a hostless hop, and plain nonsense:
      // each one would otherwise fail at connect time, long after the save
      // looked successful.
      { accountId, proxies: ['ftp://h:21'] },
      { accountId, proxies: ['socks5://'] },
      { accountId, proxies: ['not a url'] },
    ]
    for (const body of bad) {
      const { res, read } = fakeRes()
      await handler(postReq(body), res)
      expect(read().status, JSON.stringify(body)).toBe(400)
    }
  })

  it('accepts an empty chain as "direct", which is the only way back', async () => {
    const seen: { accountId: string; proxies: readonly string[] }[] = []
    const { routes, pool } = await mount({
      setAccountProxies: (accountId, proxies) => { seen.push({ accountId, proxies }) },
    })
    const accountId = pool.list()[0]!.id
    const { res, read } = fakeRes()
    await handlerFor(routes, POOL_ACCOUNT_PROXY_PATH)(postReq({ accountId, proxies: [] }), res)
    expect(read().status).toBe(200)
    expect(read().body).toEqual({ ok: true, accountId, count: 0 })
    expect(seen).toEqual([{ accountId, proxies: [] }])
  })

  it('forwards a chain unchanged, masked password and all', async () => {
    const seen: { accountId: string; proxies: readonly string[] }[] = []
    const { routes, pool } = await mount({
      setAccountProxies: (accountId, proxies) => { seen.push({ accountId, proxies }) },
    })
    const accountId = pool.list()[0]!.id
    const chain = ['socks5://u:****@h:1080', 'http://second:8080']
    const { res, read } = fakeRes()
    await handlerFor(routes, POOL_ACCOUNT_PROXY_PATH)(postReq({ accountId, proxies: chain }), res)
    expect(read().status).toBe(200)
    expect(read().body).toEqual({ ok: true, accountId, count: 2 })
    // The mask travels through untouched: restoring the real secret belongs to
    // whoever owns the store, and the route must not guess at it.
    expect(seen).toEqual([{ accountId, proxies: chain }])
  })
})

describe('the proxy self-test route', () => {
  it('reports each hop exactly as the transport measured it', async () => {
    const results: PoolWebProxyProbeResult[] = [
      { proxy: 'socks5://u:****@h:1080', ok: true, status: 204, latencyMs: 88, egressIp: '203.0.113.7' },
      { proxy: 'http://second:8080', ok: false, error: 'connect ETIMEDOUT' },
    ]
    const asked: string[] = []
    const { routes, pool } = await mount({
      testAccountProxies: async (accountId) => { asked.push(accountId); return results },
    })
    const accountId = pool.list()[0]!.id
    const { res, read } = fakeRes()
    await handlerFor(routes, POOL_PROXY_TEST_PATH)(postReq({ accountId }), res)
    expect(read().status).toBe(200)
    expect(read().body).toEqual({ ok: true, accountId, results })
    expect(asked).toEqual([accountId])
  })

  it('turns a transport that threw into 500 rather than a silent empty result', async () => {
    const { routes, pool } = await mount({
      testAccountProxies: async () => { throw new Error('no such account') },
    })
    const { res, read } = fakeRes()
    await handlerFor(routes, POOL_PROXY_TEST_PATH)(postReq({ accountId: pool.list()[0]!.id }), res)
    expect(read().status).toBe(500)
    expect(read().body['error']).toBe('no such account')
  })

  it('refuses GET and an unwired transport, the two ways a test button lies', async () => {
    const { routes, pool } = await mount()
    const handler = handlerFor(routes, POOL_PROXY_TEST_PATH)
    const read = fakeRes()
    await handler({ method: 'GET', headers: { origin: 'http://localhost:3000' }, on() {}, destroy() {} }, read.res)
    expect(read.read().status).toBe(405)
    const unwired = fakeRes()
    await handler(postReq({ accountId: pool.list()[0]!.id }), unwired.res)
    expect(unwired.read().status).toBe(503)
  })
})

describe('the status document reports the chain', () => {
  /** The card's document over a pool of `count` accounts, with a client that never dials. */
  async function document(deps: Partial<PoolStatusRouteOptions>, count = 2) {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(count)], logger: { warn() {} } })
    await pool.scan()
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    })
    return await poolWebStatus({
      pool,
      catalogs: { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() },
      client,
      ...deps,
    })
  }

  it('carries the masked chain the host handed it, with its real length', async () => {
    const pool = new WorkBuddyAccountPool({ authDirs: [await fakeAuthDir(2)], logger: { warn() {} } })
    await pool.scan()
    const ids = pool.list().map(account => account.id)
    const chain = ['socks5://u:****@h:1080', 'http://second:8080']
    const status = await poolWebStatus({
      pool,
      catalogs: { cn: new WorkBuddyCatalog(), global: new WorkBuddyCatalog() },
      client: new WorkBuddyUpstreamClient({
        fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
      }),
      accountProxies: (accountId) => accountId === ids[0] ? chain : [],
    })
    const rows = status.accounts
    expect(rows.map(row => row.proxies)).toEqual([chain, []])
    // Masking must not cost the count: "proxy x2" is what the card shows.
    expect(rows.map(row => row.proxyCount)).toEqual([2, 0])
    // Health is reported from the chain's existence alone; the live verdict
    // belongs to the self-test route.
    expect(rows.map(row => row.proxyHealth)).toEqual(['ok', 'direct'])
  })

  it('reports a direct dial when the host wired no proxy lookup at all', async () => {
    const status = await document({}, 1)
    expect(status.accounts[0]!.proxies).toEqual([])
    expect(status.accounts[0]!.proxyCount).toBe(0)
    expect(status.accounts[0]!.proxyHealth).toBe('direct')
  })
})
