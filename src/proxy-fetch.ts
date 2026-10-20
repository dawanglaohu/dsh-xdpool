/**
 * The outbound transport for a proxied request: one HTTP round trip through a
 * user-supplied proxy, with an ordered fallback chain behind it.
 *
 * Why not globalThis.fetch: it has no way to say "leave through this SOCKS5
 * endpoint". The supported way to teach it that is an undici dispatcher, and a
 * dispatcher is an npm dependency -- this plugin ships with none. The repository
 * already carries a hand-rolled transport for exactly this reason (freeFetch in
 * free-upstream.ts), so this module keeps that shape: node:http/node:https plus
 * Readable.toWeb. One way to make an outbound call, not two.
 *
 * Why not socks-proxy-agent: same reason. SOCKS5 is ~60 lines of RFC1928/1929,
 * and the alternative is a dependency that reaches into the agent internals of a
 * fetch implementation we do not control.
 *
 * Three paths, because the two proxy families are genuinely different shapes:
 *
 * | proxy scheme    | target scheme | how it works                                  |
 * | --------------- | ------------- | --------------------------------------------- |
 * | http:/https:    | http:         | absolute-form request line, sent to the proxy |
 * | http:/https:    | https:        | CONNECT, then TLS inside the tunnel           |
 * | socks5:/socks5h:| any           | RFC1928 handshake, then the same two cases    |
 *
 * Failure policy is a table, not a judgement call, because the caller (the pool
 * shim) reads these reasons to decide cooldowns and rotation:
 *
 * | phase              | event                      | action                    |
 * | ------------------ | -------------------------- | ------------------------- |
 * | TCP connect        | ECONNREFUSED/ETIMEDOUT/... | next proxy, 'connect'     |
 * | CONNECT tunnel     | non-200 reply              | next proxy, 'tunnel'      |
 * | tunnel             | timeout                    | next proxy, 'timeout'     |
 * | SOCKS5             | method/auth rejected       | next proxy, 'auth'        |
 * | SOCKS5 reply       | REP !== 0                  | next proxy, 'socks'       |
 * | TLS inside tunnel  | handshake or certificate   | next proxy, 'tls'         |
 * | response head seen | ANY status code            | return it, never retry    |
 * | any phase          | caller aborted             | stop immediately          |
 * | chain exhausted    | --                         | throw ProxyChainError     |
 *
 * "Response head seen, never retry" is the load-bearing rule. Retrying a 402 or
 * a 429 would spend a second upstream attempt on one caller request and hand the
 * shim a signal it cannot attribute to an account -- its cooldown and rotation
 * decisions read the status code, so a retry makes them read noise.
 *
 * @module dsh-xdpool/proxy-fetch
 */

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { ReadableStream } from 'node:stream/web'
import type { ConnectionOptions } from 'node:tls'

/** Stands in for a password in anything that leaves the process. */
export const PROXY_PASSWORD_MASK = '****'

/** Used by {@link redactProxy}, whose output goes into logs and error messages. */
const REDACTED_PASSWORD = '***'

/** Longest proxy string quoted verbatim when it cannot be parsed. */
const MAX_QUOTED_PROXY_LENGTH = 120

/** Default budget for reaching a proxy AND finishing its handshake. */
const DEFAULT_CONNECT_TIMEOUT_MS = 8000

/** TCP-level errno values that mean "this proxy is not there". */
const CONNECT_ERRNOS = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
])

/** The proxy families this module speaks. */
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])

/** Port per scheme, used when the URL leaves it out. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'http:': 8080,
  'https:': 8080,
  'socks5:': 1080,
  'socks5h:': 1080,
}

export interface ProxyEndpoint {
  readonly url: string
  readonly protocol: 'http:' | 'https:' | 'socks5:' | 'socks5h:'
  readonly host: string
  readonly port: number
  readonly auth?: { readonly username: string; readonly password: string }
}

/**
 * A proxy URL in structured form, or undefined when it is not one we can use.
 *
 * Deliberately does not judge whether the host is a name or an address: that
 * choice belongs at handshake time, where SOCKS5 needs a different address type
 * for each. Rejecting a hostname here would make socks5h impossible.
 */
export function parseProxyUrl(raw: string): ProxyEndpoint | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  if (!PROXY_PROTOCOLS.has(parsed.protocol)) return undefined
  const host = unbracket(parsed.hostname)
  if (host === '') return undefined
  const port = parsed.port === '' ? DEFAULT_PORTS[parsed.protocol] ?? 0 : Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const protocol = parsed.protocol as ProxyEndpoint['protocol']
  if (parsed.username === '') return { url: text, protocol, host, port }
  return {
    url: text,
    protocol,
    host,
    port,
    auth: {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    },
  }
}

/** Rebuild a proxy URL from its parts, with a caller-chosen password. */
function formatProxy(endpoint: ProxyEndpoint, password: string): string {
  const credentials = endpoint.auth === undefined
    ? ''
    : encodeURIComponent(endpoint.auth.username) + ':' + encodeURIComponent(password) + '@'
  const host = net.isIP(endpoint.host) === 6 ? '[' + endpoint.host + ']' : endpoint.host
  return endpoint.protocol + '//' + credentials + host + ':' + endpoint.port
}

/** Password replaced with ***, for logs and error messages. */
export function redactProxy(raw: string): string {
  const endpoint = parseProxyUrl(raw)
  if (endpoint === undefined) {
    const text = typeof raw === 'string' ? raw : String(raw)
    return text.length > MAX_QUOTED_PROXY_LENGTH ? text.slice(0, MAX_QUOTED_PROXY_LENGTH) : text
  }
  return formatProxy(endpoint, endpoint.auth === undefined ? '' : REDACTED_PASSWORD)
}

/** Password replaced with {@link PROXY_PASSWORD_MASK}, for the browser. */
export function maskProxy(raw: string): string {
  const endpoint = parseProxyUrl(raw)
  if (endpoint === undefined) return typeof raw === 'string' ? raw : String(raw)
  return formatProxy(endpoint, endpoint.auth === undefined ? '' : PROXY_PASSWORD_MASK)
}

/**
 * Turn a masked proxy string coming back from the UI into the real one.
 *
 * The card never receives a password, so a round trip through it must not
 * destroy the stored one: when the submitted password is still the mask, the
 * real password is recovered from the entry it was masked from. A string whose
 * password is not the mask passes through untouched -- that is the user typing a
 * new password.
 */
export function resolveMaskedProxy(submitted: string, previous: readonly string[]): string | undefined {
  const endpoint = parseProxyUrl(submitted)
  if (endpoint === undefined) return undefined
  if (endpoint.auth === undefined || endpoint.auth.password !== PROXY_PASSWORD_MASK) return submitted
  for (const candidate of previous) {
    const known = parseProxyUrl(candidate)
    if (known === undefined || known.auth === undefined) continue
    if (known.protocol !== endpoint.protocol) continue
    if (known.host !== endpoint.host) continue
    if (known.port !== endpoint.port) continue
    if (known.auth.username !== endpoint.auth.username) continue
    return candidate
  }
  return undefined
}

export type ProxyFailureReason = 'connect' | 'timeout' | 'tunnel' | 'auth' | 'socks' | 'tls'

export interface ProxyAttemptFailure {
  readonly proxy: string
  readonly reason: ProxyFailureReason
  readonly message: string
}

/** Raised when every proxy in the chain failed. One entry per attempt. */
export class ProxyChainError extends Error {
  readonly failures: readonly ProxyAttemptFailure[]

  constructor(failures: readonly ProxyAttemptFailure[]) {
    const detail = failures
      .map(failure => failure.proxy + ': ' + failure.reason + (failure.message === '' ? '' : ' (' + failure.message + ')'))
      .join('; ')
    super('every proxy failed: ' + (detail === '' ? 'no proxy configured' : detail))
    this.name = 'ProxyChainError'
    this.failures = failures
  }
}

/**
 * Per-proxy circuit breaker.
 *
 * Without it a dead proxy costs a full connect timeout on EVERY request, and the
 * pool's retry loop turns one dead endpoint into minutes of dead air. State is
 * keyed by the raw URL, so two accounts sharing a proxy share the verdict.
 */
export class ProxyBreaker {
  private readonly state = new Map<string, { failures: number; openUntilMs: number }>()
  private readonly failuresToOpen: number
  private readonly openMs: number

  constructor(options: { failuresToOpen?: number; openMs?: number } = {}) {
    this.failuresToOpen = options.failuresToOpen ?? 3
    this.openMs = options.openMs ?? 60_000
  }

  shouldSkip(proxy: string, nowMs: number = Date.now()): boolean {
    const entry = this.state.get(proxy)
    if (entry === undefined) return false
    if (entry.openUntilMs > nowMs) return true
    // The open window expired: forget the record so the next failure starts a
    // fresh count instead of re-opening the circuit on a single error.
    if (entry.openUntilMs !== 0) this.state.delete(proxy)
    return false
  }

  noteSuccess(proxy: string): void {
    this.state.delete(proxy)
  }

  noteFailure(proxy: string, nowMs: number = Date.now()): void {
    const entry = this.state.get(proxy) ?? { failures: 0, openUntilMs: 0 }
    entry.failures += 1
    if (entry.failures >= this.failuresToOpen) entry.openUntilMs = nowMs + this.openMs
    this.state.set(proxy, entry)
  }
}

export interface SendViaProxiesOptions {
  readonly connectTimeoutMs?: number
  readonly breaker?: ProxyBreaker
  readonly logger?: { warn?(message: string): void }
  readonly tlsOptions?: ConnectionOptions
}

/** Test seam: replaces net.connect so a suite can watch the dial itself. */
export const proxyLane: { connect: unknown } = { connect: null }

/** Marks the connect/handshake budget expiring, so it can be classified. */
class ProxyTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyTimeoutError'
  }
}

/** The proxy answered CONNECT with something other than 200. */
class ProxyTunnelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyTunnelError'
  }
}

/** The proxy wants credentials we do not have, or rejected the ones we sent. */
class ProxyAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyAuthError'
  }
}

/** A SOCKS5 reply we could not use. */
class ProxySocksError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxySocksError'
  }
}

/** TLS to the target failed inside an otherwise working tunnel. */
class ProxyTlsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyTlsError'
  }
}

/** Map an internal error onto the reason the caller's policy table expects. */
function failureReason(error: unknown): ProxyFailureReason {
  if (error instanceof ProxyTimeoutError) return 'timeout'
  if (error instanceof ProxyTunnelError) return 'tunnel'
  if (error instanceof ProxyAuthError) return 'auth'
  if (error instanceof ProxySocksError) return 'socks'
  if (error instanceof ProxyTlsError) return 'tls'
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  // Everything left is a dial failure: a refused port, an unreachable host, a
  // lookup that never resolved. Anything unclassified lands here too, so the
  // caller always receives a reason it can act on.
  if (typeof code === 'string' && CONNECT_ERRNOS.has(code)) return 'connect'
  return 'connect'
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unknown error'
}

/**
 * Caller already gave up?
 *
 * A function rather than an inline `signal?.aborted === true` because the two
 * check sites would otherwise share one narrowing: after the first check types
 * the expression as false | undefined, the second comparison looks like dead
 * code to the compiler -- and to the next reader.
 */
function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true
}

/** '[::1]' -> '::1'. URL keeps the brackets, sockets do not. */
function unbracket(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

/**
 * Pulls a scripted number of bytes off a socket, keeping what it did not use.
 *
 * Handshakes are byte-exact and node has no "read exactly n bytes" primitive:
 * data arrives in whatever chunks the kernel chooses. This buffers, and hands the
 * remainder back on {@link ByteReader.release} so the HTTP layer starts at the
 * first byte that is actually HTTP.
 */
class ByteReader {
  // Annotated, not inferred: Buffer.alloc(0) is Buffer<ArrayBuffer> while the
  // chunks arriving on 'data' are Buffer<ArrayBufferLike>, and the wider type has
  // to be the one the field carries.
  private buffered: Buffer = Buffer.alloc(0)
  private failure: Error | undefined
  private pending: {
    resolve: (value: Buffer) => void
    reject: (error: Error) => void
    take: () => Buffer | undefined
  } | undefined
  private readonly socket: net.Socket

  constructor(socket: net.Socket) {
    this.socket = socket
    socket.on('data', this.onData)
    socket.once('end', this.onGone)
    socket.once('close', this.onGone)
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    this.settle()
  }

  private readonly onGone = (): void => {
    this.fail(new Error('proxy closed the connection'))
  }

  private settle(): void {
    const pending = this.pending
    if (pending === undefined) return
    const value = pending.take()
    if (value === undefined) return
    this.pending = undefined
    pending.resolve(value)
  }

  private fail(error: Error): void {
    const pending = this.pending
    this.pending = undefined
    if (pending === undefined) this.failure = error
    else pending.reject(error)
  }

  private pull(take: () => Buffer | undefined): Promise<Buffer> {
    const failure = this.failure
    if (failure !== undefined) return Promise.reject(failure)
    return new Promise<Buffer>((resolve, reject) => {
      this.pending = { resolve, reject, take }
      this.settle()
    })
  }

  read(size: number): Promise<Buffer> {
    return this.pull(() => {
      if (this.buffered.length < size) return undefined
      const out = Buffer.from(this.buffered.subarray(0, size))
      this.buffered = this.buffered.subarray(size)
      return out
    })
  }

  readUntil(token: Buffer): Promise<Buffer> {
    return this.pull(() => {
      const index = this.buffered.indexOf(token)
      if (index < 0) return undefined
      const end = index + token.length
      const out = Buffer.from(this.buffered.subarray(0, end))
      this.buffered = this.buffered.subarray(end)
      return out
    })
  }

  /** Stop reading, and hand back whatever the handshake did not consume. */
  release(): Buffer {
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('end', this.onGone)
    this.socket.removeListener('close', this.onGone)
    const rest = this.buffered
    this.buffered = Buffer.alloc(0)
    return rest
  }
}

/**
 * An agent that dials nothing and returns a socket we already prepared.
 *
 * Not createConnection on the request itself: with agent: false node ignores it
 * and dials the target directly, which would send the request around the proxy
 * while still reporting success. A one-shot agent is the shape node honours.
 */
class TunnelAgent extends http.Agent {
  private readonly tunnel: net.Socket

  constructor(tunnel: net.Socket) {
    super({ keepAlive: false, maxSockets: 1 })
    this.tunnel = tunnel
  }

  override createConnection(): net.Socket {
    return this.tunnel
  }
}

/** Dial the proxy itself, TLS-wrapped when the proxy URL says https. */
function dialProxy(endpoint: ProxyEndpoint, adopt: (socket: net.Socket) => void): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const seam = proxyLane.connect as ((options: net.NetConnectOpts) => net.Socket) | null
    let socket: net.Socket
    try {
      socket = seam === null
        ? net.connect({ host: endpoint.host, port: endpoint.port })
        : seam({ host: endpoint.host, port: endpoint.port })
    } catch (error) {
      reject(error)
      return
    }
    // Swallow 'error' here so a socket we have not handed off yet can never take
    // the process down; every real failure still surfaces through the promise.
    socket.on('error', () => {})
    adopt(socket)
    if (endpoint.protocol !== 'https:') {
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
      return
    }
    socket.once('connect', () => {
      const secured = tls.connect({
        socket,
        host: endpoint.host,
        servername: net.isIP(endpoint.host) === 0 ? endpoint.host : undefined,
      })
      secured.once('secureConnect', () => resolve(secured))
      secured.once('error', reject)
    })
    socket.once('error', reject)
  })
}

/** Open a CONNECT tunnel and hand back the raw socket behind it. */
async function openHttpTunnel(
  socket: net.Socket,
  endpoint: ProxyEndpoint,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  const authority = targetHost + ':' + targetPort
  const lines = ['CONNECT ' + authority + ' HTTP/1.1', 'Host: ' + authority]
  if (endpoint.auth !== undefined) {
    const pair = endpoint.auth.username + ':' + endpoint.auth.password
    lines.push('Proxy-Authorization: Basic ' + Buffer.from(pair, 'utf8').toString('base64'))
  }
  const reader = new ByteReader(socket)
  try {
    socket.write(lines.join('\r\n') + '\r\n\r\n', 'latin1')
    const head = (await reader.readUntil(Buffer.from('\r\n\r\n', 'latin1'))).toString('latin1')
    const statusLine = head.split('\r\n')[0] ?? ''
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
    const status = match?.[1] === undefined ? 0 : Number(match[1])
    if (status !== 200) {
      throw new ProxyTunnelError(status === 0 ? 'malformed CONNECT reply' : 'CONNECT rejected with ' + status)
    }
    return socket
  } finally {
    const rest = reader.release()
    if (rest.length > 0) socket.unshift(rest)
  }
}

/** IPv6 text to its 16 wire bytes, or undefined when it is not a plain literal. */
function ipv6Bytes(text: string): Buffer | undefined {
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ?? ''
  const right = halves.length > 1 ? halves[1] ?? '' : undefined
  const leftGroups = left === '' ? [] : left.split(':')
  const rightGroups = right === undefined || right === '' ? [] : right.split(':')
  const missing = 8 - leftGroups.length - rightGroups.length
  if (right === undefined ? missing !== 0 : missing < 0) return undefined
  const groups = right === undefined
    ? leftGroups
    : [...leftGroups, ...new Array<string>(missing).fill('0'), ...rightGroups]
  if (groups.length !== 8) return undefined
  const out = Buffer.alloc(16)
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]
    if (group === undefined || !/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
    out.writeUInt16BE(Number.parseInt(group, 16), index * 2)
  }
  return out
}

/** The SOCKS5 destination field for a target host. */
function socksAddress(host: string): Buffer {
  const family = net.isIP(host)
  if (family === 4) {
    const octets = host.split('.').map(part => Number(part))
    return Buffer.from([0x01, ...octets])
  }
  if (family === 6) {
    const bytes = ipv6Bytes(host)
    if (bytes !== undefined) return Buffer.concat([Buffer.from([0x04]), bytes])
  }
  // ATYP 0x03 for both socks5: and socks5h:. curl resolves socks5: targets
  // locally; we deliberately do not, because local resolution leaks the target
  // hostname into this machine's DNS, which is the one thing a proxy user is
  // trying to avoid. Leaving the name to the proxy costs nothing when the host
  // really is a name.
  const name = Buffer.from(host, 'utf8')
  return Buffer.concat([Buffer.from([0x03, name.length]), name])
}

/** RFC1928 + RFC1929 handshake, then hand back the raw socket. */
async function openSocksTunnel(
  socket: net.Socket,
  endpoint: ProxyEndpoint,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  const reader = new ByteReader(socket)
  try {
    // Offer no-auth always, and user/pass only when we have credentials: asking
    // for a method we cannot complete just invites a 0xFF rejection.
    socket.write(endpoint.auth === undefined
      ? Buffer.from([0x05, 0x01, 0x00])
      : Buffer.from([0x05, 0x02, 0x00, 0x02]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05) throw new ProxySocksError('proxy did not answer with SOCKS5')
    const method = greeting[1]
    if (method === 0x02) {
      const auth = endpoint.auth
      if (auth === undefined) throw new ProxyAuthError('proxy demands authentication but none is configured')
      const user = Buffer.from(auth.username, 'utf8')
      const pass = Buffer.from(auth.password, 'utf8')
      socket.write(Buffer.concat([
        Buffer.from([0x01, user.length]),
        user,
        Buffer.from([pass.length]),
        pass,
      ]))
      const reply = await reader.read(2)
      if (reply[0] !== 0x01 || reply[1] !== 0x00) throw new ProxyAuthError('SOCKS5 authentication rejected')
    } else if (method !== 0x00) {
      // 0xFF is "no acceptable method", which in practice means the proxy wanted
      // credentials we did not offer.
      throw new ProxyAuthError('proxy rejected every offered SOCKS5 method (' + (method ?? 'none') + ')')
    }

    const port = Buffer.alloc(2)
    port.writeUInt16BE(targetPort, 0)
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(targetHost), port]))

    const head = await reader.read(4)
    if (head[0] !== 0x05) throw new ProxySocksError('malformed SOCKS5 reply')
    const reply = head[1]
    if (reply !== 0x00) throw new ProxySocksError('SOCKS5 CONNECT failed with reply ' + (reply ?? 'none'))
    const atyp = head[3]
    if (atyp === 0x01) await reader.read(4)
    else if (atyp === 0x04) await reader.read(16)
    else if (atyp === 0x03) {
      const length = await reader.read(1)
      await reader.read(length[0] ?? 0)
    } else {
      throw new ProxySocksError('malformed SOCKS5 reply address')
    }
    await reader.read(2)
    return socket
  } finally {
    const rest = reader.release()
    if (rest.length > 0) socket.unshift(rest)
  }
}

/** Wrap an established tunnel socket in TLS for an https target. */
function upgradeTunnelTls(
  socket: net.Socket,
  target: URL,
  tlsOptions: ConnectionOptions | undefined,
): Promise<tls.TLSSocket> {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const host = unbracket(target.hostname)
    const secured = tls.connect({
      ...tlsOptions,
      socket,
      // An IP literal is not a valid SNI name; node refuses it outright.
      servername: net.isIP(host) === 0 ? host : undefined,
      ALPNProtocols: ['http/1.1'],
    })
    secured.once('secureConnect', () => resolve(secured))
    secured.once('error', (error: Error) => {
      reject(new ProxyTlsError(error.message))
    })
  })
}

/** Wrap the node response without buffering it. */
function toResponse(response: IncomingMessage): Response {
  // Streaming, never buffered. The upstream answers most requests with SSE, and
  // a buffered body turns incremental parsing into one delivery at the end --
  // visible to the user as "the first token arrives when the whole answer does".
  return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
    status: response.statusCode ?? 0,
    statusText: response.statusMessage ?? '',
    headers: response.headers as unknown as Headers,
  })
}

/** Issue the request over an already established tunnel. */
function dispatch(
  tunnel: net.Socket,
  target: URL,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers))
    const body = init.body
    if (typeof body === 'string') {
      // Explicit, like freeFetch: a hand-written content-length spares the proxy
      // from guessing, and chunked request bodies are what some proxies refuse to
      // tunnel.
      headers['content-length'] = String(Buffer.byteLength(body, 'utf8'))
    }
    const request = http.request({
      method: init.method ?? 'GET',
      path,
      headers,
      host: unbracket(target.hostname),
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
      agent: new TunnelAgent(tunnel),
    }, response => {
      resolve(toResponse(response))
    })
    request.on('error', reject)
    const abort = (): void => {
      request.destroy(new Error('The operation was aborted'))
    }
    init.signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => {
      init.signal?.removeEventListener('abort', abort)
    })
    if (typeof body === 'string') request.write(body, 'utf8')
    request.end()
  })
}

/** One attempt: reach the proxy, build a path to the target, issue the request. */
async function attemptOnce(
  endpoint: ProxyEndpoint,
  target: URL,
  init: RequestInit,
  options: SendViaProxiesOptions,
): Promise<Response> {
  const body = init.body
  if (body !== undefined && body !== null && typeof body !== 'string') {
    // Refusing loudly beats sending an empty body: a dropped body would look
    // like a successful call carrying a nonsense payload.
    throw new Error('the proxy lane carries string request bodies only')
  }
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  let raw: net.Socket | undefined
  let timedOut = false
  // One budget for reaching the proxy AND finishing its handshake, independent
  // of the caller's signal on purpose: "this proxy is dead, move on" has to
  // happen even when the caller is patient, otherwise a dead entry costs the
  // full upstream timeout on every request.
  const timer = setTimeout(() => {
    timedOut = true
    raw?.destroy(new ProxyTimeoutError('proxy connect timeout'))
  }, timeoutMs)
  try {
    raw = await dialProxy(endpoint, socket => {
      if (timedOut) socket.destroy(new ProxyTimeoutError('proxy connect timeout'))
    })
    const targetHost = unbracket(target.hostname)
    const targetPort = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
    let carrier: net.Socket
    let path: string
    if (endpoint.protocol === 'socks5:' || endpoint.protocol === 'socks5h:') {
      carrier = await openSocksTunnel(raw, endpoint, targetHost, targetPort)
      path = target.pathname + target.search
    } else if (target.protocol === 'https:') {
      carrier = await openHttpTunnel(raw, endpoint, targetHost, targetPort)
      path = target.pathname + target.search
    } else {
      // Absolute-form: the request line carries the whole URL and the proxy
      // resolves it. No tunnel, so the socket is already the carrier.
      carrier = raw
      path = target.href
    }
    // TLS finishes BEFORE http.request sees the socket: the request line is
    // written in plaintext by node:http, so it must land inside the encrypted
    // stream. That is why the carrier is a TLSSocket but the caller is http.
    const secured = target.protocol === 'https:' && path !== target.href
      ? await upgradeTunnelTls(carrier, target, options.tlsOptions)
      : carrier
    // The budget also covers waiting for the response head: a proxy that accepts
    // the connection and then says nothing is just as dead as one that refuses,
    // and on the absolute-form path there is no handshake to catch it. It stops
    // here -- once the head is in, the body may legitimately stream for minutes.
    return await dispatch(secured, target, path, init)
  } catch (error) {
    raw?.destroy()
    if (timedOut) throw new ProxyTimeoutError('proxy connect timeout')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Send one request through the first proxy that works.
 *
 * The chain is tried in order, and only a failure BEFORE the response head
 * moves to the next entry. Replay is restricted to string bodies: a stream has
 * already been consumed by the first attempt, so retrying it would send a
 * truncated body and still look like a successful call.
 */
export async function sendViaProxies(
  chain: readonly string[],
  url: string,
  init: RequestInit,
  options: SendViaProxiesOptions = {},
): Promise<Response> {
  const target = new URL(url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ProxyChainError([
      { proxy: redactProxy(url), reason: 'connect', message: 'unsupported target protocol ' + target.protocol },
    ])
  }
  const body = init.body
  const replayable = body === undefined || body === null || typeof body === 'string'
  const candidates = replayable ? chain : chain.slice(0, 1)
  const failures: ProxyAttemptFailure[] = []
  for (const proxy of candidates) {
    // Checked between attempts too: the caller gave up, so spending another
    // connect timeout on a proxy nobody is waiting for is pure waste.
    if (isAborted(init.signal)) break
    const endpoint = parseProxyUrl(proxy)
    if (endpoint === undefined) {
      failures.push({ proxy: redactProxy(proxy), reason: 'connect', message: 'unparseable proxy url' })
      continue
    }
    if (options.breaker?.shouldSkip(proxy) === true) {
      // Recorded so the chain error still explains every entry, but no socket is
      // opened, so this consumes none of the connect budget.
      failures.push({ proxy: redactProxy(proxy), reason: 'connect', message: 'circuit open' })
      continue
    }
    try {
      const response = await attemptOnce(endpoint, target, init, options)
      options.breaker?.noteSuccess(proxy)
      return response
    } catch (error) {
      if (isAborted(init.signal)) break
      const reason = failureReason(error)
      const message = messageOf(error)
      failures.push({ proxy: redactProxy(proxy), reason, message })
      options.breaker?.noteFailure(proxy)
      options.logger?.warn?.('proxy ' + redactProxy(proxy) + ' failed (' + reason + '): ' + message)
    }
  }
  throw new ProxyChainError(failures)
}
