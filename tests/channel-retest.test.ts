/**
 * The two rate-limit actions the channel card gained: retest and clear.
 *
 * Both read an answer the pack computes, and both answers have a case that looks
 * like a no-op and is not:
 *
 * - `account.retest` probes only the models that carry a mark, so an account
 *   with no mark is tested zero times and returns at once. A card that printed
 *   "reachable" for that would be reporting a request nobody sent.
 * - `account.reset` deletes marks without sending anything, so a count of zero
 *   means there was nothing recorded — not that the reset failed.
 *
 * The parsers are pinned against the pack's own shapes (`{accounts: [row],
 * clearedCount}` for a retest, `{clearedCount, accountCount}` for a reset) so a
 * field rename shows up here rather than as a silent "refused" in the UI.
 */
import { describe, expect, it } from 'vitest'
import { resetResultFrom, retestResultFrom } from '../src/client/channel-rpc.ts'
import { resetNotice, retestNotice } from '../src/client/ChannelPoolSection.tsx'

const ok = (value: unknown) => ({ ok: true, value })

describe('reads what a rate-limit retest actually did', () => {
  it('keeps the account, the probed count and both outcome lists', () => {
    const outcome = retestResultFrom(ok({
      accounts: [{
        accountId: 'qoder-a778e077',
        nickname: 'Ernser V Caden',
        tested: 2,
        cleared: ['dfmodel'],
        stillLimited: [{ modelId: 'qfmodel', ok: false, message: '仍受限：qoder: Billing daily count exceeded' }],
      }],
      clearedCount: 1,
    }))
    expect(outcome).toEqual({
      accountId: 'qoder-a778e077',
      nickname: 'Ernser V Caden',
      tested: 2,
      cleared: ['dfmodel'],
      stillLimited: [{ modelId: 'qfmodel', message: '仍受限：qoder: Billing daily count exceeded' }],
    })
  })

  it('reads an account with no mark as tested zero, not as a refusal', () => {
    const outcome = retestResultFrom(ok({
      accounts: [{ accountId: 'qoder-d0b7b99b', nickname: '龙霸王', tested: 0, cleared: [], stillLimited: [] }],
      clearedCount: 0,
    }))
    expect(outcome?.tested).toBe(0)
    expect(outcome?.cleared).toEqual([])
    expect(outcome?.stillLimited).toEqual([])
  })

  it('carries the pack\'s own words when it could not find the account', () => {
    const outcome = retestResultFrom(ok({
      accounts: [{ accountId: 'gone', tested: 0, cleared: [], stillLimited: [], error: '账号 gone 不存在' }],
    }))
    expect(outcome?.error).toBe('账号 gone 不存在')
  })

  it('drops rows it cannot name rather than inventing a model id', () => {
    const outcome = retestResultFrom(ok({
      accounts: [{ accountId: 'a', tested: 1, cleared: ['x', 7], stillLimited: [{ message: 'no id' }, null] }],
    }))
    expect(outcome?.cleared).toEqual(['x'])
    expect(outcome?.stillLimited).toEqual([])
  })

  it('answers undefined for a refusal and for a shape it does not know', () => {
    expect(retestResultFrom({ ok: false, error: { message: 'bad-request' } })).toBeUndefined()
    expect(retestResultFrom(ok({ accounts: [] }))).toBeUndefined()
    expect(retestResultFrom(ok({}))).toBeUndefined()
    expect(retestResultFrom(ok(null))).toBeUndefined()
  })
})

describe('reads what a rate-limit reset cleared', () => {
  it('keeps both counts', () => {
    expect(resetResultFrom(ok({ clearedCount: 3, accountCount: 2 })))
      .toEqual({ clearedCount: 3, accountCount: 2 })
  })

  it('treats a missing count as zero instead of NaN', () => {
    expect(resetResultFrom(ok({}))).toEqual({ clearedCount: 0, accountCount: 0 })
    expect(resetResultFrom(ok({ clearedCount: 'two' }))).toEqual({ clearedCount: 0, accountCount: 0 })
  })

  it('answers undefined when the pack refused', () => {
    expect(resetResultFrom({ ok: false, error: { message: 'nope' } })).toBeUndefined()
  })
})

describe('says what a retest did in one sentence', () => {
  const none = { accountId: 'a', tested: 0, cleared: [], stillLimited: [] }

  it('says nothing was probed when nothing was marked', () => {
    expect(retestNotice(none, undefined)).toBe('No model was marked, so nothing was probed.')
  })

  it('reports the count that answered again', () => {
    expect(retestNotice({ ...none, tested: 2, cleared: ['a', 'b'] }, undefined))
      .toBe('2 model(s) answered again; their mark is gone.')
  })

  it('keeps the vendor wording for the models that still refuse', () => {
    const notice = retestNotice({
      ...none,
      tested: 2,
      cleared: [],
      stillLimited: [{ modelId: 'dfmodel', message: '仍受限：qoder: Billing daily count exceeded' }],
    }, undefined)
    expect(notice).toBe('1 model(s) still limited: 仍受限：qoder: Billing daily count exceeded')
  })

  it('passes the pack\'s own error through verbatim', () => {
    expect(retestNotice({ ...none, error: '账号 a 不存在' }, undefined)).toBe('账号 a 不存在')
  })

  it('says refused when the envelope never arrived', () => {
    expect(retestNotice(undefined, undefined)).toBe('Retest refused.')
  })
})

describe('says what a reset cleared', () => {
  it('calls zero marks a real answer rather than a failure', () => {
    expect(resetNotice({ clearedCount: 0, accountCount: 0 }, undefined))
      .toBe('No rate-limit mark was recorded.')
  })

  it('prints both counts when something was cleared', () => {
    expect(resetNotice({ clearedCount: 3, accountCount: 2 }, undefined))
      .toBe('Cleared 3 mark(s) on 2 account(s).')
  })

  it('says refused when the envelope never arrived', () => {
    expect(resetNotice(undefined, undefined)).toBe('Reset refused.')
  })
})
