/**
 * The transport is the part that can silently do the wrong thing, so these
 * cases run real servers rather than stubs: a fake HTTP proxy, a fake SOCKS5
 * proxy, and real HTTP/HTTPS targets. What each case pins down is a failure
 * mode that would otherwise look like success -- a request that goes direct
 * while reporting 200, a retry that spends a second upstream attempt, a body
 * that arrives in one piece because something buffered it.
 */

import http from 'node:http'
import net from 'node:net'
import https from 'node:https'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProxyBreaker,
  ProxyChainError,
  maskProxy,
  parseProxyUrl,
  redactProxy,
  resolveMaskedProxy,
  sendViaProxies,
} from '../src/proxy-fetch.ts'

const CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUTQrvsHgbsuAQWVGHo9ADbyMSiW8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyMDAyMTAyN1oYDzIxMjYw
OTI2MDIxMDI3WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCNuiUFL0TRHwIDC/Xs8/Tn88zb71SHPqiGQka9Hz43
XeMNgG88/b01vg+x9+W71+ESYctHf4Oj723pQ/BzBeNCYjEGlC1GUANcbM1lEvqK
Z3QJ3v074AE5FqPAJUoHGGKkZcHvZ+Ef9RauAaFANNAqro+w12PNgUUxojUzIqB9
0ABjSRRIzDdNrNqoJrIxfIuIaROejtkjVdgOOjE4Sx32wJ3oO36NrNqHWQgfphyl
1Vy1NTSspVgnagNSCfDN9EIcO3aNsKUKL7HKUxAsP32tNg2LPyBvV8Vywk4aTwjF
CQgqRzT4WGEb/qnpdBYmg0P1TlOi4ejaHt6+z56ab8ofAgMBAAGjbzBtMB0GA1Ud
DgQWBBSqWhdf8oxIRiqtawdKzWjB2pJ18TAfBgNVHSMEGDAWgBSqWhdf8oxIRiqt
awdKzWjB2pJ18TAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAcyKxdusuqYVtWv+9qwL5K1KiOa0R
RbM/KxiO7qIitjFVM78rFxo9WAYSf2mWXoKLpVJo+de4fQDcqVXXSmgDHgN3IsBZ
JoZTEAaBvNokB79fMuDgm69WK1W8vakLecwfmdTBV5spyVXlbV8FzHkErxV5CUbf
BI3cqlKjf4NwCTacay3Wbp3CIciCGZENmgAsfyUL/ZQWp0fU7+RZtoAU+wP5p60x
78Fe8eXyc3eSR0GgqJkrSBtKIlovW7IY4vZ7mw3KjhOCdx1cvTM1BHdkZgnPA7zK
Kjywk2sDWE4GmpPfXpwwi+n/4IwRVaUIGvsl7KFKg2yzH8mrME9YVmLDJg==
-----END CERTIFICATE-----`
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCNuiUFL0TRHwID
C/Xs8/Tn88zb71SHPqiGQka9Hz43XeMNgG88/b01vg+x9+W71+ESYctHf4Oj723p
Q/BzBeNCYjEGlC1GUANcbM1lEvqKZ3QJ3v074AE5FqPAJUoHGGKkZcHvZ+Ef9Rau
AaFANNAqro+w12PNgUUxojUzIqB90ABjSRRIzDdNrNqoJrIxfIuIaROejtkjVdgO
OjE4Sx32wJ3oO36NrNqHWQgfphyl1Vy1NTSspVgnagNSCfDN9EIcO3aNsKUKL7HK
UxAsP32tNg2LPyBvV8Vywk4aTwjFCQgqRzT4WGEb/qnpdBYmg0P1TlOi4ejaHt6+
z56ab8ofAgMBAAECggEACGCH/wvBgkGjCxtCLX/PKlJBE4AZdUCd+G8v1c592grw
HteurrwdJ3FbZYl0234FA5YJMtAvYtmGAlAt0baq4KODwoZJ1Zdo8D+A6Ntoa+IP
VbGhZgOCPv9LrYTmuijV7i6sYGJTYa6vnDH93hj6puzLeUhThPQCBLWFD63/yEyt
4m6bYJpS/UXLwlAbB4kKo9dv3c8xK1rAt4GHDas8K5KtRLVc26Znxjnol/XIwGjL
2ImARtceNdfAEm82V5z1XCsTQyOVHCiMsc364woYMR33TICCbWU8DQhq6arm4k74
gwPu6wsZNOW2JmSksdL3u66i58ntiZoVFBcyrzsN8QKBgQDBWhaFX/zzXGw//Rm6
VokzvAUQUOaYeInnrCgHT999E5WDzPfdUMfbqv0iMwAq6YkETIW3+0d4VnKGw0Qi
I8+ACiNhun5zgx3o+cX/eQKk1MpzvmmB8vTXqgt/1kayMbgPYMj0gAqbFNZNoBUj
gNR7zxs185ilPO2tOymYjRdx7wKBgQC7pfL2X8P8I7DRON5QllCZefm5o9taLG5K
GTbMWWV5JG62aLqboFMI7ihBttrpd/EMr0GhWTAFHkH6flaE0wSl+bgOLPwvJwPg
VNGQjNexVNaAZgXY4ujDuNXlgLgQ3dT/m699pd6WBCmoxmhHs/JdannQ+epqLiU4
RSUyJl6a0QKBgHyBH0lpQwAOfqJBv8RuntDSfMxB3AtIazzkba4vr7Dh4IBLhzxb
HScFlxTjlHMNiK5c/Co5w47o07yVlpUJTD+dx6TRq0WEo8j2tZnJeXtcjrUzYstM
AH+zPs5l04ZBX81/PEe8/5dXNpwrvhDrj2feOB5oqt2UO1Q2aZWTHQq/AoGATWM/
NESCezXs8hxV8z5Kt0EKsHjXOfUg9wY3B0fHBZL05d2DODOCiyhNCezzk12X1/df
Rb+WgkXcSAZagCTWweye75m112xruNTCKK8tNUEbxZBN0QijnjRYYnIXdz1FXrVC
RrtldND6rVRGJWwdBFGpM3oeJvQo/W/myyvv0EECgYEAmQiWPCPvLjx1q2020xSr
CG/B2uziy1pL/xAx46kUeli++PCLzHg17ar7Sxa+XmlTJq6+ni3N/euIIbWbYXXD
MLfc99FqTjL4t6aydb35yH07asHoVGZlenysO+42CiPPRqdxfyzi8t4iHxIyMFgC
TV67dz9ft0scBpX6qiSqP/o=
-----END PRIVATE KEY-----`

const sockets: Socket[] = []
const servers: (http.Server | https.Server | net.Server)[] = []

function track<T extends net.Server>(server: T): T {
  server.on('connection', socket => {
    sockets.push(socket)
    socket.on('error', () => {})
  })
  servers.push(server)
  return server
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

/** A target that answers every request with a fixed body. */
async function startTarget(body: string): Promise<{ port: number; hits: () => number }> {
  let hits = 0
  const server = track(http.createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(body)
  }))
  const port = await listen(server)
  return { port, hits: () => hits }
}

/**
 * A forward proxy in both of its modes: absolute-form for plain http, CONNECT
 * for anything tunnelled.
 */
async function startHttpProxy(): Promise<{ port: number; connects: () => number }> {
  let connects = 0
  const server = track(http.createServer((request, response) => {
    const target = new URL(request.url ?? '/')
    const upstream = http.request({
      host: target.hostname,
      port: target.port === '' ? 80 : Number(target.port),
      path: target.pathname + target.search,
      method: request.method,
      headers: request.headers,
    }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(response)
    })
    upstream.on('error', () => {
      response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  }))
  server.on('connect', (request: http.IncomingMessage, client: Socket, head: Buffer) => {
    connects += 1
    const [host, port] = (request.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
  })
  const port = await listen(server)
  return { port, connects: () => connects }
}

/** A CONNECT proxy that refuses every tunnel, for the 'tunnel' failure reason. */
async function startRefusingProxy(status: number): Promise<number> {
  const server = track(http.createServer((_request, response) => {
    response.writeHead(500)
    response.end()
  }))
  server.on('connect', (_request: http.IncomingMessage, client: Socket) => {
    client.end('HTTP/1.1 ' + status + ' Nope\r\n\r\n')
  })
  return listen(server)
}

/**
 * A SOCKS5 server that answers the handshake by hand. It accepts both IPv4 and
 * domain destinations so the domain path can be exercised.
 */
async function startSocksProxy(): Promise<{ port: number; domains: () => string[] }> {
  const domains: string[] = []
  const server = track(net.createServer(socket => {
    let stage: 'greeting' | 'request' | 'done' = 'greeting'
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length < 2) return
        // [0x05, nmethods, ...methods] -- we only ever offer no-auth.
        const count = buffer[1] ?? 0
        if (buffer.length < 2 + count) return
        buffer = buffer.subarray(2 + count)
        socket.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
      }
      if (stage !== 'request') return
      if (buffer.length < 5) return
      const atyp = buffer[3]
      let host: string
      let offset: number
      if (atyp === 0x01) {
        if (buffer.length < 10) return
        host = [buffer[4], buffer[5], buffer[6], buffer[7]].join('.')
        offset = 8
      } else if (atyp === 0x03) {
        const length = buffer[4] ?? 0
        if (buffer.length < 5 + length + 2) return
        host = buffer.subarray(5, 5 + length).toString('utf8')
        domains.push(host)
        offset = 5 + length
      } else {
        socket.destroy()
        return
      }
      const port = ((buffer[offset] ?? 0) << 8) | (buffer[offset + 1] ?? 0)
      buffer = buffer.subarray(offset + 2)
      stage = 'done'
      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        if (buffer.length > 0) upstream.write(buffer)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => {
        socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      })
    })
  }))
  const port = await listen(server)
  return { port, domains: () => domains }
}

describe('proxy url handling', () => {
  it('parses every supported scheme and fills the default port', () => {
    expect(parseProxyUrl('http://1.2.3.4')).toMatchObject({ protocol: 'http:', host: '1.2.3.4', port: 8080 })
    expect(parseProxyUrl('https://1.2.3.4')).toMatchObject({ protocol: 'https:', port: 8080 })
    expect(parseProxyUrl('socks5://1.2.3.4')).toMatchObject({ protocol: 'socks5:', port: 1080 })
    expect(parseProxyUrl('socks5h://1.2.3.4:9999')).toMatchObject({ protocol: 'socks5h:', port: 9999 })
  })

  it('decodes credentials and rejects anything unusable', () => {
    expect(parseProxyUrl('http://us%40er:p%3Aw@1.2.3.4:8080')?.auth).toEqual({ username: 'us@er', password: 'p:w' })
    expect(parseProxyUrl('ftp://1.2.3.4:21')).toBeUndefined()
    expect(parseProxyUrl('http://')).toBeUndefined()
    expect(parseProxyUrl('')).toBeUndefined()
    expect(parseProxyUrl('nonsense')).toBeUndefined()
  })

  it('never leaks a password into logs', () => {
    expect(redactProxy('http://user:secret@1.2.3.4:8080')).toBe('http://user:***@1.2.3.4:8080')
    expect(redactProxy('not a url')).toBe('not a url')
  })

  it('round-trips a masked password back to the stored one', () => {
    const real = 'http://user:secret@1.2.3.4:8080'
    const masked = maskProxy(real)
    expect(masked).toBe('http://user:****@1.2.3.4:8080')
    expect(resolveMaskedProxy(masked, [real])).toBe(real)
    // A password the user actually typed passes through untouched.
    expect(resolveMaskedProxy('http://user:fresh@1.2.3.4:8080', [real])).toBe('http://user:fresh@1.2.3.4:8080')
    // The mask with nothing to recover from is not a usable proxy.
    expect(resolveMaskedProxy(masked, [])).toBeUndefined()
    // A different port is a different proxy, not the same one masked.
    expect(resolveMaskedProxy('http://user:****@1.2.3.4:9090', [real])).toBeUndefined()
  })
})

describe('transport', () => {
  it('sends a plain http request in absolute form through an http proxy', async () => {
    const target = await startTarget('direct-body')
    const proxy = await startHttpProxy()
    const response = await sendViaProxies(['http://127.0.0.1:' + proxy.port], 'http://127.0.0.1:' + target.port + '/x', {})
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('direct-body')
    // No tunnel on this path: the proxy is expected to forward the request line.
    expect(proxy.connects()).toBe(0)
  })

  it('tunnels https through CONNECT and validates the certificate', async () => {
    const server = track(https.createServer({ cert: CERT, key: KEY }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('secure-body')
    }))
    const targetPort = await listen(server)
    const proxy = await startHttpProxy()
    const response = await sendViaProxies(
      ['http://127.0.0.1:' + proxy.port],
      'https://localhost:' + targetPort + '/x',
      {},
      // Trusting this one CA is the assertion that the certificate really was
      // checked; disabling verification would make the test pass on anything.
      { tlsOptions: { ca: CERT } },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('secure-body')
    expect(proxy.connects()).toBe(1)
  })

  it('reports a tls failure when the certificate is not trusted', async () => {
    const server = track(https.createServer({ cert: CERT, key: KEY }, (_request, response) => {
      response.end('secure-body')
    }))
    const targetPort = await listen(server)
    const proxy = await startHttpProxy()
    const error = await sendViaProxies(
      ['http://127.0.0.1:' + proxy.port],
      'https://localhost:' + targetPort + '/x',
      {},
    ).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ProxyChainError)
    expect((error as ProxyChainError).failures[0]?.reason).toBe('tls')
  })

  it('reaches an http target through a SOCKS5 proxy, leaving the name to the proxy', async () => {
    const target = await startTarget('socks-body')
    const socks = await startSocksProxy()
    const response = await sendViaProxies(
      ['socks5://127.0.0.1:' + socks.port],
      'http://localhost:' + target.port + '/x',
      {},
    )
    expect(await response.text()).toBe('socks-body')
    // ATYP 0x03 for a name, not a locally resolved address: local resolution
    // would leak the destination into this machine's DNS.
    expect(socks.domains()).toEqual(['localhost'])
  })

  it('streams the body instead of buffering it', async () => {
    const server = track(http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('first-chunk\n')
      setTimeout(() => response.end('second-chunk\n'), 60)
    }))
    const targetPort = await listen(server)
    const proxy = await startHttpProxy()
    const response = await sendViaProxies(['http://127.0.0.1:' + proxy.port], 'http://127.0.0.1:' + targetPort + '/s', {})
    const body = response.body
    if (body === null) throw new Error('expected a streaming body')
    const reader = body.getReader()
    const first = await reader.read()
    // The second chunk is still 60ms away; seeing the first one here is the
    // whole point -- a buffered transport would have waited for the end.
    expect(new TextDecoder().decode(first.value)).toBe('first-chunk\n')
    await reader.cancel()
  })

  it('falls back to the next proxy when the first one refuses', async () => {
    const target = await startTarget('fallback-body')
    const proxy = await startHttpProxy()
    const deadPort = await (async () => {
      const probe = track(net.createServer())
      const port = await listen(probe)
      await new Promise<void>(resolve => probe.close(() => resolve()))
      servers.pop()
      return port
    })()
    const response = await sendViaProxies(
      ['http://127.0.0.1:' + deadPort, 'http://127.0.0.1:' + proxy.port],
      'http://127.0.0.1:' + target.port + '/x',
      {},
    )
    expect(await response.text()).toBe('fallback-body')
  })

  it('throws with one failure per proxy when the whole chain is dead', async () => {
    const proxy = await startRefusingProxy(502)
    const chain = ['http://127.0.0.1:' + proxy, 'http://127.0.0.1:' + proxy]
    const error = await sendViaProxies(chain, 'https://localhost:1/x', {}).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ProxyChainError)
    expect((error as ProxyChainError).failures).toHaveLength(chain.length)
    expect((error as ProxyChainError).failures[0]?.reason).toBe('tunnel')
  })

  it('does not retry once the response head has arrived', async () => {
    let hits = 0
    const server = track(http.createServer((_request, response) => {
      hits += 1
      response.writeHead(500)
      response.end('nope')
    }))
    const targetPort = await listen(server)
    const proxy = await startHttpProxy()
    const response = await sendViaProxies(
      ['http://127.0.0.1:' + proxy.port, 'http://127.0.0.1:' + proxy.port],
      'http://127.0.0.1:' + targetPort + '/x',
      {},
    )
    expect(response.status).toBe(500)
    // A retry would spend a second upstream attempt and hand the caller a
    // status it cannot attribute to an account.
    expect(hits).toBe(1)
  })

  it('gives up on a proxy that accepts and then says nothing', async () => {
    const silent = track(net.createServer(() => {}))
    const port = await listen(silent)
    const started = Date.now()
    const error = await sendViaProxies(
      ['http://127.0.0.1:' + port],
      'http://127.0.0.1:1/x',
      {},
      { connectTimeoutMs: 120 },
    ).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ProxyChainError)
    expect((error as ProxyChainError).failures[0]?.reason).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('stops before dialling anything when the caller already aborted', async () => {
    const proxy = await startHttpProxy()
    const controller = new AbortController()
    controller.abort()
    const error = await sendViaProxies(
      ['http://127.0.0.1:' + proxy.port],
      'http://127.0.0.1:1/x',
      { signal: controller.signal },
    ).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ProxyChainError)
    expect((error as ProxyChainError).failures).toHaveLength(0)
  })

  it('sends a string body with an explicit content-length', async () => {
    let seen = ''
    const server = track(http.createServer((request, response) => {
      request.on('data', (chunk: Buffer) => { seen += chunk.toString('utf8') })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(request.headers['content-length'] ?? 'none')
      })
    }))
    const targetPort = await listen(server)
    const proxy = await startHttpProxy()
    const response = await sendViaProxies(
      ['http://127.0.0.1:' + proxy.port],
      'http://127.0.0.1:' + targetPort + '/x',
      { method: 'POST', body: 'héllo' },
    )
    expect(await response.text()).toBe('6')
    expect(seen).toBe('héllo')
  })
})

describe('circuit breaker', () => {
  it('skips a proxy after consecutive failures and recovers on success', () => {
    const breaker = new ProxyBreaker({ failuresToOpen: 3, openMs: 60_000 })
    const proxy = 'http://127.0.0.1:1'
    expect(breaker.shouldSkip(proxy)).toBe(false)
    breaker.noteFailure(proxy)
    breaker.noteFailure(proxy)
    expect(breaker.shouldSkip(proxy)).toBe(false)
    breaker.noteFailure(proxy)
    // Open: the next request must not spend another connect timeout on it.
    expect(breaker.shouldSkip(proxy)).toBe(true)
    expect(breaker.shouldSkip(proxy, Date.now() + 61_000)).toBe(false)
  })

  it('forgets failures when a proxy works again', () => {
    const breaker = new ProxyBreaker({ failuresToOpen: 2 })
    breaker.noteFailure('http://a:1')
    breaker.noteSuccess('http://a:1')
    breaker.noteFailure('http://a:1')
    expect(breaker.shouldSkip('http://a:1')).toBe(false)
  })

  it('records an open circuit as a failure without dialling it', async () => {
    const proxy = await startHttpProxy()
    const url = 'http://127.0.0.1:' + proxy.port
    const breaker = new ProxyBreaker({ failuresToOpen: 1, openMs: 60_000 })
    breaker.noteFailure(url)
    const error = await sendViaProxies([url], 'http://127.0.0.1:1/x', {}, { breaker })
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(ProxyChainError)
    expect((error as ProxyChainError).failures[0]?.message).toBe('circuit open')
  })
})
