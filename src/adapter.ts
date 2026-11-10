/**
 * The `xdpool` pi-ai provider: one loopback-backed adapter registered
 * into the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension
 * points. Every model points at the shim; account rotation stays inside it.
 *
 * Assembly (createProvider + openAICompletionsApi + inert auth plane + the
 * shim's in-process secret as apiKey) follows corrinehu/dsh-workbuddy-connect
 * (MIT, Copyright (c) 2026 Corrine Hu) and dingminhua/dsh-connect-workbuddy
 * (MIT), both designed and validated against this host.
 *
 * @module dsh-xdpool/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import { badgeLabels, displayBadge, shouldSpellOutFree } from './badges.ts'
import type { ModelBadge } from './badges.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.ts'
import { isAggregateCatalog, type AggregateCatalog, type AggregateModelRow } from './aggregate.ts'
import type { ComboModelRow } from './combos.ts'
import type { WorkBuddyShim } from './shim.ts'
import type { FreeModelRow } from './free-catalog.ts'
/** Provider route this bundle owns. */
/** Provider route this bundle owns for the domestic (CN) gateway. */
export const XDPOOL_PROVIDER = 'xdpool'
/** Provider route this bundle owns for the international gateway. */
export const XDPOOL_GLOBAL_PROVIDER = 'xdpool-global'
/**
 * Provider route this bundle owns for the aggregate lane.
 *
 * A THIRD id rather than a fourth row on an existing one: the two pool lanes
 * share the pool's rotation, its credits and its automation, and the aggregate
 * lane shares none of them — it holds the user's own key and has no account to
 * rotate. Folding its rows into a pool lane would put a third-party provider's
 * failures into the pool's cooldown table and its spend into the pool's usage
 * panel, both of which the user reads as WorkBuddy traffic.
 */
export const XDPOOL_AGGREGATE_PROVIDER = 'xdpool-aggregate'
/**
 * Provider route for the免密 free lane.
 *
 * A distinct id for the same reason as the aggregate lane: this lane draws on a
 * POOLED gateway credential with its own per-session quota, so folding its rows
 * into a pool lane would put a shared-quota 429 into the pool's cooldown table
 * and its tokens into the pool's usage panel — both of which the user reads as
 * their own WorkBuddy traffic.
 */
export const XDPOOL_FREE_PROVIDER = 'xdpool-free'
/**
 * Display name the free lane registers under, so the picker can group it.
 *
 * It is the only extra lane: the co-paid (EAC) lane that used to sit beside it
 * was removed on the user's instruction, because its whole reason for existing
 * was a sealed shared-signing entry only the original build's host could open,
 * and a lane that answers 503 for everyone else is worse than no lane at all.
 */
export const EXTRA_LANE_NAMES = {
  free: 'XD Pool · 免费模型',
} as const
/** The provider id each region registers as. */
export const POOL_PROVIDER_BY_REGION = {
  cn: XDPOOL_PROVIDER,
  global: XDPOOL_GLOBAL_PROVIDER,
} as const
/**
 * Display name each region registers under, so the picker can group them.
 *
 * "XD Pool" rather than the old "WorkBuddy XD Pool": the picker row is the only
 * place this string surfaces, and the brand the user asked for is XD Pool. The
 * REGION suffix stays because both lanes register real providers under different
 * ids — dropping it would leave two identically-named groups in the dropdown.
 *
 * Display name only. The provider ids above are what the host matches on when it
 * persists a selection, so renaming a group must never touch them.
 */
export const POOL_NAME_BY_REGION = {
  cn: 'XD Pool（国内版）',
  global: 'XD Pool（国际版）',
} as const
/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 50,
  imageOffloadCountQuantum: 10,
} as const
/**
 * Inert pi-ai auth plane. The route authenticates only through the shim shared
 * secret resolved per request, so pi-ai's own credential lifecycle must never
 * manufacture a credential for it.
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-xdpool: this route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const
export interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim
  catalog: WorkBuddyCatalog | AggregateCatalog
  /** Plugin context; the pi-ai adapter reads `attachments`/`fs` from it. */
  ctx: Context
  providerId?: string
  displayName?: string
  /**
   * The rows this provider serves, when it is a LATER lane rather than a pool.
   *
   * A fourth route registers its own provider id, so it owns its whole roster
   * and `catalog` is never consulted for it — passing a pool catalog there is not
   * a silent default, it is ignored on purpose. The roster is read per call,
   * exactly like the pool's, so a refresh that lands after startup is visible
   * without a restart.
   */
  extraRows?: (() => readonly FreeModelRow[]) | undefined
}
/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  providerId: string
  displayName: string
  adapter: PiAiAdapter
  /** Rebuild the pi-ai model list from the current catalog. */
  buildModels: () => Model<Api>[]
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
  /**
   * Tell this adapter whether the running host keeps `LlmModelInfo.badge`.
   *
   * It does from dsh-llm 0.2.2 onward; before that the host's listing mapper
   * rebuilds every row from four fields and drops the badge on the floor. That
   * is not something a version string can answer — the host is upgraded
   * independently of this plugin — so the caller probes the live answer and
   * reports it here. `true` moves the promotion labels onto the badge channel;
   * `false` keeps them in the display name, where every host since 0.1.2 has
   * rendered them.
   */
  setHostKeepsBadges: (keeps: boolean) => void
}
/** pi-ai input modalities: images only when the catalog advertises them. */
function modelInput(info: WorkBuddyModelInfo): ('text' | 'image')[] {
  return info.supportsImages ? ['text', 'image'] : ['text']
}
/**
 * pi-ai compat flags every model served through the loopback shim must carry.
 *
 * `supportsDeveloperRole: false` is load-bearing. pi-ai picks the role of the
 * instruction turn from `model.reasoning && compat.supportsDeveloperRole`, and
 * its own detection answers "yes" for anything that is neither OpenRouter nor
 * one of the listed non-standard vendors. The shim's `http://127.0.0.1:<port>/v1`
 * base URL matches neither, so every reasoning model used to go out as
 * `role: "developer"`, which WorkBuddy refuses with 400 + business code 11128
 * (`Illegal API invocation from an unapproved channel`). Measured on the live
 * gateway: the identical body with that role renamed to `system` answers 200,
 * and `developer` is the only shape it rejects that way.
 *
 * `prepareChatBody` relabels the role as a backstop for anything that still
 * reaches it, but the request should never leave pi-ai carrying a role the
 * gateway rejects — a backstop that rewrites the wire is a bug report waiting
 * to happen the moment the shim is bypassed.
 *
 * `supportsMidConvoSystemMessages` is deliberately ABSENT, and absent is not the
 * same as forgotten. From 0.2.2 the host reads that flag to decide whether a
 * mid-conversation `system` turn can be replayed as one; without it every such
 * turn is rewritten to `role: "user"` wrapped in `<system-reminder>`. That is
 * the safer shape for an OpenAI-compatible gateway — a role the gateway never
 * expected mid-stream is a 400, while a user-role reminder is merely less
 * emphatic — so the default worth keeping is the withheld one. Setting it to
 * `true` is only correct after a live check that WorkBuddy accepts a mid-convo
 * system turn; nothing in the catalog advertises that capability today.
 */
const SHIM_COMPAT = { supportsDeveloperRole: false } as const
/** Map only levels the catalog advertises; undeclared DSH levels stay off. */
function thinkingLevelMap(info: WorkBuddyModelInfo): Record<string, string | null> | undefined {
  const efforts = info.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return undefined
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const map: Record<string, string | null> = {}
  for (const level of levels) map[level] = (efforts as readonly string[]).includes(level) ? level : null
  map['off'] = null
  return map
}
/** Middle-dot separator: unambiguous between the model's own hyphens and the
 *  rate/badge suffix. Matches the LaoDing family convention. */
const DISPLAY_SEPARATOR = ' · '
/** Map an upstream tag code to the localized promo label shown next to the
 *  credit rate in the model picker. Both `free` and `limited-free` collapse to
 *  the same short label so the dropdown row stays scannable. */
const TAG_LABEL: Readonly<Record<string, string>> = {
  'free': '限时免费',
  'limited-free': '限时免费',
  'night-discount': '夜间折扣',
}
/** The rate half of the display suffix, or `undefined` for an unpriced row.
 *
 *  `multiplier: 0` is the gateways' own spelling of "free" (`credits: "x0.00"`),
 *  so it prints as the free label instead of "x0.00" — which read as a zero-cost
 *  rate and carried no promo label at all.
 *
 *  `shouldSpellOutFree` suppresses that when the gateway ALSO badged the row:
 *  `hy3` arrives as `multiplier: 0` AND `badge:限时免费`, and emitting both
 *  rendered the one fact twice ("免费 · 限时免费"). The gateway's own wording is
 *  the more informative of the two, so it wins — and {@link promoLabels}
 *  supplies it on whichever channel is active.
 *
 *  `!== 0` is load-bearing, not redundant: a zero-priced row that carries a
 *  badge falls through BOTH branches, and without the guard it would print the
 *  bare rate "x0.00" that the badge exists to replace.
 */
function rateSuffix(info: WorkBuddyModelInfo): string | undefined {
  if (shouldSpellOutFree(info)) return '免费'
  if (
    info.multiplier !== 0
    && typeof info.multiplier === 'number'
    && Number.isFinite(info.multiplier)
  ) {
    return `x${info.multiplier.toFixed(2)}`
  }
  return undefined
}
/** Every promotion label one row carries, upstream order.
 *
 *  Two vocabularies reach us and both are shown. `TAG_LABEL` covers the older
 *  bare codes (`free` / `limited-free` / `night-discount`); the gateway also
 *  writes promotions as `badge:<label>:#RRGGBB`, which that table never
 *  matched, so a model the gateway had explicitly marked as promoted used to
 *  render like any paid one. Those are shown verbatim: the label is already the
 *  string a user should read, and translating it here would need a table that
 *  goes stale the first time a badge is reworded.
 *
 *  This is the single list both display channels draw from, so switching
 *  channels cannot change which promotions appear or in what order.
 */
function promoLabels(info: WorkBuddyModelInfo): readonly string[] {
  const labels: string[] = []
  for (const tag of info.tags ?? []) {
    const label = TAG_LABEL[tag]
    if (label !== undefined && !labels.includes(label)) labels.push(label)
  }
  for (const label of badgeLabels(info.tags)) {
    if (!labels.includes(label)) labels.push(label)
  }
  return labels
}
/** Resolve the display suffix (`xN.NN`, promo labels) for one catalog row.
 *  Returns `undefined` when there's nothing to show — the name is left alone
 *  so we don't tack a trailing separator on a plain model.
 *
 *  `promotionsInName` is false once the host is known to carry
 *  `LlmModelInfo.badge`: the promotions then ride that channel, and repeating
 *  them in the name would render each one twice. The rate always stays here —
 *  the badge is a promotion label, not a price. */
function displaySuffix(info: WorkBuddyModelInfo, promotionsInName: boolean): string | undefined {
  const parts: string[] = []
  const rate = rateSuffix(info)
  if (rate !== undefined) parts.push(rate)
  if (promotionsInName) {
    for (const label of promoLabels(info)) {
      if (!parts.includes(label)) parts.push(label)
    }
  }
  return parts.length === 0 ? undefined : parts.join(DISPLAY_SEPARATOR)
}
/** Apply the catalog's rate + promo labels to one model's display name.
 *  Display-only: the wire request is built from `model.id`, so renaming here
 *  cannot affect routing, token, or upstream accounting. DSH 0.1.2's composer
 *  (`ModelSelect`) renders `model.name` only, which is why the rate and, on
 *  hosts without a badge channel, the promotions ride the name. */
function withCatalogDisplay(name: string, info: WorkBuddyModelInfo, promotionsInName: boolean): string {
  const suffix = displaySuffix(info, promotionsInName)
  return suffix === undefined ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`
}
/** The promotion badge for one row, or `undefined` when it carries none. */
function modelBadge(info: WorkBuddyModelInfo): ModelBadge | undefined {
  return displayBadge(info.tags, promoLabels(info))
}
/** Build one pi-ai model descriptor pointing at the loopback shim.
 *
 *  `promotionsInName` decides whether the promotion labels ride the name; the
 *  badge for the other channel is looked up separately by
 *  {@link PiAiAdapter.listModels}, because pi-ai's own `Model` has no badge
 *  field and nothing downstream of it reads one. */
function toPiModel(
  info: WorkBuddyModelInfo,
  baseUrl: string,
  providerId: string,
  promotionsInName: boolean,
): Model<Api> {
  const map = thinkingLevelMap(info)
  return {
    id: info.id,
    name: withCatalogDisplay(info.name, info, promotionsInName),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: modelInput(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxOutputTokens,
    reasoning: map !== undefined,
    ...map === undefined ? {} : { thinkingLevelMap: map },
    compat: { ...SHIM_COMPAT, supportsReasoningEffort: map !== undefined },
  } as unknown as Model<Api>
}
/**
 * Build one pi-ai model descriptor for an aggregate row.
 *
 * Every row points at the same loopback shim, exactly like the pool lanes — the
 * composite id in `id` is what tells the shim which upstream to reach. Context
 * and output ceilings come from the provider's own listing, with the shared
 * defaults applied when it declined to say; guessing low would make pi-ai
 * compact a conversation early, guessing high would let it run into the
 * provider's real limit and get a 400 the user cannot explain.
 */
function toAggregateModel(row: AggregateModelRow, baseUrl: string, providerId: string): Model<Api> {
  return {
    id: row.id,
    name: `${row.name}${DISPLAY_SEPARATOR}${row.providerId}`,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: row.supportsImages ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: row.contextWindow,
    maxTokens: row.maxOutputTokens,
    // Third-party listings do not describe reasoning, so the honest answer is
    // "unknown" — which for pi-ai means "do not offer the thinking control"
    // rather than "offer it and send a parameter the provider may reject".
    reasoning: false,
    compat: { ...SHIM_COMPAT, supportsReasoningEffort: false },
  } as unknown as Model<Api>
}
/**
 * Build one pi-ai model descriptor for a chain row.
 *
 * A chain is not a vendor, so there is no `providerId` to suffix onto the name —
 * the chain's own name already says what it is, and the member ids are what the
 * picker expands it into. Capacities are the intersection the chain builder
 * computed, so pi-ai compacts early enough for the weakest member instead of
 * letting the turn run past it.
 */
function toComboModel(row: ComboModelRow, baseUrl: string, providerId: string): Model<Api> {
  return {
    id: row.id,
    name: row.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: row.supportsImages ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: row.contextWindow,
    maxTokens: row.maxOutputTokens,
    // A chain does not advertise reasoning: it cannot know whether the member
    // that answers understands the parameter, and pi-ai's thinking control maps
    // onto it one-to-one.
    reasoning: false,
    compat: { ...SHIM_COMPAT, supportsReasoningEffort: false },
  } as unknown as Model<Api>
}
/**
 * Build one pi-ai model descriptor for a free lane row.
 *
 * The thinking control IS offered here, unlike the aggregate lane: this lane
 * publishes a measured `efforts` menu, so "unknown" would withhold a control the
 * user demonstrably has. The ceiling comes from the lane's own capability table
 * rather than a model card, because the table is what the lane was probed
 * against.
 */
function toExtraLaneModel(row: FreeModelRow, baseUrl: string, providerId: string): Model<Api> {
  const efforts = 'efforts' in row && Array.isArray(row.efforts) && row.efforts.length > 0 ? row.efforts : undefined
  const map = efforts === undefined ? undefined : thinkingLevelMap({
    id: row.id,
    name: row.name,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutput,
    supportsImages: row.vision,
    supportedEfforts: efforts,
  })
  return {
    id: row.modelId,
    name: row.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: row.vision ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: row.contextWindow,
    maxTokens: row.maxOutput,
    reasoning: row.reasoning,
    ...map === undefined ? {} : { thinkingLevelMap: map },
    // No `...SHIM_COMPAT` here on purpose. These rows are not answered by
    // WorkBuddy: the shim hands the caller's body to the lane's own upstream
    // (a third-party OpenAI-compatible endpoint), so the role the gateway
    // refuses never reaches it. Forcing `system` here would rewrite what a
    // different vendor was already accepting.
    compat: { supportsReasoningEffort: map !== undefined },
  } as unknown as Model<Api>
}
/**
 * Assemble the adapter. `getModels` re-reads the live catalog, and every
 * model's `baseUrl` is re-resolved per read so the shim's ephemeral port
 * applies from the first snapshot after startup. Call only after `shim.ready`.
 *
 * `catalog` accepts the aggregate catalog too; {@link isAggregateCatalog} tells
 * the two apart by shape rather than by a flag, because the aggregate rows are a
 * different kind of record, not a differently-populated pool row.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, catalog } = options
  const providerId = options.providerId ?? XDPOOL_PROVIDER
  const displayName = options.displayName ?? 'XD Pool'
  const aggregateCatalog = isAggregateCatalog(catalog)
  const extraRows = options.extraRows
  // Defaults to the older channel so a caller that never probes still gets the
  // promotions rendered somewhere. Only the pool lane has catalog tags to
  // promote; the other lanes' rows carry none, so the flag never changes them.
  let hostKeepsBadges = false
  const buildModels = (): Model<Api>[] => {
    const baseUrl = `${shim.baseUrl()}/v1`
    if (extraRows !== undefined) {
      return (extraRows() ?? []).map(row => toExtraLaneModel(row, baseUrl, providerId))
    }
    if (aggregateCatalog) {
      // Narrowed per set on purpose: a third-party row and a chain row are
      // different records with different fields, and pushing both through one
      // mapper is what would let a chain row claim a provider it has none of.
      return [
        ...catalog.providerRows().map(row => toAggregateModel(row, baseUrl, providerId)),
        ...catalog.comboRows().map(row => toComboModel(row, baseUrl, providerId)),
      ]
    }
    return catalog.visible().map(info => toPiModel(info, baseUrl, providerId, !hostKeepsBadges))
  }
  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'XD Pool loopback secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'XD Pool' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })
  const provider: Provider = { ...base, getModels: () => buildModels() }
  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-xdpool retryPolicy'),
    configuredMaxTokens: new Map(),
    // Required by dsh-llm-pi-ai >= 0.1.5-rc.2: the host adapter reads
    // profile.modelErrors.get(model) on every model resolution. The catalog
    // comes from the live upstream, so there are no pre-known failures — an
    // empty map means "no model is pre-rejected".
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  // `modelErrors` is declared in the literal above: the pinned dsh-llm-pi-ai
  // (0.1.5-rc.2) publishes it as required, so the cast-based workaround the
  // older pin needed is gone.
  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // The shim's per-process secret is the OpenAI apiKey; the shim validates it
    // and resolves the real WorkBuddy token itself, per request, from the pool.
    resolveApiKey: async () => shim.token(),
    // Image input is served from the host durable attachment store. The host
    // PiAiAdapter refuses any request that carries an image when this hook is
    // absent ("pi-ai image input requires the durable attachment service"), so a
    // route advertising image input must wire both hooks up.
    resolveAttachments: () => options.ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, hostPath => options.ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  })
  // pi-ai's own `Model` has no badge field, so the host adapter's listing
  // mapper can only ever echo `{ provider, id, name, inputModalities }` — and
  // dsh-llm before 0.2.2 drops even `badge` from what it hands upward. The
  // promotion label therefore has to be attached here, on the one method the
  // host calls to enumerate a provider's models.
  //
  // It is attached unconditionally, not only once the host is known to keep it:
  // publishing it is how the caller finds out whether the running host keeps it
  // (see `probeBadgeChannel` in the plugin entry), and a host that drops the
  // field is not harmed by its presence.
  const listModelsBase = adapter.listModels.bind(adapter)
  adapter.listModels = async (provider: string) => {
    const rows = await listModelsBase(provider)
    // Only the pool lane's rows carry promotions. The aggregate, chain and free
    // lanes publish their own names, so there is no catalog row to look up.
    const byId = new Map<string, WorkBuddyModelInfo>()
    if (extraRows === undefined && !aggregateCatalog) {
      for (const info of catalog.visible()) byId.set(info.id, info)
    }
    if (byId.size === 0) return rows
    return rows.map((row) => {
      const info = byId.get(row.id)
      const badge = info === undefined ? undefined : modelBadge(info)
      return badge === undefined ? row : { ...row, badge }
    })
  }
  return {
    providerId,
    displayName,
    adapter,
    buildModels,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
    setHostKeepsBadges: (keeps: boolean) => {
      if (keeps === hostKeepsBadges) return
      hostKeepsBadges = keeps
      // A fresh Map is a fresh snapshot: the host adapter re-reads `getModels`
      // off it, which is what puts the other channel's names in front of a
      // picker that has already drawn this provider once.
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
    },
  }
}
