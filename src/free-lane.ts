/**
 * Assembly for the免密 free lane.
 *
 * It is exposed to the shim as an `ExtraLaneSource` — a roster plus one `run` —
 * so the shim stays ignorant of sessions, wires and tool bookkeeping. That
 * boundary is the whole point of the design: the shim speaks exactly one wire
 * downstream, and everything that differs per lane lives here.
 *
 * The sealed co-paid lane that sat beside this one was removed on the user's
 * instruction; the credential-free lane is the one that stays.
 *
 * Every turn gets a session identity derived from the CONVERSATION, not from the
 * request. Free-tier quota is accounted per session, so minting a fresh id per
 * request exhausts it; a digest of the conversation keeps the same turn billed
 * to the same session across restarts, which is how the real client behaves.
 *
 * @module src/free-lane
 */

import crypto from 'node:crypto'
import type { ExtraLaneSource } from './shim.ts'
import { AggregateError } from './aggregate.ts'
import {
  applyFingerprint,
  postFreeStreamed,
  requestIdFor,
  sessionForConversation,
  wireFor,
} from './free-upstream.ts'
import { requestBodyFor } from './free-messages.ts'
import { StreamTracker, parseUsage, type UsageRecorder } from './stats.ts'
import type { FreeCatalog } from './free-catalog.ts'
import type { ShimLogger } from './shim.ts'

/** Upstream turns one free request may cost: the first, plus one retry. */
const FREE_TURN_ATTEMPTS = 2
/**
 * Pause before the retry.
 *
 * Short on purpose: the request is holding a user turn open, and the failure this
 * retries — the gateway aborting one generation mid-stream — is not a rate limit
 * that improves with waiting.
 */
const FREE_RETRY_DELAY_MS = 600

/**
 * True when asking again could plausibly produce an answer.
 *
 * Only a stream that was ACCEPTED and then died qualifies, which
 * `AggregateError` records as a `server` failure carrying the 200 it came from.
 * A refused request, a dead transport or a timeout (status 0) would fail the same
 * way a second time and only double how long the user waits.
 */
function isRetriedTurn(error: unknown): boolean {
  return error instanceof AggregateError && error.kind === 'server' && error.status === 200
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The conversation identity one request belongs to.
 *
 * The first user turn's text, hashed. Reading it from the body rather than from a
 * header is what makes this work for a caller that knows nothing about this
 * lane: pi-ai sends an ordinary chat body and the identity is simply a fact about
 * the conversation in it.
 */
function conversationKeyOf(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const raw of messages) {
    if (!isRecord(raw) || text(raw.role) !== 'user') continue
    const content = typeof raw.content === 'string'
      ? raw.content
      : JSON.stringify(raw.content ?? '')
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32)
  }
  return crypto.createHash('sha256').update('xdpool-free-conversation', 'utf8').digest('hex').slice(0, 32)
}

/** The envelope one chat chunk carries, so frames from different lanes match. */
function chatChunk(model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return JSON.stringify({
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
}

/**
 * The pooled免密 lane.
 *
 * `logger` is optional so the offline suite can build a source with no shim
 * around it; the dropped-image warning is the only thing it says.
 */
export function createFreeLaneSource(
  catalog: FreeCatalog,
  logger?: ShimLogger,
  usageRecorder?: UsageRecorder,
): ExtraLaneSource {
  return {
    current: () => catalog.current(),
    async run({ modelId, body, signal, onFrame }) {
      const caller = parseBody(body)
      const session = sessionForConversation(conversationKeyOf(caller))
      const requestId = requestIdFor(session, String(caller.user ?? ''))
      const wire = wireFor(modelId)
      const warnings: string[] = []
      const payload = requestBodyFor(wire, caller, { modelId, warnings })
      // The fingerprint gate is the free tier's own requirement and applies to
      // THIS lane only — renaming a tool on the aggregate or co-paid lanes would
      // hand the caller back a name it cannot run. The plan it returns is what
      // makes a promoted tool callable again on the way out.
      const plan = applyFingerprint(payload, wire)
      if (warnings.length > 0) {
        logger?.warn?.(`free lane: ${warnings.length} image block(s) could not be forwarded; they were dropped`)
      }
      // Time the turn so the dashboard shows real first-token and decode numbers
      // even when the gateway stays silent on token counts. One fresh turn id per
      // call: the free lane has no account rotation, so a turn is exactly one
      // upstream call — except for the retry below, which is another physical
      // call for the SAME user request and must not read as a second turn.
      const startedAt = Date.now()
      const tracker = new StreamTracker(startedAt)
      const turnId = `free-${crypto.randomBytes(8).toString('hex')}`
      let ok = false
      let recordedUsage: ReturnType<typeof parseUsage> = undefined
      try {
        for (let attempt = 1; ; attempt += 1) {
          // Frames are held per attempt rather than handed to the caller as they
          // arrive, because the lane's only recovery is a whole new upstream turn
          // and a half answer from the abandoned one must never be stitched in
          // front of the answer that replaces it. Holding them also keeps
          // `onFrame` silent until the turn is real: `serveExtraCompletion` only
          // writes headers after `run` resolves, so a turn that is going to be
          // retried can still come back as a status code instead of a 200 that
          // ends in nothing.
          const frames: string[] = [chatChunk(modelId, { role: 'assistant', content: '' }, null)]
          try {
            const result = await postFreeStreamed({
              modelId,
              body: payload,
              session,
              requestId,
              plan,
              signal,
              hooks: {
                onDelta: delta => {
                  tracker.markFirstByte(Date.now())
                  frames.push(chatChunk(modelId, delta, null))
                },
              },
            })
            recordedUsage = result.usage === undefined ? undefined : parseUsage(result.usage)
            if (result.suppressedOnly === true) {
              // A turn whose only answer was a decoy call has nothing for the caller
              // to run. The status line is already spent, so the only honest place
              // left for the explanation is the stream itself.
              frames.push(JSON.stringify({
                error: { message: 'the model asked for a tool this session cannot run', type: 'server_error' },
              }))
            }
            // `result.finishReason` is already a token the host decodes (see
            // `finish-token`), so the terminal frame can never end the user's run
            // with `Provider finish_reason: <invented token>`.
            frames.push(chatChunk(modelId, {}, result.finishReason ?? (result.truncated === true ? 'length' : 'stop')))
            ok = true
            for (const frame of frames) onFrame(frame)
            return result
          } catch (error: unknown) {
            // A 200 that died mid-stream is the one failure a fresh call can
            // plausibly fix — the gateway aborted one generation, not the model.
            // Anything else (refused request, dead transport, timeout) would only
            // spend the user's wait twice.
            if (attempt >= FREE_TURN_ATTEMPTS || !isRetriedTurn(error) || signal.aborted) throw error
            const detail = error instanceof Error ? error.message : String(error)
            logger?.warn(
              `free lane: ${detail} — retrying the turn (attempt ${attempt + 1}/${FREE_TURN_ATTEMPTS})`,
            )
            await new Promise(resolve => setTimeout(resolve, FREE_RETRY_DELAY_MS))
          }
        }
      } finally {
        // Filed exactly once, whether the turn succeeded or threw: a broken stream
        // is a failed call from the user's side of the wire, and the panel must
        // count it rather than pretend nothing happened.
        tracker.finish(Date.now())
        usageRecorder?.record({
          region: 'free',
          model: modelId,
          account: 'free',
          turnId,
          at: Date.now(),
          ok,
          ...(tracker.ttftMs === undefined ? {} : { ttftMs: tracker.ttftMs }),
          ...(tracker.decodeMs === undefined ? {} : { decodeMs: tracker.decodeMs }),
          ...(recordedUsage === undefined ? {} : { usage: recordedUsage }),
        })
      }
    },
  }
}

/** Parse the caller's body, or refuse with something the caller can act on. */
function parseBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    // Fall through to the shared refusal below.
  }
  throw new Error('the request body was not a JSON object')
}
