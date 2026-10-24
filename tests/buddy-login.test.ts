import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

// Execute the bundle's real OAuth helpers without importing its host-only modules.
function grab(startAnchor: string, endAnchor = '\n}'): string {
  const at = source.indexOf(startAnchor)
  if (at < 0) throw new Error(`pack.js no longer contains: ${startAnchor}`)
  const end = source.indexOf(endAnchor, at + startAnchor.length)
  if (end < 0) throw new Error(`pack.js declaration is unterminated: ${startAnchor}`)
  return source.slice(at, end + endAnchor.length)
}

type LoginProduct = {
  endpoint: string
  apiDomain: string
  platform: string
  userAgent: string
  appendSessionParams: boolean
  pluginVersion?: string
  login?: Pick<LoginProduct, 'endpoint' | 'apiDomain' | 'platform'>
}
type Token = { accessToken: string; domain: string }
type Fetcher = typeof fetch

const helpers = new Function(
  'WORKBUDDY_UA_INTL',
  'WORKBUDDY_UA_CN',
  'CODEBUDDY_FALLBACK_MODELS',
  'WORKBUDDY_FALLBACK_MODELS',
  'parseTokenData',
  'parseAccountData',
  'sleep',
  `"use strict";
  const AUTH_STATE_PATH = '/v2/plugin/auth/state';
  const AUTH_TOKEN_PATH = '/v2/plugin/auth/token';
  const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account';
  const HTTP_HEADER_DOMAIN = 'X-Domain';
  const HTTP_HEADER_NO_AUTHORIZATION = 'X-No-Authorization';
  const HTTP_HEADER_NO_USER_ID = 'X-No-User-Id';
  const HTTP_HEADER_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id';
  const HTTP_HEADER_NO_DEPARTMENT_INFO = 'X-No-Department-Info';
  const LOGIN_TIMEOUT_MS = 300000;
  const POLL_INTERVAL_MS = 1000;
  const STATE_REQUEST_TIMEOUT_MS = 10000;
  const REQUEST_TIMEOUT_MS = 60000;
  const CODE_TOKEN_NOT_READY = 11217;
  const CODE_ACCOUNT_NOT_READY = 12151;
  ${grab('var CODEBUDDY = {', '\n};')}
  ${grab('var WORKBUDDY = {', '\n};')}
  ${grab('function responseCode(body) {')}
  ${grab('function responseMessage(body) {')}
  ${grab('function responseData(body) {')}
  ${grab('async function request(method, url, headers, options) {')}
  ${grab('async function fetchAuthState(fetcher = fetch, signal, product = CODEBUDDY) {')}
  ${grab('async function loopGetToken(state, options = {}) {')}
  ${grab('async function getAccount(state, token, options = {}) {')}
  ${grab('function decorateLoginUrl(authUrl, product) {')}
  return { CODEBUDDY, WORKBUDDY, fetchAuthState, loopGetToken, getAccount, decorateLoginUrl };`,
)(
  'CodeBuddyIDE/5.5.2', 'CodeBuddyIDE/5.8.3', [], [],
  () => ({ accessToken: 'test-token', domain: '' }),
  () => ({ uid: 'test-user' }),
  async () => {},
) as {
  CODEBUDDY: LoginProduct
  WORKBUDDY: LoginProduct
  fetchAuthState: (fetcher: Fetcher, signal: undefined, product: LoginProduct) => Promise<{ state: string; authUrl: string }>
  loopGetToken: (state: string, options: { fetcher: Fetcher; product: LoginProduct; pollIntervalMs: number }) => Promise<Token>
  getAccount: (state: string, token: Token, options: { fetcher: Fetcher; product: LoginProduct; pollIntervalMs: number }) => Promise<unknown>
  decorateLoginUrl: (authUrl: string, product: LoginProduct) => string
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const domesticState = {
  code: 0,
  data: {
    state: 'domestic-state',
    authUrl: 'https://www.workbuddy.cn/login?platform=workbuddy&state=domestic-state',
  },
}

describe('Buddy QR login endpoints', () => {
  it('gets the domestic QR page from the current WorkBuddy China handshake', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(response(domesticState))
    const result = await helpers.fetchAuthState(fetcher, undefined, helpers.CODEBUDDY)

    expect(result).toEqual(domesticState.data)
    expect(fetcher).toHaveBeenCalledWith(
      'https://www.workbuddy.cn/v2/plugin/auth/state?platform=workbuddy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Domain': 'www.workbuddy.cn',
          'User-Agent': 'CodeBuddyIDE/1.106.1',
        }),
      }),
    )
  })

  it('uses the same domestic endpoint and state for token and account polls', async () => {
    const fetcher = vi.fn<Fetcher>().mockImplementation(async () => response({ code: 0, data: {} }))
    const token = await helpers.loopGetToken('domestic-state', {
      fetcher, product: helpers.CODEBUDDY, pollIntervalMs: 0,
    })
    await helpers.getAccount('domestic-state', token, {
      fetcher, product: helpers.CODEBUDDY, pollIntervalMs: 0,
    })

    const urls = fetcher.mock.calls.map(([url]) => String(url))
    expect(urls).toEqual([
      'https://www.workbuddy.cn/v2/plugin/auth/token?state=domestic-state',
      'https://www.workbuddy.cn/v2/plugin/login/account?state=domestic-state',
    ])
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
      'X-Domain': 'www.workbuddy.cn',
      Authorization: 'Bearer test-token',
    })
  })

  it('adds the domestic client version and a fresh login session', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(response(domesticState))
    const { authUrl } = await helpers.fetchAuthState(fetcher, undefined, helpers.CODEBUDDY)
    const url = new URL(helpers.decorateLoginUrl(authUrl, helpers.CODEBUDDY))

    expect(url.origin).toBe('https://www.workbuddy.cn')
    expect(url.searchParams.get('platform')).toBe('workbuddy')
    expect(url.searchParams.get('state')).toBe('domestic-state')
    expect(url.searchParams.get('version')).toBe('5.8.3')
    expect(url.searchParams.get('loginSessionId')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(url.searchParams.has('traceparent')).toBe(false)
    expect(url.searchParams.has('login_owner_id')).toBe(false)
    expect(url.searchParams.has('ww_device_nonce')).toBe(false)
  })

  it('leaves the international endpoint and session decoration unchanged', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(response({
      code: 0,
      data: {
        state: 'international-state',
        authUrl: 'https://www.workbuddy.ai/login/?platform=workbuddy-ai&state=international-state',
      },
    }))
    const { authUrl } = await helpers.fetchAuthState(fetcher, undefined, helpers.WORKBUDDY)
    const url = new URL(helpers.decorateLoginUrl(authUrl, helpers.WORKBUDDY))

    expect(fetcher.mock.calls[0][0]).toBe(
      'https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai',
    )
    expect(url.origin).toBe('https://www.workbuddy.ai')
    expect(url.searchParams.get('platform')).toBe('workbuddy-ai')
    expect(url.searchParams.get('state')).toBe('international-state')
    expect(url.searchParams.get('version')).toBe('5.5.2')
    expect(url.searchParams.get('loginSessionId')).toMatch(/^[0-9a-f-]{36}$/)
  })
})
