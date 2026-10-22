/**
 * Qoder's encrypted inference path (`agent_chat_generation`) used to hand the
 * fetch promise straight to undici and wait. undici's own `headersTimeout` is
 * 300s and reports the expiry as `TypeError: fetch failed` — the same text it
 * uses for a refused connection, a dead proxy and a DNS failure. So a gateway
 * that simply never answers looked like this in the chat UI, five minutes later:
 *
 *     qoder: transport error: fetch failed
 *
 * which reads like a provider-side block ("风控升级") and says nothing about
 * what actually happened. The cases below run the real `sendEncrypted` against
 * real sockets rather than a stub, because the failure mode being pinned is a
 * timing one: a deadline that is either absent, or still armed after the
 * response headers arrive (which would cut a healthy long stream in half).
 *
 * The pack is a vendored bundle with host-only imports, so it cannot be
 * imported here; the two helpers and the one method are lifted out of its
 * source text and executed in a stubbed scope instead.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PACK = new URL('../vendor/channel-pack/pack.js', import.meta.url)
const source = readFileSync(PACK, 'utf8')

/**
 * Slice one top-level declaration out of the bundle by its opening and closing
 * anchors. The end anchor is deliberately excluded so the next declaration's
 * first line is not swallowed with it.
 */
function grab(startAnchor: string, endAnchor: string): string {
  const at = source.indexOf(startAnchor)
  if (at < 0) throw new Error(`pack.js no longer contains: ${startAnchor}`)
  const end = source.indexOf(endAnchor, at + startAnchor.length)
  if (end < 0) throw new Error(`pack.js declaration is unterminated: ${startAnchor}`)
  return source.slice(at, end + endAnchor.length)
}

const HEADERS_TIMEOUT_FN = grab('function resolveHeadersTimeoutMs4() {', '\n}')
const CAUSE_FN = grab('function describeTransportCause4(error) {', '\n}')
const SEND_ENCRYPTED = grab('  async sendEncrypted(request2, options) {', '\n  }')

/** The bundle's own error class, reproduced with the two fields callers read. */
class LlmErrorStub extends Error {
  readonly code: string
  readonly cause: unknown
  constructor(message: string, code: string, extra?: { cause?: unknown }) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.cause = extra?.cause
  }
}

/**
 * `isTransportError4` is copied verbatim rather than imported: it lives in the
 * bundle too, and the point of these cases is the interaction between it and
 * the deadline, not its own contents.
 */
function isTransportError4(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

type Deadline = () => number
type Cause = (error: unknown) => string
type SendEncrypted = (request: { url: string; headers: Record<string, string>; body: string }, options: { signal?: AbortSignal }) => Promise<Response>

const helpers = new Function(
  'LlmError7',
  'isTransportError4',
  `"use strict";
   ${HEADERS_TIMEOUT_FN}
   ${CAUSE_FN}
   return { resolveHeadersTimeoutMs4, describeTransportCause4 };`,
)(LlmErrorStub, isTransportError4) as { resolveHeadersTimeoutMs4: Deadline; describeTransportCause4: Cause }

const Adapter = new Function(
  'LlmError7',
  'isTransportError4',
  'resolveHeadersTimeoutMs4',
  'describeTransportCause4',
  `"use strict";
   class QoderAdapter {
     constructor(fetchImpl) { this.fetchImpl = fetchImpl; }
     ${SEND_ENCRYPTED}
   }
   return QoderAdapter;`,
)(LlmErrorStub, isTransportError4, helpers.resolveHeadersTimeoutMs4, helpers.describeTransportCause4) as new (fetch: typeof fetch) => { sendEncrypted: SendEncrypted }

const servers: http.Server[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) server.close()
})

/** A listening socket that accepts the connection and then says nothing at all. */
async function silentServer(): Promise<number> {
  const server = http.createServer(() => {})
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

const request = (port: number): { url: string; headers: Record<string, string>; body: string } => ({
  url: `http://127.0.0.1:${port}/algo/api/v2/service/pro/sse/agent_chat_generation`,
  headers: { 'content-type': 'application/json' },
  body: 'x',
})

describe('the qoder encrypted-inference deadline', () => {
  it('is 120s by default and overridable, matching the first-token budget', () => {
    expect(helpers.resolveHeadersTimeoutMs4()).toBe(120_000)
    vi.stubEnv('DSH_QODER_HEADERS_TIMEOUT_MS', '4500')
    expect(helpers.resolveHeadersTimeoutMs4()).toBe(4500)
    // A garbage value must not become a zero/NaN deadline, which would abort
    // every request before it was sent.
    vi.stubEnv('DSH_QODER_HEADERS_TIMEOUT_MS', 'nonsense')
    expect(helpers.resolveHeadersTimeoutMs4()).toBe(120_000)
  })

  it('reports a gateway that never sends headers as TIMEOUT, not as a transport error', async () => {
    vi.stubEnv('DSH_QODER_HEADERS_TIMEOUT_MS', '400')
    const adapter = new Adapter(fetch)
    const started = Date.now()
    const failure = await adapter.sendEncrypted(request(await silentServer()), {}).then(
      () => undefined,
      (error: unknown) => error as LlmErrorStub,
    )
    const elapsed = Date.now() - started

    expect(failure).toBeInstanceOf(LlmErrorStub)
    expect(failure?.code).toBe('TIMEOUT')
    // The whole point: bounded well below undici's 300s, so the host's retry
    // policy gets to act instead of the user staring at a spinner for 5 min.
    expect(elapsed).toBeLessThan(5_000)
    expect(failure?.message).toContain('400ms')
    expect(failure?.message).not.toContain('fetch failed')
    // The abort that produced it is named, so "we killed it" cannot be mistaken
    // for "the network refused us".
    expect(failure?.message).toContain('AbortError')
  })

  it('disarms the deadline once headers arrive, so a long stream survives', async () => {
    vi.stubEnv('DSH_QODER_HEADERS_TIMEOUT_MS', '400')
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"ok":1}\n\n')
      // Body keeps flowing well past the header deadline.
      setTimeout(() => {
        response.write('data: {"ok":2}\n\n')
        response.end()
      }, 900)
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    const adapter = new Adapter(fetch)
    const response = await adapter.sendEncrypted(request((server.address() as AddressInfo).port), {})
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('data: {"ok":1}\n\ndata: {"ok":2}\n\n')
  })

  it('keeps a genuine connection failure as TRANSPORT, with the undici cause chain attached', async () => {
    // A port that was listening a moment ago: connecting yields ECONNREFUSED
    // rather than the DNS delay a fake hostname would cost on Windows.
    const port = await silentServer()
    await new Promise<void>(resolve => {
      const last = servers.pop()
      if (last === undefined) return resolve()
      last.close(() => resolve())
    })

    const adapter = new Adapter(fetch)
    const failure = await adapter.sendEncrypted(request(port), {}).then(
      () => undefined,
      (error: unknown) => error as LlmErrorStub,
    )

    expect(failure?.code).toBe('TRANSPORT')
    expect(failure?.message).toContain('fetch failed')
    // `fetch failed` alone is what made this indistinguishable from a hang;
    // the cause chain is what tells them apart.
    expect(failure?.message).toContain('ECONNREFUSED')
    expect(helpers.describeTransportCause4(new Error('fetch failed'))).toBe('Error')
  })

  it('passes the caller’s abort through unwrapped', async () => {
    vi.stubEnv('DSH_QODER_HEADERS_TIMEOUT_MS', '30000')
    const controller = new AbortController()
    const adapter = new Adapter(fetch)
    setTimeout(() => controller.abort(), 100)

    const failure = await adapter
      .sendEncrypted(request(await silentServer()), { signal: controller.signal })
      .then(() => undefined, (error: unknown) => error as Error)

    // A user pressing stop is not a provider failure and must not be retried.
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(LlmErrorStub)
    expect(failure?.name).toBe('AbortError')
  })

  it('sends the request under a signal at all', () => {
    // Without `signal` in the fetch init there is no deadline to speak of, and
    // undici silently falls back to its own 300s — the exact regression this
    // whole file exists to prevent.
    expect(SEND_ENCRYPTED).toContain('signal')
    expect(SEND_ENCRYPTED).toContain('clearTimeout')
    expect(SEND_ENCRYPTED).toContain('AbortSignal.any')
  })
})
