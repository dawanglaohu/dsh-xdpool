/**
 * Model catalog with per-model credit multipliers.
 *
 * A static fallback keeps the provider usable before the first successful
 * upstream call; when the live catalog arrives it replaces the fallback and
 * the adapter rebuilds the provider's model list.
 *
 * @module dsh-xdpool/catalog
 */

import { BADGE_TAG_PREFIX } from './badges.ts'
import type { WorkBuddyUpstreamModel } from './upstream.ts'
import type { PoolWebCatalogSource } from './status-paths.ts'

/** One model the provider exposes. */
export interface WorkBuddyModelInfo {
  id: string
  /** Display name; the multiplier is appended for the picker. */
  name: string
  contextWindow: number
  maxOutputTokens: number
  /** Relative credit cost, e.g. 0.79 for `x0.79`. */
  multiplier?: number
  /** Upstream-declared thinking levels. */
  supportedEfforts?: readonly string[]
  supportsImages: boolean
  /** Upstream tags: free / limited-free / night-discount. */
  tags?: readonly string[]
}

/**
 * Static fallback used before the first live catalog fetch, and whenever the
 * upstream cannot be reached.
 *
 * This table is the DOMESTIC (CN) roster, and it is kept in step with what
 * `copilot.tencent.com` actually advertises. It matters more than a "just in
 * case" list usually would: a failed startup fetch falls back to it, and the
 * user sees that as "half my models were deleted" — `deepseek-v4.1-flash`
 * and friends simply vanishing from the picker, with no visible explanation.
 *
 * Every row below was captured from the live endpoint, INCLUDING the window
 * sizes: the previous version carried a 32K window for `hy3` when the gateway
 * says 192K, and listed `kimi-k3` under an id the gateway no longer uses
 * (`kimi-k3-1`). A stale fallback is worse than a short one — it looks
 * authoritative while being wrong.
 *
 * `supportedEfforts` is carried here for the same reason, and it is the one
 * field whose absence changes behaviour rather than just display. The gateway
 * rejects a `reasoning_effort` the row does not declare (business code 11133 /
 * 11150), and the clamp in `prepareChatBody` can only intersect the request with
 * a declaration it has. A row with no `supportedEfforts` therefore gets no clamp
 * at all, so the level the session asks for goes out unmodified and a
 * `max`-defaulted session fails on every row that only admits `high`. Rows the
 * live endpoint reports without `supportedEfforts` stay absent here on purpose:
 * inventing one would clamp requests the gateway would have accepted.
 *
 * `multiplier: 0` is the gateways' own spelling of "free" (`credits: "x0.00"`),
 * which is what turns on the free badge.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true, tags: ['craft'] },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 960_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.29, supportedEfforts: ['high'], tags: ['craft', 'badge:夜间免费:#FF0000'] },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0, tags: ['craft', 'badge:限时免费:#FF0000'] },
  { id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.05, supportedEfforts: ['low', 'high'] },
  { id: 'space-bunny', name: 'Space-Bunny', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.08, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.11, supportedEfforts: ['low', 'high', 'max'] },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, multiplier: 0.51 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.79, supportedEfforts: ['low', 'high', 'max'] },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, maxOutputTokens: 131_072, supportsImages: true, multiplier: 0.06, supportedEfforts: ['low', 'high', 'max'] },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.79, tags: ['craft', 'badge:夜间折扣:#1E90FF'] },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxOutputTokens: 48_000, supportsImages: false, multiplier: 0.79 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.71 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 1.62 },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', contextWindow: 1_000_000, maxOutputTokens: 32_000, supportsImages: true, supportedEfforts: ['low', 'high', 'max'] },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.77, supportedEfforts: ['low', 'high', 'max'] },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.57 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, maxOutputTokens: 32_000, supportsImages: true, multiplier: 0.52 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, maxOutputTokens: 64_000, supportsImages: true, multiplier: 0.25 },
  // Not in either gateway's advertised roster, but it answers on both and it is
  // the one row an exhausted account can still reach. Two measured facts set its
  // shape rather than the config: the gateway advertises
  // `maxOutputTokens: 64000` yet a 65,536-token request dies with
  // `invoke model error` (business code 10000) — 60,000 is the largest budget
  // that answered — and `usage.credit` came back 0 on every request, in both
  // regions, which is why it carries the same `multiplier: 0` spelling as `hy3`
  // instead of the config's `x0.43`.
  { id: 'step-5-preview', name: 'Step-5-Preview', contextWindow: 1_000_000, maxOutputTokens: 60_000, supportsImages: true, multiplier: 0, supportedEfforts: ['low', 'medium', 'high'] },
]

/** Which gateway a catalog describes. Mirrors `WorkBuddyRegion` in `upstream.ts`. */
export type CatalogRegion = 'cn' | 'global'

/**
 * The static table to fall back to when the international gateway is unreachable.
 *
 * Derived from {@link FALLBACK_WORKBUDDY_MODELS} by stripping the domestic
 * `badge:*` tags rather than hand-written, and that is a CORRECTION rather than
 * a new feature: both regions have always shared one table, but the CN-only
 * campaign wording (`限时免费` / `夜间免费` / `夜间折扣`) rode along into the
 * international picker, advertising a promotion that gateway does not run.
 *
 * Now that those badges are parsed and actually SHOWN, the leak would be
 * visible on every global row instead of sitting inert in a tag array — which
 * is exactly the "invented a discount nobody gets" failure this plugin must not
 * have. The rest of each row is left untouched, preserving the pre-existing
 * behaviour that a global user without a reachable gateway sees the shared
 * roster rather than an empty picker.
 *
 * Deliberately NOT a separate global roster of its own: only the multiplier and
 * context window were captured from `www.workbuddy.ai`, so inventing
 * `maxOutputTokens` / `supportsImages` for 25 rows would put fabricated fields in
 * front of the user — strictly worse than the shared list it replaces.
 *
 * The one exception is appended below and only there, because it is the one row
 * with no domestic twin to share: the domestic gateway does not sell it at all.
 */
const FALLBACK_WORKBUDDY_MODELS_GLOBAL: readonly WorkBuddyModelInfo[] = [
  ...FALLBACK_WORKBUDDY_MODELS.map(
    model => {
      const tags = (model.tags ?? []).filter(tag => !tag.startsWith(BADGE_TAG_PREFIX))
      if (tags.length === (model.tags?.length ?? 0)) return model
      return { ...model, ...(tags.length === 0 ? {} : { tags }) }
    },
  ),
  /**
   * The one international row with no domestic twin.
   *
   * `deepseek-v4.1-flash-sg` is the Singapore-priced DeepSeek-V4.1-Flash: the
   * same model the CN roster sells as `deepseek-v4.1-flash`, on a separate
   * rate-limit row at `x0.03` instead of `x0.11`. It is captured from
   * `www.workbuddy.ai/v3/config` verbatim — window `1_000_000` (the gateway
   * publishes `defaultLength: 300000` plus `supportedLengths: [300000,
   * 1000000]`, and {@link resolveContextWindow} in `upstream.ts` takes the
   * largest), output `128_000`, images yes, efforts `low / high / max`.
   *
   * It has to live in the static table, not only in the live merge. A failed
   * startup fetch falls back to this list, and a user who had the row enabled
   * then loses it from the picker AND from the provider's roster — a session
   * pinned to the id dies with `pi-ai provider "xdpool-global" has no configured
   * model "deepseek-v4.1-flash-sg"`, which reads as "the plugin does not have
   * this model" when the gateway is in fact serving it.
   *
   * Appended rather than merged into the shared table above: that one is the CN
   * roster and is kept in step with `copilot.tencent.com`, which does not
   * advertise this id. A CN fallback naming it would offer a model the domestic
   * gateway answers `11102 service info not found` for.
   */
  {
    id: 'deepseek-v4.1-flash-sg',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsImages: true,
    multiplier: 0.03,
    supportedEfforts: ['low', 'high', 'max'],
  },
]

/**
 * Rows the international gateway was measured refusing, so the live merge must
 * not append them behind a healthy roster.
 *
 * They are only withheld from the MERGE. The static fallback itself keeps them
 * because that table is also what a user with no reachable gateway sees, and an
 * id that is merely refused today is better than a picker that shrank — which is
 * the same reasoning the shared roster already rests on. Every id here answered
 * `11102 service info not found` on `www.workbuddy.ai`.
 */
const GLOBAL_WITHHELD_IDS: ReadonlySet<string> = new Set([
  'hy3-x', 'deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3-1',
])

/** The static fallback table for one region. Defaults to `cn`. */
export function fallbackModelsFor(region: CatalogRegion = 'cn'): readonly WorkBuddyModelInfo[] {
  return region === 'global' ? FALLBACK_WORKBUDDY_MODELS_GLOBAL : FALLBACK_WORKBUDDY_MODELS
}

/** Live catalog with a static fallback behind it. */
export class WorkBuddyCatalog {
  /**
   * Which gateway this catalog serves, and therefore which static table it falls
   * back to.
   *
   * Optional in the constructor so every existing `new WorkBuddyCatalog()`
   * (tests, and the plugin's own default wiring) keeps compiling; it defaults to
   * `cn` because that is the table this plugin has always shipped.
   */
  private readonly region: CatalogRegion

  private models: readonly WorkBuddyModelInfo[]

  constructor(region: CatalogRegion = 'cn') {
    this.region = region
    this.models = fallbackModelsFor(region)
  }
  private listeners = new Set<() => void>()
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  private selection: ModelSelection = {}
  /**
   * Whether `models` came from the gateway or from the static table.
   *
   * Tracked so the card can SAY which it is showing. A failed fetch used to be
   * invisible on screen: the picker simply held fewer models than before, which
   * the user reasonably read as "the plugin deleted my models" rather than "the
   * network hiccuped at startup".
   */
  private source: PoolWebCatalogSource = 'fallback'
  /** When the live list last landed. */
  private lastUpdatedAt: string | undefined
  /** Why the last fetch failed, for display. */
  private lastError: string | undefined

  current(): readonly WorkBuddyModelInfo[] {
    return this.models
  }

  /**
   * The models DSH should actually offer, after applying the user's selection:
   * disabled models are dropped, an explicit image list overrides the upstream
   * capability flag, and a per-model budget caps the advertised window.
   *
   * An absent `enabledModelIds` means "everything" — a fresh install with no
   * saved selection must not present an empty picker.
   */
  visible(): readonly WorkBuddyModelInfo[] {
    const enabled = this.selection.enabledModelIds
    const allow = enabled === undefined ? undefined : new Set(enabled)
    const images = this.selection.imageModelIds
    const imageSet = images === undefined ? undefined : new Set(images)
    const budgets = this.selection.contextBudgets
    return this.models
      .filter(model => allow === undefined || allow.has(model.id))
      .map(model => {
        const next = { ...model }
        if (imageSet !== undefined) next.supportsImages = next.supportsImages || imageSet.has(model.id)
        const budget = budgets?.[model.id]
        if (budget !== undefined && budget > 0 && budget < next.contextWindow) next.contextWindow = budget
        return next
      })
  }

  /** Replace the catalog and notify the adapter to rebuild its model list. */
  update(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) return
    this.models = models
    this.notify()
  }

  /** Restore the static fallback, e.g. when the upstream stops answering. */
  reset(): void {
    this.models = fallbackModelsFor(this.region)
    this.source = 'fallback'
    this.notify()
  }

  /** Replace the user's selection; the adapter rebuilds from `visible()`. */
  applySelection(selection: ModelSelection): void {
    this.selection = selection
    this.notify()
  }

  /** The selection currently in force, for the card's save round-trip. */
  currentSelection(): ModelSelection {
    return this.selection
  }

  /**
   * Whether this catalog is serving live data or the built-in table.
   *
   * `fallback` is not an error state, but it IS a degraded one: the user is
   * looking at a shorter roster than the gateway offers, so the card says so
   * and offers a retry instead of letting them wonder where the models went.
   */
  currentSource(): PoolWebCatalogSource {
    return this.source
  }

  /**
   * When the live list last landed, if it ever did.
   *
   * Named `catalogUpdatedAt()` rather than `updatedAt()` because the class
   * already had an `updatedAt` member; two members of the same name is a
   * compile error, and the awkwardness is a useful signal that the concept is
   * "when THIS catalog was refreshed", not a generic timestamp.
   */
  catalogUpdatedAt(): string | undefined {
    return this.lastUpdatedAt
  }

  /** Why the last fetch failed, if it did. */
  lastFetchError(): string | undefined {
    return this.lastError
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  find(id: string): WorkBuddyModelInfo | undefined {
    return this.models.find(model => model.id === id)
  }

  /** Replace the catalog from the live upstream list; keeps the fallback if empty. */
  updateFromUpstream(models: readonly WorkBuddyUpstreamModel[]): void {
    this.update(catalogFromUpstream(models, this.region))
    this.source = 'live'
    this.lastUpdatedAt = new Date().toISOString()
    this.lastError = undefined
  }

  /**
   * Record that a fetch attempt failed, leaving the current list in place.
   *
   * The list is deliberately NOT reset here: a refresh that fails should keep
   * whatever working catalog is already loaded, rather than demoting a healthy
   * session to the static table because one retry ran out.
   */
  noteFetchFailure(message: string): void {
    this.lastError = message
    // Only report `fallback` when that is actually what we are showing: a live
    // list that merely failed to REFRESH is still live.
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The user's model selection, as stored in the settings section. */
export interface ModelSelection {
  /** Absent = every model in the catalog is offered. */
  enabledModelIds?: readonly string[]
  /** Absent = each model follows its upstream image capability. */
  imageModelIds?: readonly string[]
  /** Per-model context-window cap, keyed by model id. */
  contextBudgets?: Readonly<Record<string, number | undefined>>
}

/**
 * Why a model the card lists is missing from the provider's own roster.
 *
 * The card renders {@link WorkBuddyCatalog.current} — the whole catalog — while
 * the pi-ai provider serves {@link WorkBuddyCatalog.visible}, which applies the
 * user's selection. Those two lists are supposed to differ; what must not differ
 * is the EXPLANATION the user gets for it.
 *
 * A disabled row is not a broken model, but a request for one dies inside the
 * host with `pi-ai provider "xdpool-global" has no configured model
 * "deepseek-v4.1-flash-sg"` — a message that names no cause and reads as "this
 * plugin never had that model". The connection test on that same row therefore
 * reported a failure for a model the gateway serves happily. Returning the gap
 * lets the probe say which of the two it is.
 *
 * `not-in-catalog` covers the other half: an id that arrived from a session, a
 * hand-edited config, or a stale tab and that no roster knows about at all.
 */
export type ModelRouteGap = 'not-in-catalog' | 'disabled-by-selection'

/** Classify `id` against a catalog's full roster and its visible subset. */
export function modelRouteGap(catalog: WorkBuddyCatalog, id: string): ModelRouteGap | undefined {
  if (!catalog.current().some(model => model.id === id)) return 'not-in-catalog'
  if (catalog.visible().some(model => model.id === id)) return undefined
  return 'disabled-by-selection'
}

/**
 * The sentence a user reads when {@link modelRouteGap} has an answer.
 *
 * English, like every other diagnostic this plugin puts on the wire
 * (`shim.ts`'s upstream messages, the shim's `writeOpenAIError`): the card
 * renders a probe failure verbatim, and one language per error surface is what
 * keeps it readable next to those.
 *
 * Both halves name the FIX rather than the symptom. The card's model list is
 * where the switch lives, and "Refresh models" is the button that re-fetches a
 * roster — so the message says which of the two to press, instead of restating
 * that the model could not be resolved.
 */
export function describeModelRouteGap(gap: ModelRouteGap, model: string, lane: string): string {
  if (gap === 'disabled-by-selection') {
    return `${model} is switched OFF in ${lane}'s model list, so XD Pool does not register it as a `
      + 'routable model. Tick it in the XD Pool card\'s model list, save, and retry.'
  }
  return `${model} is not in ${lane}'s model catalog. It may come from an old session, a hand-edited `
    + 'config, or a row the gateway has withdrawn. Press "Refresh models" on the XD Pool card and retry.'
}

/** Convert one upstream catalog entry into the plugin's model-info shape. */
export function toModelInfo(model: WorkBuddyUpstreamModel): WorkBuddyModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsImages: model.supportsImages ?? false,
    ...model.creditMultiplier === undefined ? {} : { multiplier: model.creditMultiplier },
    ...model.reasoning?.supportedEfforts === undefined ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
    // `tags` used to be dropped here as well, so even a gateway that DID send
    // `free` would have had it stripped before the card ever saw it.
    ...model.tags === undefined || model.tags.length === 0 ? {} : { tags: model.tags },
  }
}

/**
 * Map the live upstream list, keeping the static rows the live one omits.
 *
 * The live list is NOT the whole roster. The international `/v3/config` names
 * 13 models and not one of them is `hy3`, `deepseek-v4.1-flash` or
 * `step-5-preview` — the three that answer on a zero-credit account — yet all
 * three serve requests through the same gateway. Replacing the table with the
 * live answer therefore deleted exactly the rows an exhausted account depends
 * on, and the picker offered nothing that could still run.
 *
 * So the live list wins on every id it names (its window and rate are the
 * gateway's own), and any static row it did not mention is appended behind it.
 * The static row keeps its own fields because nothing better exists for it: the
 * endpoint that advertises windows simply does not list it.
 *
 * `region` still chooses WHICH static table contributes those extras, and on the
 * international side it also drops the rows that gateway was measured refusing —
 * see {@link GLOBAL_WITHHELD_IDS}.
 */
export function catalogFromUpstream(
  models: readonly WorkBuddyUpstreamModel[],
  region: CatalogRegion = 'cn',
): readonly WorkBuddyModelInfo[] {
  if (models.length === 0) return fallbackModelsFor(region)
  const live = models.map(toModelInfo)
  const named = new Set(live.map(model => model.id))
  const withheld = region === 'global' ? GLOBAL_WITHHELD_IDS : undefined
  const extra = fallbackModelsFor(region)
    .filter(model => !named.has(model.id) && withheld?.has(model.id) !== true)
  return extra.length === 0 ? live : [...live, ...extra]
}
