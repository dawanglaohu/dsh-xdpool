/**
 * What a lane does with a finish token the host cannot decode.
 *
 * The failure this pins is the one the user reported: a turn dies with
 * `本轮运行失败 Provider finish_reason: error` and the answer is gone. The token came
 * from an upstream that ended a 200 stream itself — "the generation died
 * mid-flight" in OpenAI-compatible spelling — and pi-ai decodes every token except
 * `stop|end|length|function_call|tool_calls` as `stopReason: "error"` and throws.
 * No status code is involved, so no failover, retry or panel entry ever saw it.
 *
 * Each lane can only do what its own buffering allows, and the tests are split the
 * same way:
 *
 * - The free and aggregate lanes hold the whole turn before answering, so an
 *   abnormal token means the attempt FAILED and can be retried or refused — the
 *   caller is never handed a half answer.
 * - The pool lane forwards live bytes, so an abnormal token AFTER text has reached
 *   the caller is rewritten to `stop` (the answer stands, the abort is logged),
 *   while one before any text turns the turn into a 502 — its headers are held
 *   back until the first frame, which is what makes that possible.
 */
import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from '../src/catalog.ts'
import type { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyUpstreamClient, WorkBuddyRegion } from '../src/upstream.ts'
import { createWorkBuddyShim, type ShimLogger } from '../src/shim.ts'
import { AggregateCatalog, AggregateError } from '../src/aggregate.ts'
import type { AggregateStore } from '../src/store.ts'
import { createFreeLaneSource } from '../src/free-lane.ts'
import { FreeCatalog } from '../src/free-catalog.ts'
import { freeLane } from '../src/free-upstream.ts'

const SLOW = 60_000

/** A logger that remembers what it was told, so the explanation can be asserted. */
function collectingLogger(): ShimLogger & { said: string[] } {
  const said: string[] = []
  return {
    said,
    info: () => {},
    warn: (...args: unknown[]) => {
      said.push(args.map(argument => String(argument instanceof Error ? argument.message : argument)).join(' '))
    },
    error: () => {},
  }
}

/** One frame a chat wire can carry, without inventing a `created` value. */
function chatFrame(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'scripted',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

/** The `delta` of every frame in one SSE body, in order. */
function deltasOf(body: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of body.split('\n')) {
    // Bare payloads and `data:` frames are both accepted: the free lane hands its
    // caller frame payloads, while the pool lane forwards whole `data:` frames.
    const line = raw.trim().replace(/^data:\s*/u, '')
    if (line === '' || line.includes('[DONE]')) continue
    try {
      const parsed = JSON.parse(line) as { choices?: { delta?: Record<string, unknown> }[] }
      const delta = parsed.choices?.[0]?.delta
      if (delta !== undefined) out.push(delta)
    } catch {
      // A body that does not parse is asserted on by the callers that care.
    }
  }
  return out
}

describe('the free lane', () => {
  /**
   * Serve scripted turn answers from loopback, one per request.
   *
   * The module reads its base URL once at import, so the transport's own seam is
   * what routes the request; the request itself still crosses a real socket.
   */
  async function withTurnGateway(turns: readonly string[], run: (count: () => number) => Promise<void>): Promise<void> {
    let requests = 0
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        requests += 1
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(turns[Math.min(requests - 1, turns.length - 1)] ?? '')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const previous = freeLane.fetch
    freeLane.fetch = {
      fetch: async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const target = new URL(url)
        return await fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, {
          method: init.method ?? 'GET',
          headers: init.headers ?? {},
          ...init.body === undefined ? {} : { body: init.body },
        })
      },
    }
    try {
      await run(() => requests)
    } finally {
      freeLane.fetch = previous
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  /** The body of one turn whose gateway aborted, and the one that answers. */
  const ABORTED_TURN = [
    chatFrame({ content: 'half an ans' }, null),
    chatFrame({}, 'error'),
    'data: [DONE]\n\n',
  ].join('')
  const ANSWERED_TURN = [
    chatFrame({ content: 'the answer' }, null),
    chatFrame({}, 'stop'),
    'data: [DONE]\n\n',
  ].join('')

  function runTurn(source: ReturnType<typeof createFreeLaneSource>, frames: string[]): Promise<unknown> {
    return source.run({
      modelId: 'space-bunny-free',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      signal: new AbortController().signal,
      onFrame: frame => frames.push(frame),
    })
  }

  it('asks again and delivers only the answer, never the half turn it abandoned', async () => {
    // The gateway aborting one generation is not the model being broken, so a
    // second physical call is the cheapest possible recovery — and because the
    // lane holds its frames, the abandoned attempt cannot be stitched in front of
    // the answer that replaces it.
    const logger = collectingLogger()
    await withTurnGateway([ABORTED_TURN, ANSWERED_TURN], async count => {
      const frames: string[] = []
      const source = createFreeLaneSource(new FreeCatalog(), logger)
      await runTurn(source, frames)
      expect(count()).toBe(2)
      const body = frames.map(frame => `${frame}\n\n`).join('')
      expect(deltasOf(body).map(delta => delta.content).filter(Boolean)).toEqual(['the answer'])
      expect(body).toContain('"finish_reason":"stop"')
      expect(body).not.toContain('"finish_reason":"error"')
      // One role frame for the turn, not one per attempt.
      expect(body.split('"role":"assistant"')).toHaveLength(2)
      expect(logger.said.join('\n')).toContain('retrying the turn (attempt 2/2)')
      expect(logger.said.join('\n')).toContain('finish_reason "error"')
    })
  }, SLOW)

  it('gives up with the failure when the second call is aborted too', async () => {
    await withTurnGateway([ABORTED_TURN], async count => {
      const frames: string[] = []
      const source = createFreeLaneSource(new FreeCatalog(), collectingLogger())
      const failure = await runTurn(source, frames).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure).toMatchObject({ kind: 'server', status: 200 })
      expect((failure as Error).message).toContain('finish_reason "error"')
      // Exactly two calls: the retry is bounded, so a permanently broken upstream
      // costs one extra attempt rather than a loop.
      expect(count()).toBe(2)
      // Nothing was handed to the caller, which is what lets the shim answer with
      // a status code instead of a 200 that ends in nothing.
      expect(frames).toEqual([])
    })
  }, SLOW)
})

describe('the aggregate lane', () => {
  const PROVIDER_ID = 'agnes'
  const MODEL_ID = 'agnes-2.0-flash'
  const COMPOSITE_ID = `${PROVIDER_ID}/${MODEL_ID}`
  const ONE_MODEL: WorkBuddyModelInfo = {
    id: 'hy3',
    name: 'HY3',
    contextWindow: 192_000,
    maxOutputTokens: 8_192,
    supportsImages: false,
  }

  function poolCatalog(): WorkBuddyCatalog {
    return {
      visible: () => [ONE_MODEL],
      current: () => [ONE_MODEL],
      find: id => (id === ONE_MODEL.id ? ONE_MODEL : undefined),
      onChange: () => () => {},
    } as unknown as WorkBuddyCatalog
  }

  function poolWith(): WorkBuddyAccountPool {
    return {
      acquire: async () => undefined,
      unavailableReason: () => ({ total: 0, cooling: 0, disabled: 0, dead: 0, restricted: 0, reason: 'empty' }),
      noteServed: () => {},
    } as unknown as WorkBuddyAccountPool
  }

  /** A fake provider whose whole answer is `body`, written verbatim. */
  async function startProvider(body: string, contentType: string): Promise<Server> {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(body)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return server
  }

  function storeFor(port: number): AggregateStore {
    return {
      version: 1,
      enabled: true,
      providers: {
        [PROVIDER_ID]: { apiKey: 'sk-test-key', baseUrl: `http://127.0.0.1:${port}/v1`, enabled: true },
      },
    }
  }

  /** Ask the shim for the composite id and answer with the whole SSE body. */
  async function ask(upstreamBody: string, contentType: string): Promise<{ status: number; text: string }> {
    const upstream = await startProvider(upstreamBody, contentType)
    const store = storeFor((upstream.address() as { port: number }).port)
    const catalog = new AggregateCatalog(() => store)
    await catalog.refresh()
    const shim = createWorkBuddyShim({
      pool: poolWith(),
      client: { prepareChatBody: (raw: string) => raw } as unknown as WorkBuddyUpstreamClient,
      catalog: poolCatalog(),
      region: 'cn' as WorkBuddyRegion,
      aggregate: { catalog, readStore: () => store },
      logger: collectingLogger(),
    })
    await shim.ready
    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: COMPOSITE_ID, messages: [{ role: 'user', content: 'hi' }] }),
      })
      return { status: response.status, text: await response.text() }
    } finally {
      await shim.close()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  }

  it('refuses a stream the provider ended with an invented token, before forwarding it', async () => {
    // The lane buffers the turn, so it can tell the caller "this provider broke"
    // instead of forwarding a frame that makes the host throw on a 200.
    const answer = await ask(
      [
        chatFrame({ content: 'half an ans' }, null),
        chatFrame({}, 'error'),
        'data: [DONE]\n\n',
      ].join(''),
      'text/event-stream',
    )
    expect(answer.status).toBe(502)
    const parsed = JSON.parse(answer.text) as { error?: { message?: string; code?: string } }
    expect(parsed.error?.code).toBe('aggregate_server')
    expect(parsed.error?.message).toContain('finish_reason "error"')
  })

  it('delivers a JSON answer that carries an invented token as a finished answer', async () => {
    // A provider answering the whole answer in one JSON document has nothing left
    // to abort, so the answer is the answer: the token is translated and the text
    // reaches the caller.
    const answer = await ask(
      JSON.stringify({
        id: '1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'the whole answer' }, finish_reason: 'error' }],
      }),
      'application/json',
    )
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('the whole answer')
    expect(answer.text).toContain('"finish_reason":"stop"')
    expect(answer.text).not.toContain('"finish_reason":"error"')
  })
})

describe('the pool lane', () => {
  const ONE_MODEL: WorkBuddyModelInfo = {
    id: 'hy3',
    name: 'HY3',
    contextWindow: 192_000,
    maxOutputTokens: 8_192,
    supportsImages: false,
  }

  function poolCatalog(): WorkBuddyCatalog {
    return {
      visible: () => [ONE_MODEL],
      current: () => [ONE_MODEL],
      find: id => (id === ONE_MODEL.id ? ONE_MODEL : undefined),
      onChange: () => () => {},
    } as unknown as WorkBuddyCatalog
  }

  /** A pool with one always-available account, so the lane serves its stream. */
  function singleAccountPool(): WorkBuddyAccountPool {
    return {
      acquire: async () => ({ id: 'a1', label: 'acct-a', credential: { accessToken: 't' } }),
      unavailableReason: () => ({ total: 1, cooling: 0, disabled: 0, dead: 0, restricted: 0, reason: 'empty' }),
      noteServed: () => {},
      noteCredits: () => {},
    } as unknown as WorkBuddyAccountPool
  }

  /** Ask the shim for the pooled model, with the upstream answering `body`. */
  async function askUpstream(
    body: string,
  ): Promise<{ status: number; text: string; logger: ShimLogger & { said: string[] } }> {
    const logger = collectingLogger()
    const client = {
      prepareChatBody: (raw: string) => raw,
      // A successful stream result, as `WorkBuddyUpstreamClient.chatStream`
      // reports one: the raw `Response` alone would read as a failed call.
      chatStream: async () => ({
        ok: true as const,
        response: new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      }),
      fetchCredits: async () => ({ total: 100, nearestExpiryMs: undefined }),
    } as unknown as WorkBuddyUpstreamClient
    const shim = createWorkBuddyShim({
      pool: singleAccountPool(),
      client,
      catalog: poolCatalog(),
      region: 'cn' as WorkBuddyRegion,
      logger,
    })
    await shim.ready
    try {
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: ONE_MODEL.id, messages: [{ role: 'user', content: 'hi' }] }),
      })
      return { status: response.status, text: await response.text(), logger }
    } finally {
      await shim.close()
    }
  }

  it('keeps the answer when the upstream aborts after the text was already forwarded', async () => {
    // Dropping the turn at this point would throw away words the user can already
    // read, so the terminal token is rewritten and the abort is only logged.
    const answer = await askUpstream([
      chatFrame({ role: 'assistant', content: '' }, null),
      chatFrame({ content: 'the answer' }, null),
      chatFrame({}, 'error'),
      'data: [DONE]\n\n',
    ].join(''))
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('the answer')
    expect(answer.text).toContain('"finish_reason":"stop"')
    expect(answer.text).not.toContain('"finish_reason":"error"')
    expect(answer.text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(answer.logger.said.join('\n')).toContain('forwarding it as "stop"')
  })

  it('answers with a failed upstream call when the abort arrives before any text', async () => {
    // The headers are held back until the first frame precisely so this turn can
    // still refuse. A 200 that ends in nothing is the bug: the host reads it as an
    // empty answer, or — with this very token — as a thrown Provider failure.
    const answer = await askUpstream([
      chatFrame({ role: 'assistant', content: '' }, null),
      chatFrame({}, 'error'),
      'data: [DONE]\n\n',
    ].join(''))
    expect(answer.status).toBe(502)
    const parsed = JSON.parse(answer.text) as { error?: { message?: string; code?: string } }
    expect(parsed.error?.code).toBe('upstream_failed')
    expect(parsed.error?.message).toContain('finish_reason "error"')
    expect(parsed.error?.message).toContain('before sending any text')
    expect(answer.logger.said.join('\n')).toContain('before sending any text')
  })
})
