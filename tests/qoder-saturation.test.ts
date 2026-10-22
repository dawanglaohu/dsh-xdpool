/**
 * Qoder's encrypted inference answers a saturated model with HTTP 200 and an
 * SSE envelope carrying `10605 / isQueued / serviceAvailable:false` — a queue
 * notice, not an error. The adapter waits it out (`waitForQueue`) up to 180
 * rounds or 30 minutes, then reports "排队等待超时". In practice the queue
 * never drains for a model the account is not entitled to: measured over 25
 * back-to-back calls on `dfmodel`, one returned a token stream and 24 returned
 * the same 10605 envelope within ~500ms. So the user sat in a spinner for
 * minutes and then read a message that named neither the model nor the cause.
 *
 * The second shape is `{"code":"provider_error","message":"Error in upstream
 * response"}` — the model backend failing to produce a stream at all. It used
 * to be flattened into `qoder: Error in upstream response (provider_error/
 * model_error)` with code SERVER and no retry hint, which reads like a channel
 * block and tells nobody what to do.
 *
 * Both cases below pin the fix: saturation gives up early and names the model,
 * a transient backend failure carries a retry hint. The pack is a vendored
 * bundle with host-only imports, so the declarations are lifted out of its
 * source text and executed in a stubbed scope, like the header-deadline suite.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PACK = new URL('../vendor/channel-pack/pack.js', import.meta.url)
const source = readFileSync(PACK, 'utf8')

/** Slice one declaration out of the bundle; the end anchor is kept. */
function grab(startAnchor: string, endAnchor: string): string {
  const at = source.indexOf(startAnchor)
  if (at < 0) throw new Error(`pack.js no longer contains: ${startAnchor}`)
  const end = source.indexOf(endAnchor, at + startAnchor.length)
  if (end < 0) throw new Error(`pack.js declaration is unterminated: ${startAnchor}`)
  return source.slice(at, end + endAnchor.length)
}

const PROVIDER_ERROR_FN = grab('function isUpstreamProviderError(code, type, message) {', '\n}')
const ROUNDS_FN = grab('function resolveQueueSaturationRounds() {', '\n}')
const WAIT_FOR_QUEUE = grab('  async waitForQueue(queueInfo, attempts, deadline, options) {', '\n  }')

class LlmErrorStub extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'LlmError'
    this.code = code
  }
}

type IsProviderError = (code: unknown, type: unknown, message: unknown) => boolean
type Rounds = () => number
type WaitForQueue = (
  queueInfo: Record<string, unknown> | undefined,
  attempts: number,
  deadline: number,
  options: { signal?: AbortSignal },
) => Promise<void>

const helpers = new Function(
  `"use strict";
   ${PROVIDER_ERROR_FN}
   ${ROUNDS_FN}
   return { isUpstreamProviderError, resolveQueueSaturationRounds };`,
)() as { isUpstreamProviderError: IsProviderError; resolveQueueSaturationRounds: Rounds }

/**
 * `waitForQueue` as a real method, so `this.sleep` can be a no-op instead of a
 * 10-second wait per round.
 */
function makeQueue(delayMs = 500): { waitForQueue: WaitForQueue; sleeps: number[] } {
  const Adapter = new Function(
    'LlmError7',
    'QUEUE_MAX_ATTEMPTS',
    'qoderQueueDelayMs',
    'resolveQueueSaturationRounds',
    'isAborted',
    `"use strict";
     const sleeps = [];
     class Adapter {
       async sleep(ms) { sleeps.push(ms); }
       ${WAIT_FOR_QUEUE}
     }
     return { Adapter, sleeps };`,
  )(
    LlmErrorStub,
    180,
    () => delayMs,
    helpers.resolveQueueSaturationRounds,
    (signal?: AbortSignal) => signal?.aborted === true,
  ) as { Adapter: new () => { waitForQueue: WaitForQueue }; sleeps: number[] }
  const instance = new Adapter.Adapter()
  return { waitForQueue: instance.waitForQueue.bind(instance), sleeps: Adapter.sleeps }
}

const SATURATED = Object.freeze({
  isQueued: true,
  modelKey: 'dfmodel',
  queueCount: 0,
  queueType: 'p3',
  retryAfterSeconds: 30,
  serviceAvailable: false,
  waitTime: 30,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('telling a saturated model apart from a transient backend failure', () => {
  it('recognises the provider_error envelope', () => {
    expect(helpers.isUpstreamProviderError('provider_error', 'model_error', 'Error in upstream response')).toBe(true)
    // The code alone is enough — `type` is added by the envelope unwrapper, not
    // by the upstream, so it cannot be required.
    expect(helpers.isUpstreamProviderError('provider_error', undefined, 'anything')).toBe(true)
    // And the message alone, once the unwrapper has labelled the frame.
    expect(helpers.isUpstreamProviderError('403', 'model_error', 'Error in upstream response')).toBe(true)
  })

  it('does not swallow ordinary upstream errors', () => {
    // The 10605 queue envelope also arrives as `code:403, type:model_error`;
    // classifying it as a backend failure would bypass the queue handling that
    // is the whole point of the other branch.
    expect(helpers.isUpstreamProviderError('403', 'model_error', '{"code":"10605","isQueued":true}')).toBe(false)
    expect(helpers.isUpstreamProviderError('110', 'billing_error', 'billing daily count exceeded')).toBe(false)
    expect(helpers.isUpstreamProviderError(undefined, undefined, 'Error in upstream response')).toBe(false)
  })

  it('gives up on a saturated model after a bounded number of rounds', () => {
    expect(helpers.resolveQueueSaturationRounds()).toBe(6)
    vi.stubEnv('DSH_QODER_QUEUE_SATURATION_ROUNDS', '2')
    expect(helpers.resolveQueueSaturationRounds()).toBe(2)
    // A garbage value must not become 0, which would abort every queued model
    // on its first notice.
    vi.stubEnv('DSH_QODER_QUEUE_SATURATION_ROUNDS', 'nonsense')
    expect(helpers.resolveQueueSaturationRounds()).toBe(6)
  })

  it('stops waiting on serviceAvailable:false and names the model', async () => {
    const { waitForQueue } = makeQueue()
    const deadline = Date.now() + 30 * 60_000

    const failure = await waitForQueue(SATURATED, 7, deadline, {}).then(
      () => undefined,
      (error: unknown) => error as LlmErrorStub,
    )

    expect(failure).toBeInstanceOf(LlmErrorStub)
    // Not retryable: the host would otherwise replay the same six rounds five
    // times over, turning a 30-second answer into a ten-minute one.
    expect(failure?.code).toBe('MODEL_SATURATED')
    expect(failure?.message).toContain('dfmodel')
    expect(failure?.message).toContain('serviceAvailable=false')
    // The message has to rule out the three things a user actually suspects.
    expect(failure?.message).toContain('不是你的额度')
  })

  it('keeps waiting while the queue reports capacity', async () => {
    const { waitForQueue } = makeQueue()
    const deadline = Date.now() + 30 * 60_000
    // serviceAvailable:true means "wait, it will clear" — giving up here would
    // abandon exactly the case the queue handling exists for.
    await expect(
      waitForQueue({ ...SATURATED, serviceAvailable: true }, 7, deadline, {}),
    ).resolves.toBeUndefined()
    // An absent flag is likewise not proof of saturation.
    await expect(waitForQueue({ ...SATURATED, serviceAvailable: undefined }, 7, deadline, {})).resolves.toBeUndefined()
  })

  it('still reports a plain queue timeout as QUEUE', async () => {
    const { waitForQueue } = makeQueue()
    const failure = await waitForQueue(SATURATED, 1, Date.now() - 1, {}).then(
      () => undefined,
      (error: unknown) => error as LlmErrorStub,
    )
    expect(failure?.code).toBe('QUEUE')
  })

  it('wires both error shapes into the SSE consumer', () => {
    // The two branches are inline in a generator that needs the whole bundle
    // (ToolCallId, block assembly) to run, so the wiring is asserted on source:
    // a regression that drops either call site would silently restore the
    // generic `(provider_error/model_error)` message.
    expect(source.split('isUpstreamProviderError(data.code, data.type, data.message)').length - 1).toBe(2)
    expect(source).toContain('providerRetryAfterMs: 2e3')
  })
})

