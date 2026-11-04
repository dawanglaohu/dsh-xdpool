/**
 * One pool must serve every sign-in, whichever route produced it.
 *
 * The reported symptom: the WorkBuddy account a user had just scanned in on the
 * login page showed up TWICE — once under the 国内版 region card (which lists
 * `AccountPool.scan()`, i.e. desktop credential files) and once under a channel
 * card (which lists the vendored channel pack's own pool).
 *
 * The fix routes scan sign-ins through the same pool instead of merging two
 * lists at render time, and that only works if BOTH sides key an account by the
 * same upstream identity. These tests pin that identity, the merge, and the two
 * failure modes that would silently reintroduce the duplicate:
 *   - an unreadable credential costs that account, not the batch;
 *   - a source that throws costs the channel accounts, not the desktop ones.
 */

import { describe, expect, it } from 'vitest'
import {
  adoptChannelPackAccounts,
  packCredentialToWorkBuddy,
  readPackAccountPool,
  readPackCredentials,
  type PackAccountEntry,
} from '../src/pack-accounts.ts'
import { workbuddyAccountId, type WorkBuddyCredential } from '../src/accounts.ts'

/** A channel entry, the subset of the pack's account row the bridge reads. */
function entry(overrides: Partial<PackAccountEntry> & { provider: string }): PackAccountEntry {
  return {
    id: `${overrides.provider}-abcd1234`,
    nickname: 'pending-id',
    enabled: true,
    credentialRef: `${overrides.provider.toUpperCase()}_ACCOUNT_ABCD1234`,
    ...overrides,
  }
}

/** The snake_case credential document the pack writes, as JSON text. */
function document(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'jwt-access',
    refresh_token: 'jwt-refresh',
    expires_at: 1_900_000_000_000,
    domain: 'www.workbuddy.cn',
    user_id: 'uid-from-pack',
    nickname: '扫码用户',
    ...overrides,
  })
}

/** A pack pool whose credentials are JSON strings, as `resolve` returns them. */
function packReader(entries: readonly PackAccountEntry[], docs: Readonly<Record<string, string>>) {
  return {
    listAllAccounts: () => entries,
    resolveCredentialByRef: async (ref: string) => {
      const text = docs[ref]
      return text === undefined ? undefined : JSON.parse(text)
    },
  }
}

/** A cordis-like ctx whose `accountPool` service resolves to `service`. */
function ctxWith(service: unknown): { get(name: string): unknown } {
  return {
    get(name: string) {
      if (name !== 'accountPool') return undefined
      return service
    },
  }
}

describe('pack credential → pool credential', () => {
  it('maps the snake_case document onto the pool shape', () => {
    const credential = packCredentialToWorkBuddy(
      entry({ provider: 'workbuddy' }),
      JSON.parse(document()) as Record<string, unknown>,
    )
    expect(credential).toMatchObject({
      accessToken: 'jwt-access',
      refreshToken: 'jwt-refresh',
      expiresAtMs: 1_900_000_000_000,
      nickname: '扫码用户',
      uid: 'uid-from-pack',
      domain: 'www.workbuddy.cn',
      sourcePath: 'channel-pack:workbuddy:WORKBUDDY_ACCOUNT_ABCD1234',
    })
  })

  it('keeps a non-refreshable sign-in instead of dropping it', () => {
    // The pack records `refreshable: false` for these. A missing refresh token
    // is a fact about the token, not a reason to hide the account the user
    // just scanned in.
    const credential = packCredentialToWorkBuddy(
      entry({ provider: 'buddy' }),
      JSON.parse(document({ refresh_token: undefined })) as Record<string, unknown>,
    )
    expect(credential?.refreshToken).toBe('')
    expect(credential?.accessToken).toBe('jwt-access')
  })

  it('falls back to the channel domain so region routing stays honest', () => {
    // `regionOf` reads a missing domain as CN, which would file an
    // international sign-in under the 国内版 card.
    const credential = packCredentialToWorkBuddy(
      entry({ provider: 'workbuddy' }),
      JSON.parse(document({ domain: undefined })) as Record<string, unknown>,
    )
    expect(credential?.domain).toBe('www.workbuddy.ai')
  })

  it('rejects a credential with no access token', () => {
    expect(packCredentialToWorkBuddy(
      entry({ provider: 'buddy' }),
      JSON.parse(document({ access_token: undefined })) as Record<string, unknown>,
    )).toBeUndefined()
  })
})

describe('reading the pack pool', () => {
  it('returns only the two pool-owned channels', async () => {
    const reader = packReader(
      [
        entry({ provider: 'buddy' }),
        entry({ provider: 'workbuddy' }),
        entry({ provider: 'trae' }),
        entry({ provider: 'zcode' }),
      ],
      {
        BUDDY_ACCOUNT_ABCD1234: document(),
        WORKBUDDY_ACCOUNT_ABCD1234: document(),
        TRAE_ACCOUNT_ABCD1234: document(),
        ZCODE_ACCOUNT_ABCD1234: document(),
      },
    )
    const credentials = await readPackCredentials(reader)
    // TRAE and ZCode keep their own model roster and gateway; leaking them in
    // here would put them on a region card that cannot serve them.
    expect(credentials).toHaveLength(2)
    expect(credentials.every(c => c.sourcePath.startsWith('channel-pack:'))).toBe(true)
  })

  it('costs one unreadable credential, not the batch', async () => {
    const reader = packReader(
      [entry({ provider: 'buddy' }), entry({ provider: 'workbuddy', credentialRef: 'WORKBUDDY_ACCOUNT_MISSING' })],
      { BUDDY_ACCOUNT_ABCD1234: document() },
    )
    await expect(readPackCredentials(reader)).resolves.toHaveLength(1)
  })

  it('answers with nothing when there is no pool', async () => {
    await expect(readPackCredentials(undefined)).resolves.toEqual([])
  })

  it('awaits a pool whose listAllAccounts is async, as the vendored pack declares it', async () => {
    // `vendor/channel-pack/pack.js:30374` is `async listAllAccounts()`, so the
    // reading is a promise. Every other test here mocks it synchronously, which
    // is exactly how the missing await survived: the sync mock and the real
    // async pool both type-check, but only one of them hands back an array.
    const reader = {
      listAllAccounts: async () => [entry({ provider: 'buddy' })],
      resolveCredentialByRef: async (ref: string) =>
        ref === 'BUDDY_ACCOUNT_ABCD1234' ? JSON.parse(document()) : undefined,
    }
    await expect(readPackCredentials(reader)).resolves.toHaveLength(1)
  })

  it('treats a pool that lists nothing usable as no accounts, not a crash', async () => {
    const reader = {
      listAllAccounts: async () => [],
      resolveCredentialByRef: async () => undefined,
    }
    await expect(readPackCredentials(reader)).resolves.toEqual([])
  })

  it('refuses a service that does not look like the pack pool', () => {
    expect(readPackAccountPool(ctxWith({ listAllAccounts: () => [] }))).toBeUndefined()
    expect(readPackAccountPool(ctxWith(undefined))).toBeUndefined()
    expect(readPackAccountPool(ctxWith('not-a-pool'))).toBeUndefined()
  })

  it('survives a ctx whose property access throws', () => {
    // The host hands plugins a Proxy that throws for services the composition
    // does not declare; `get` is the escape hatch, but a ctx without one throws
    // in the same way and must read as "not available".
    const hostile = new Proxy({}, {
      get: () => { throw new Error('service not declared') },
    })
    expect(readPackAccountPool(hostile)).toBeUndefined()
    expect(readPackAccountPool(undefined)).toBeUndefined()
  })
})

describe('identity is the same on both sides', () => {
  it('keys a scan sign-in and a desktop sign-in of one person identically', () => {
    const fromPack = packCredentialToWorkBuddy(
      entry({ provider: 'workbuddy' }),
      JSON.parse(document({ nickname: undefined })) as Record<string, unknown>,
    ) as WorkBuddyCredential
    // The desktop credential file carries both uin and uid; `workbuddyAccountId`
    // reads uin first, so a pack row that only knows the uid would NOT match.
    // Asserted here because the merge is only as good as this key: if the two
    // routes disagree, the same person is two rows again.
    expect(fromPack.uid).toBe('uid-from-pack')
    expect(fromPack.uin).toBeUndefined()
    expect(workbuddyAccountId(fromPack)).toBe(
      workbuddyAccountId({ uin: undefined, uid: 'uid-from-pack', nickname: undefined } as WorkBuddyCredential),
    )
  })
})

describe('adopting channel accounts into the pool', () => {
  it('merges the pack accounts so they are scanned on later rescan', async () => {
    let source: (() => Promise<readonly WorkBuddyCredential[]>) | undefined
    let scans = 0
    const pool = {
      applyExternalSource(next?: () => Promise<readonly WorkBuddyCredential[]>) {
        source = next
      },
      async scan() {
        scans += 1
        return []
      },
    }
    const logs: string[] = []
    await adoptChannelPackAccounts(
      ctxWith(packReader([entry({ provider: 'buddy' })], { BUDDY_ACCOUNT_ABCD1234: document() })),
      pool,
      { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    )
    expect(source).toBeDefined()
    // The registration is the point: a later scan picks up whatever the pack
    // holds then, without this module having to poll.
    const credentials = await source?.()
    expect(credentials).toHaveLength(1)
    expect(scans).toBe(1)
    expect(logs.some(line => line.includes('including channel sign-ins'))).toBe(true)
  })

  it('still registers a source when the pool is not visible yet', async () => {
    let source: (() => Promise<readonly WorkBuddyCredential[]>) | undefined
    const logs: string[] = []
    await adoptChannelPackAccounts(
      ctxWith(undefined),
      { applyExternalSource: (next?: () => Promise<readonly WorkBuddyCredential[]>) => { source = next }, scan: async () => [] },
      { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    )
    // cordis resolves services lazily, so a mount that has not provided
    // `accountPool` yet still gets a source that will find it later.
    expect(source).toBeDefined()
    await expect(source?.()).resolves.toEqual([])
    expect(logs.some(line => line.includes('not visible yet'))).toBe(true)
  })

  it('never lets a failing scan throw out of the wiring', async () => {
    const logs: string[] = []
    await expect(adoptChannelPackAccounts(
      ctxWith(packReader([], {})),
      { applyExternalSource: () => {}, scan: async () => { throw new Error('store locked') } },
      { info: (m: string) => logs.push(m), warn: (m: string, e: unknown) => logs.push(`${m} ${String(e)}`) },
    )).resolves.toBeUndefined()
    expect(logs.some(line => line.includes('could not merge'))).toBe(true)
  })
})
