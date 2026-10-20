/**
 * What we can honestly say about one model, in one place.
 *
 * The three pages that show a model — the sign-in page, the aggregate lane and
 * the account pool — used to print whatever happened to be in scope, which is
 * how the same model ended up described differently depending on where you
 * looked. This module is the single place a row's facts come from, so the three
 * pages cannot drift apart.
 *
 * ## Every field here is a FACT OR NOTHING
 *
 * The registry carries no per-model blurb: its 504 model rows have exactly five
 * keys (`id`, `name`, `contextWindow`, `vision`, `reasoning`), and of those
 * `vision` and `reasoning` are null on every single row while `contextWindow` is
 * set on 48. So a description, a "best for" line or a modality claim that cannot
 * be traced to a number the upstream published is a guess wearing the same font
 * as the facts beside it. This module therefore refuses to produce one:
 *
 *  - {@link ModelFacts} fields are `undefined` when nothing published them, and
 *    the row prints nothing for them.
 *  - {@link modelFactsFor} never invents a value to fill a gap.
 *
 * The one inference this module does make is deliberately narrow and is called
 * out at its definition: a window above the pool's own serving cap is reported
 * as capped, because that number is one WE chose and can therefore prove.
 */

/**
 * The keys this component asks a page translator for.
 *
 * Declared as a literal union rather than as `string` because of variance: every
 * page translator in this plugin is typed over the whole
 * `XdPoolSettingsKey` union, and a function accepting that union is NOT
 * assignable to one accepting `string` — parameters are contravariant, so the
 * target must not demand more than the source offers. Naming our own keys and
 * importing the union's member type here is what keeps the three pages able to
 * hand their translator straight in with no cast at the call site.
 */
export type ModelFactsKey =
  | 'facts.context'
  | 'facts.output'
  | 'facts.input'
  | 'facts.thinking'
  | 'facts.textAndImage'
  | 'facts.textOnly'
  | 'facts.thinkingHint'
  | 'facts.test'
  | 'facts.testHint'
  | 'facts.testing'
  | 'facts.firstFrame'
  | 'facts.outputChars'
  | 'facts.probeOk'
  | 'facts.probeFailed'

/**
 * Translate a settings key, as the pages hand one to this component.
 *
 * The parameter bag matches every page translator in the plugin —
 * `Record<string, unknown>` — so a page's translator is assignable to this type
 * without a cast at each of the three call sites. A narrower bag (say
 * `string | number`) is not assignable, because a translator typed that way
 * cannot accept the arbitrary values another page's keys imply.
 */
export type ModelFactsTranslate = (key: ModelFactsKey, params?: Record<string, unknown>) => string

/**
 * One completed connectivity measurement, as the card holds it.
 *
 * Mirrors {@link import('./status-paths.ts').PoolWebModelProbeResult} rather
 * than re-declaring its fields loosely: the card keeps whatever the route
 * answered, including an error string it must print verbatim, because a
 * connection test that hides its own failure teaches the user the button is
 * broken.
 */
export interface ModelProbeReading {
  readonly ok: boolean
  readonly firstFrameMs?: number | undefined
  readonly outputChars: number
  readonly error?: string | undefined
}

/**
 * One model's provable attributes.
 *
 * Every field is optional on purpose. `undefined` means "the upstream never
 * said", which the row renders as absence rather than as a guess.
 */
export interface ModelFacts {
  /** Published context window, in tokens. Absent when unpublished. */
  contextWindow?: number
  /** Published output ceiling, in tokens. Absent when unpublished. */
  maxOutputTokens?: number
  /** True when the model accepts image input. Absent when unpublished. */
  vision?: boolean
  /**
   * Thinking levels the upstream names. Absent when it names none — which is
   * NOT the same as "no reasoning": plenty of gateways simply do not publish
   * the list, and saying "no reasoning" would be a claim we cannot support.
   */
  supportedEfforts?: readonly string[]
  /** A short vendor-authored description, when one exists for this model. */
  description?: string
}

/**
 * How a model row's context-window picker resolves.
 *
 * The pack only sends `nativeContextWindow` once the user has already narrowed
 * that model, and only sends `contextBudget` when a cap exists at all: an absent
 * cap means "not narrowed", which is served with the full native window. Reading
 * that absence as the conservative default would show a 1M model as capped at
 * 200K, and then neither radio in the picker could ever come up selected for the
 * full window — the click would write a cap, reload, and snap back.
 *
 * `capped` is only about whether a picker has anything to offer: a model whose
 * window does not exceed the default has nothing to choose between.
 */
export function contextWindowChoice(
  model: {
    readonly nativeContextWindow?: number | undefined
    readonly contextWindow?: number | undefined
    readonly contextBudget?: number | undefined
  },
  defaultBudget: number,
): { readonly native: number | undefined; readonly capped: boolean; readonly budget: number | undefined } {
  const native = model.nativeContextWindow ?? model.contextWindow
  const capped = native !== undefined && native > defaultBudget
  const budget = model.contextBudget ?? native
  return { native, capped, budget }
}

/** A raw number a model row may carry, narrowed to something printable. */
function capacityOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/** An upstream-declared effort list, kept only when it has real entries. */
function effortsOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const effort = raw.trim()
    if (effort === '' || seen.has(effort)) continue
    seen.add(effort)
    out.push(effort)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Collect whatever a caller can prove about one model, dropping anything
 * unusable.
 *
 * Takes `unknown` on every field because all three callers read rows that came
 * off the wire: a live catalog, a registry, or a route document. Narrowing here
 * is what keeps a malformed row from printing `NaN` or `undefined KB` into the
 * settings dialog.
 */
export function modelFactsFor(row: {
  contextWindow?: unknown
  maxOutputTokens?: unknown
  supportsImages?: unknown
  vision?: unknown
  supportedEfforts?: unknown
  description?: unknown
  notes?: unknown
}): ModelFacts {
  const out: ModelFacts = {}
  const contextWindow = capacityOf(row.contextWindow)
  if (contextWindow !== undefined) out.contextWindow = contextWindow
  const maxOutputTokens = capacityOf(row.maxOutputTokens)
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens
  // `supportsImages` is the pool lane's post-toggle spelling; `vision` is the
  // registry's. Either proves image input, and either being absent proves
  // nothing at all — so absence stays absent.
  const images = typeof row.supportsImages === 'boolean' ? row.supportsImages
    : typeof row.vision === 'boolean' ? row.vision
      : undefined
  if (images !== undefined) out.vision = images
  const supportedEfforts = effortsOf(row.supportedEfforts)
  if (supportedEfforts !== undefined) out.supportedEfforts = supportedEfforts
  // A description is the one field that may legitimately come from prose rather
  // than a number, so it is the one field trimmed as text. Only the vendor-level
  // note is accepted; a model row must never inherit its vendor's blurb and read
  // as if the vendor wrote it about that model.
  const description = typeof row.description === 'string' ? row.description.trim()
    : typeof row.notes === 'string' ? row.notes.trim()
      : ''
  if (description !== '') out.description = description
  return out
}

/** Format a token count the way every page in the plugin already does. */
export function formatModelCapacity(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(2))}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}K`
  }
  return String(Math.trunc(value))
}

/**
 * One model's line of figures, already resolved for printing.
 *
 * The context figure is the window the model publishes, printed as published.
 * This module used to clamp anything above 131 072 down to that number on the
 * theory that the account-pool lane served nothing larger; it does — the lane
 * passes `contextWindow` through untouched and the catalogue declares 1M for
 * whole families of models — so clamping printed "131K" next to a model the
 * picker right beside it offered at 1M.
 */
export function modelFigureLine(facts: ModelFacts): {
  context?: string
  output?: string
  vision?: 'text' | 'both'
  efforts?: string
} {
  const out: {
    context?: string
    output?: string
    vision?: 'text' | 'both'
    efforts?: string
  } = {}
  if (facts.contextWindow !== undefined) out.context = formatModelCapacity(facts.contextWindow)
  if (facts.maxOutputTokens !== undefined) out.output = formatModelCapacity(facts.maxOutputTokens)
  if (facts.vision !== undefined) out.vision = facts.vision ? 'both' : 'text'
  if (facts.supportedEfforts !== undefined) out.efforts = facts.supportedEfforts.join(' / ')
  return out
}