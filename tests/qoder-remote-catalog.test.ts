/**
 * The Qoder channels used to render a hand-written catalogue: the model list
 * endpoint needs a WASM-signed request, the pack never implemented one, so
 * whatever the fallback table said was what the user saw — indefinitely. When
 * the vendor renamed `kmodel_latest` to Kimi-K3.1-Pro, changed its multiplier
 * from 1.4 to 1.0 and dropped `dfmodel` to free, the card kept printing the old
 * numbers with no way to ask again.
 *
 * `model.refresh` closes that: the adapter signs a GET with
 * `qodercontext_prepareRequest`, reads `{chat: [...]}` and replaces the
 * catalogue. What is pinned here is the mapping — the vendor's field names and
 * our table's field names disagree on almost every key, and three of the rules
 * are load-bearing:
 *
 * - `contextWindow` is the widest `context_config` tier, never
 *   `max_input_tokens` (that field contradicts the tier table and is missing
 *   outright on `kmodel`);
 * - `defaultEffort` must be one of `efforts`, or DSH raises
 *   UNSUPPORTED_REASONING_EFFORT the first time the model is used;
 * - `supportsDisable` comes from the presence of a `thinking_config.disabled`
 *   branch, not from a guess.
 *
 * The pack is a vendored bundle with host-only imports, so the declarations are
 * lifted out of its source text and executed in a stubbed scope, the same way
 * the saturation and header-deadline suites do it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

/** Slice one declaration out of the bundle; the end anchor is kept. */
function grab(startAnchor: string, endAnchor: string): string {
  const at = source.indexOf(startAnchor)
  if (at < 0) throw new Error(`pack.js no longer contains: ${startAnchor}`)
  const end = source.indexOf(endAnchor, at + startAnchor.length)
  if (end < 0) throw new Error(`pack.js declaration is unterminated: ${startAnchor}`)
  return source.slice(at, end + endAnchor.length)
}

const DECLARATIONS = [
  grab('function qoderContextWindowOf(raw) {', '\n}'),
  grab('function qoderEffortProfileOf(raw) {', '\n}'),
  grab('function qoderPromotionOf(raw) {', '\n}'),
  grab('function qoderModelFromRemote(raw) {', '\n}'),
  grab('function qoderCatalogFromRemote(document) {', '\n}'),
].join('\n')

interface RemoteModel {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly supportsImage: boolean
  readonly supportsThinking: boolean
  readonly isFree?: boolean
  readonly priceFactor: number
  readonly originalPriceFactor?: number
  readonly efforts?: readonly string[]
  readonly defaultEffort?: string
  readonly supportsDisable?: boolean
  readonly promotion?: {
    readonly active: boolean
    readonly discountFactor: number
    readonly beforePromotionPriceFactor: number
    readonly windowStart?: string
    readonly windowEnd?: string
    readonly badgeZh?: string
  }
}

const api = new Function(
  `"use strict";${DECLARATIONS}
   return { qoderContextWindowOf, qoderEffortProfileOf, qoderPromotionOf, qoderModelFromRemote, qoderCatalogFromRemote };`,
)() as {
  qoderContextWindowOf: (raw: unknown) => number | undefined
  qoderEffortProfileOf: (raw: unknown) => {
    efforts?: string[]
    defaultEffort?: string
    supportsDisable: boolean
  }
  qoderPromotionOf: (raw: unknown) => RemoteModel['promotion'] | undefined
  qoderModelFromRemote: (raw: unknown) => RemoteModel | undefined
  qoderCatalogFromRemote: (document: unknown) => RemoteModel[]
}

/** A live `chat` entry, trimmed to the fields the mapper reads. */
const ULTIMATE = {
  key: 'ultimate',
  status: 'idle',
  format: 'openai',
  source: 'system',
  enable: true,
  display_name: 'Ultimate',
  is_vl: true,
  is_reasoning: true,
  is_default: false,
  is_free: false,
  price_factor: 0.4,
  max_input_tokens: 1000000,
  context_config: {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
    '400K': { token_count: 400000 },
  },
  thinking_config: {
    enabled: {
      efforts: { xhigh: {}, high: { is_default: true }, low: {}, max: {}, medium: {} },
      is_default: true,
    },
  },
  promotion: {
    active: true,
    badge: { en: 'Off-Peak 80% off', zh: '错峰2折' },
    description: { en: '', zh: '' },
    timezone: 'Asia/Singapore',
    rule_id: 'idle_time_model_credit_discount',
    discount_factor: 0.2,
    before_promotion_price_factor: 2,
    link_url: { en: '', zh: '' },
    window_start: '22:00',
    window_end: '08:00',
  },
}

describe('qoder remote catalogue mapping', () => {
  it('takes the widest context tier, not max_input_tokens', () => {
    // The two fields disagree in the live catalogue: `efficient` reports
    // max_input_tokens 200000 and only a 200K tier (both agree), but `auto`
    // reports 200000 while shipping a 1M tier — and the official client only
    // ever consults the tier table.
    expect(api.qoderContextWindowOf(ULTIMATE)).toBe(1_000_000)
    expect(api.qoderContextWindowOf({
      max_input_tokens: 180_000,
      context_config: { '1M': { token_count: 1_000_000 }, '200K': { token_count: 200_000 } },
    })).toBe(1_000_000)
    expect(api.qoderContextWindowOf({
      max_input_tokens: 180_000,
      context_config: { '200K': { token_count: 200_000, is_default: true } },
    })).toBe(200_000)
    // `kmodel` ships no max_input_tokens at all; dropping the model's context
    // would make DSH compress far earlier than the vendor does.
    expect(api.qoderContextWindowOf({ context_config: { '1M': { token_count: 1_000_000 } } }))
      .toBe(1_000_000)
    // Nothing usable: the caller must then omit `context` rather than invent 0.
    expect(api.qoderContextWindowOf({})).toBeUndefined()
  })

  it('reads efforts and the default off thinking_config', () => {
    expect(api.qoderEffortProfileOf(ULTIMATE)).toEqual({
      efforts: ['xhigh', 'high', 'low', 'max', 'medium'],
      defaultEffort: 'high',
      supportsDisable: false,
    })
    // A `disabled` branch is the only evidence that the model can be told not
    // to think (`dmodel`, `qmodel_38max`, `dfmodel`).
    expect(api.qoderEffortProfileOf({
      thinking_config: {
        enabled: { efforts: { high: {}, max: { is_default: true } }, is_default: true },
        disabled: {},
      },
    })).toEqual({ efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true })
    // `mmodel` / `auto` ship no thinking_config: no picker, and no disable flag.
    expect(api.qoderEffortProfileOf({})).toEqual({
      efforts: undefined,
      defaultEffort: undefined,
      supportsDisable: false,
    })
    // An `enabled` block with no efforts (CN `qmodel_latest`) means "off is the
    // only choice" — not "every effort".
    expect(api.qoderEffortProfileOf({
      thinking_config: { enabled: { is_default: true }, disabled: {} },
    }).efforts).toBeUndefined()
  })

  it('keeps the default effort inside the effort list', () => {
    // DSH sends defaultEffort verbatim; a value outside efforts raises
    // UNSUPPORTED_REASONING_EFFORT on the first call, so the mapper must never
    // emit one even when the vendor's payload is inconsistent.
    const model = api.qoderModelFromRemote({
      ...ULTIMATE,
      thinking_config: {
        enabled: { efforts: { low: {}, medium: {} }, is_default: true },
        // is_default on an effort that is not in the list
        disabled: {},
      },
    })
    expect(model?.defaultEffort).toBeUndefined()
    expect(model?.efforts).toEqual(['low', 'medium'])
  })

  it('maps promotion into the shape qoderDisplayName reads', () => {
    expect(api.qoderPromotionOf(ULTIMATE)).toEqual({
      active: true,
      discountFactor: 0.2,
      beforePromotionPriceFactor: 2,
      windowStart: '22:00',
      windowEnd: '08:00',
      badgeZh: '错峰2折',
    })
    // Promotions without the two numbers cannot be rendered as "x2→x0.4".
    expect(api.qoderPromotionOf({ promotion: { active: true, badge: { zh: 'x' } } })).toBeUndefined()
    expect(api.qoderPromotionOf({})).toBeUndefined()
  })

  it('maps a whole entry onto the fallback-table shape', () => {
    expect(api.qoderModelFromRemote(ULTIMATE)).toEqual({
      id: 'ultimate',
      name: 'Ultimate',
      contextWindow: 1_000_000,
      supportsImage: true,
      supportsThinking: true,
      priceFactor: 0.4,
      efforts: ['xhigh', 'high', 'low', 'max', 'medium'],
      defaultEffort: 'high',
      promotion: {
        active: true,
        discountFactor: 0.2,
        beforePromotionPriceFactor: 2,
        windowStart: '22:00',
        windowEnd: '08:00',
        badgeZh: '错峰2折',
      },
    })
    // Free models keep `priceFactor: 0` — zero is a price, not a missing field.
    const free = api.qoderModelFromRemote({
      key: 'dfmodel',
      display_name: 'DeepSeek-Flash',
      is_vl: true,
      is_reasoning: true,
      is_free: true,
      price_factor: 0,
      original_price_factor: 0.1,
      context_config: { '1M': { token_count: 1_000_000 } },
    })
    expect(free?.priceFactor).toBe(0)
    expect(free?.isFree).toBe(true)
    expect(free?.originalPriceFactor).toBe(0.1)
    // Anything without a key cannot be addressed by the model picker.
    expect(api.qoderModelFromRemote({ display_name: 'X' })).toBeUndefined()
  })

  it('reads only the chat scene and drops disabled entries', () => {
    const models = api.qoderCatalogFromRemote({
      chat: [
        { ...ULTIMATE },
        { key: 'gone', display_name: 'Gone', enable: false },
        { display_name: 'No key' },
      ],
      // Every other scene is a different product surface; `assistant` happens to
      // mirror `chat` today, and `qwake` carries a model chat does not.
      assistant: [{ key: 'should-not-appear', display_name: 'Nope' }],
      qwake: [{ key: 'performance', display_name: 'Performance' }],
    })
    expect(models.map(model => model.id)).toEqual(['ultimate'])
    // A malformed or empty answer must not silently empty the catalogue: the
    // caller treats an empty list as a failure and keeps the old one.
    expect(api.qoderCatalogFromRemote({})).toEqual([])
    expect(api.qoderCatalogFromRemote(undefined)).toEqual([])
  })
})

describe('qoder adapter catalogue wiring', () => {
  it('reads the instance catalogue rather than the shared product constant', () => {
    // `product` is a module-level object (QODER / QODER_CN). Writing
    // `this.product.fallbackModels` on refresh would leak one instance's
    // catalogue into the other channel's card.
    const adapter = source.slice(
      source.indexOf('var QoderAdapter = class extends LlmAdapter4 {'),
      source.indexOf('function registerQoderLlm('),
    )
    expect(adapter.length).toBeGreaterThan(1_000)
    expect(adapter).toContain('this.models = this.staticModels')
    expect(adapter).toContain('return this.models.map((model) => ({ id: model.id, name: qoderDisplayName(model) }))')
    expect(adapter).toContain('const source = this.models;')
    expect(adapter).not.toContain('this.product.fallbackModels.map')
  })

  it('replaces the index and the list together on refresh', () => {
    // `stream` and `resolveModel` read `fallbackIndex` while the picker reads
    // `models`; updating one without the other shows a new name against old
    // capabilities (wrong context window, wrong thinking flag).
    const refresh = source.slice(
      source.indexOf('async refreshRemoteCatalog({ force = false, signal } = {}) {'),
      source.indexOf('async ensureUid(credential) {'),
    )
    expect(refresh).toContain('this.models = models')
    expect(refresh).toContain('this.fallbackIndex = new Map(models.map((model) => [model.id, model]))')
    expect(refresh).toContain('if (force) this.catalogGate.reset()')
  })

  it('registers model.refresh as a pack method the client may call', () => {
    expect(source).toContain('case "model.refresh": {')
    expect(source).toContain('await adapter.refreshRemoteCatalog({ force: true })')
  })
})
