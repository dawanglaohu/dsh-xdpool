/**
 * The finish tokens the host understands, and what to do with the ones an
 * upstream invents.
 *
 * Every turn this plugin serves ends with a finish token, and the host is strict
 * about it: pi-ai's `mapStopReason` reads `stop|end` as a normal stop, `length` as
 * truncation, `function_call|tool_calls` as a tool turn, and `content_filter` /
 * `network_error` as their own failures — everything else becomes
 * `stopReason: "error"` with the message `Provider finish_reason: <token>`, which
 * the host then THROWS. So an OpenAI-compatible gateway that ends a stream with
 * `finish_reason: "error"` (its way of saying "the generation died mid-flight")
 * does not look like a broken upstream call to the host. It looks like a
 * successfully finished turn that failed, and it kills the user's whole run with
 * `本轮运行失败 Provider finish_reason: error` — no failover, no retry, no partial
 * answer, because by then the response is a 200 that already ended.
 *
 * The rule therefore lives here, once, instead of being re-derived at each lane's
 * last hop:
 *
 * - A token the host knows is passed through untouched; the lane's own meaning is
 *   preserved.
 * - An invented token (or a missing one) becomes `stop` on the wire.
 *
 * This module only translates. Whether an answer that arrived with an abnormal
 * token should be KEPT or the attempt treated as failed belongs to the lane that
 * knows whether text already reached the caller: the free and aggregate lanes
 * buffer the whole turn and can refuse cleanly, while the pool lane streams live
 * and can only rewrite what it already forwarded (see `free-lane`, `aggregate`
 * and `shim`).
 *
 * @module src/finish-token
 */

/**
 * The tokens the host decodes without inventing a failure.
 *
 * `end` is listed because some OpenAI-compatible gateways spell the normal stop
 * that way; the host maps it to `stop`.
 */
export const HOST_FINISH_TOKENS = ['stop', 'end', 'length', 'function_call', 'tool_calls'] as const

/** One finish token the host can decode. */
export type HostFinishToken = typeof HOST_FINISH_TOKENS[number]

/** True when the host decodes this token as a terminal reason it understands. */
export function isHostFinishToken(token: string): token is HostFinishToken {
  return (HOST_FINISH_TOKENS as readonly string[]).includes(token)
}

/**
 * The token to put on the wire in place of `token`.
 *
 * Unknown and empty tokens become `stop`: it is the only terminal token that
 * reads as "this answer is complete" in every wire this plugin speaks, and the
 * alternative is a host-side abort that discards the answer entirely.
 */
export function hostFinishToken(token: string | undefined): HostFinishToken {
  if (token === undefined) return 'stop'
  return isHostFinishToken(token) ? token : 'stop'
}

/**
 * The finish token one SSE frame carries, or undefined when it carries none.
 *
 * Accepts both shapes seen in this plugin: a bare JSON payload (what the
 * aggregate and free lanes hand to their callers) and a full `data: {...}` frame
 * (what the pool lane forwards before it inspects anything). `null` — the token
 * every non-terminal chunk carries — is "no token yet", not a token.
 *
 * A frame that mentions `finish_reason` without a parseable payload falls back to
 * reading the quoted string, so a frame the gateway wrote slightly differently is
 * still classified instead of passing through as complete.
 */
export function finishTokenInFrame(frame: string): string | undefined {
  if (!frame.includes('finish_reason')) return undefined
  const payload = payloadOf(frame)
  try {
    const parsed = JSON.parse(payload) as unknown
    const choices = isRecord(parsed) && Array.isArray(parsed.choices) ? parsed.choices : []
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const raw = choice.finish_reason
      if (typeof raw === 'string' && raw !== '') return raw
    }
    return undefined
  } catch {
    const quoted = QUOTED_FINISH.exec(payload)
    return quoted === null || quoted[1] === '' ? undefined : quoted[1]
  }
}

/**
 * The same frame with an invented finish token replaced by `stop`.
 *
 * Only the token is touched: the rest of the frame is returned byte-for-byte, so
 * the pool lane can keep its promise of forwarding what the upstream wrote. The
 * input is returned unchanged (same string) when nothing needs rewriting.
 */
export function hostFinishFrame(frame: string): string {
  const token = finishTokenInFrame(frame)
  if (token === undefined || isHostFinishToken(token)) return frame
  return frame.replace(new RegExp(`("finish_reason"\\s*:\\s*)"${escapeRegExp(token)}"`, 'g'), '$1"stop"')
}

/** The JSON body of a frame: the `data:` prefix and surrounding space gone. */
function payloadOf(frame: string): string {
  const trimmed = frame.trim()
  if (!trimmed.startsWith('data:')) return trimmed
  // SSE may split one payload over several `data:` lines; the lanes here write a
  // single line, and a multi-line frame still classifies through the quoted
  // fallback when the join is not valid JSON.
  return trimmed
    .split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5))
    .join('\n')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** `"finish_reason": "<token>"`, for a frame that is not valid JSON as written. */
const QUOTED_FINISH = /"finish_reason"\s*:\s*"([^"]*)"/u
