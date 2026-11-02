import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The domestic WorkBuddy login page stopped writing plugin credentials.
 *
 * Its vendor page moved to the `/signin/*` web-login app, which finishes by
 * handing the session to the DESKTOP client (`workbuddy://`) instead of calling
 * `/v2/plugin/auth/token`. The pack's `loopGetToken` therefore polls a code
 * (`11217`, "login ing…") forever and can only end on its deadline — and before
 * this fix that deadline was five minutes, the reason only reached
 * `ctx.logger.warn`, and the placeholder account was deleted, so `login.poll`
 * answered `{done:false}` until the page's own ten-minute timeout printed
 * "Sign-in failed" with nothing to act on.
 *
 * These assertions pin the three halves of the fix against the vendored bundle
 * source, because the bundle is a build artefact: nothing typechecks it, and a
 * regeneration would silently drop the change.
 */
const source = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

function grab(startAnchor: string, endAnchor = '\n}'): string {
  const at = source.indexOf(startAnchor)
  if (at < 0) throw new Error(`pack.js no longer contains: ${startAnchor}`)
  const end = source.indexOf(endAnchor, at + startAnchor.length)
  if (end < 0) throw new Error(`pack.js declaration is unterminated: ${startAnchor}`)
  return source.slice(at, end + endAnchor.length)
}

type Product = {
  id: string
  endpoint: string
  apiDomain: string
  platform: string
  userAgent: string
  appendSessionParams: boolean
  pluginVersion?: string
  loginTimeoutMs?: number
  login?: { endpoint: string; apiDomain: string; platform: string }
}

const helpers = new Function(
  'WORKBUDDY_UA_INTL',
  'WORKBUDDY_UA_CN',
  'CODEBUDDY_FALLBACK_MODELS',
  'WORKBUDDY_FALLBACK_MODELS',
  `"use strict";
  ${grab('var CODEBUDDY = {', '\n};')}
  ${grab('var WORKBUDDY = {', '\n};')}
  ${grab('function buddyLoginFailureHint(product, error) {')}
  return { CODEBUDDY, WORKBUDDY, buddyLoginFailureHint };`,
)('CodeBuddyIDE/5.5.2', 'CodeBuddyIDE/5.8.3', [], []) as {
  CODEBUDDY: Product
  WORKBUDDY: Product
  buddyLoginFailureHint: (product: Product, error: unknown) => string
}

describe('WorkBuddy login wait budget', () => {
  it('gives the domestic lane a scan-sized budget instead of five minutes', () => {
    expect(helpers.CODEBUDDY.loginTimeoutMs).toBe(120_000)
  })

  it('leaves the international lane on the shared default', () => {
    // The international page still completes the plugin handshake, so a scan
    // there really can take minutes; shortening it would break working logins.
    expect(helpers.WORKBUDDY.loginTimeoutMs).toBeUndefined()
    expect(helpers.WORKBUDDY.login).toBeUndefined()
  })

  it('lets a product budget override the module default at both poll deadlines', () => {
    const chain = 'options.timeoutMs ?? product.loginTimeoutMs ?? LOGIN_TIMEOUT_MS'
    const occurrences = source.split(chain).length - 1
    // One per loop: the token poll and the account poll. A fix that only
    // shortened the first would still leave the second waiting five minutes
    // after a login that already succeeded.
    expect(occurrences).toBe(2)
  })
})

describe('WorkBuddy login failure reaches the page', () => {
  it('answers the domestic lane with the remedy, not the timeout text', () => {
    const hint = helpers.buddyLoginFailureHint(
      helpers.CODEBUDDY,
      new Error('获取 token 超时：浏览器里完成登录后未回写凭据'),
    )
    expect(hint).toContain('WorkBuddy')
    expect(hint).toContain('重新检测账号')
    // The vendor reason stays quoted: it is what tells a future reader whether
    // the diagnosis still holds or the page moved again.
    expect(hint).toContain('获取 token 超时')
  })

  it('passes an international failure through unchanged', () => {
    const hint = helpers.buddyLoginFailureHint(helpers.WORKBUDDY, new Error('auth/token HTTP 500 code=1: boom'))
    expect(hint).toBe('auth/token HTTP 500 code=1: boom')
    expect(hint).not.toContain('重新检测账号')
  })

  it('records the reason where login.poll reads it', () => {
    // `pendingLoginFailures` is the pack's only channel from a background
    // login failure to the polling client; without this write the row can
    // never learn why it failed.
    expect(source).toContain('pendingLoginFailures.set(id, buddyLoginFailureHint(product, err).slice(0, 500));')
  })

  it('does not leave the failed placeholder in the account list', () => {
    const at = source.indexOf('pendingLoginFailures.set(id, buddyLoginFailureHint(product, err)')
    expect(at).toBeGreaterThan(0)
    const after = source.slice(at, at + 400)
    expect(after).toContain('pool.removeAccount(id)')
  })
})
