/**
 * The international roster's one non-shared row, and the gap that hid it.
 *
 * ## The failure this file pins down
 *
 * A user with the international gateway signed in tested
 * `deepseek-v4.1-flash-sg` from the pool card and got
 *
 *   pi-ai provider "xdpool-global" has no configured model
 *   "deepseek-v4.1-flash-sg"
 *
 * The model was fine. `/v3/config` was advertising it, the shim was listing it,
 * and the gateway answered it. What happened is that the card renders
 * `WorkBuddyCatalog.current()` — the WHOLE catalog — while the pi-ai provider
 * serves `WorkBuddyCatalog.visible()`, which applies the user's saved
 * `enabledModelIds` whitelist. The row was not in that whitelist, so the
 * provider never registered it, and the host reported the absence as a
 * property of the MODEL.
 *
 * Three separate things had to be true for that to be unfixable in the field:
 *
 *   1. the static fallback table carried no `-sg` row at all, so any boot whose
 *      `/v3/config` fetch failed lost the model outright;
 *   2. the two lists could disagree with no explanation anywhere;
 *   3. the connection test reported the host's message verbatim, which points
 *      at the model rather than at the switch.
 *
 * Each has a test below. The live values are the ones captured from
 * `https://www.workbuddy.ai/v3/config`:
 *
 *   { contextWindow: { defaultLength: 300000,
 *                      supportedLengths: [300000, 1000000] },
 *     credits: "x0.03", id: "deepseek-v4.1-flash-sg",
 *     maxAllowedSize: 1000000, maxInputTokens: 1000000,
 *     maxOutputTokens: 128000, name: "Deepseek-V4.1-Flash",
 *     reasoning: { supportedEfforts: ["low", "high", "max"] },
 *     supportsImages: true, supportsReasoning: true, supportsToolCalls: true }
 */

import { describe, expect, it } from 'vitest'
import {
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  catalogFromUpstream,
  describeModelRouteGap,
  fallbackModelsFor,
  modelRouteGap,
} from '../src/catalog.ts'
import type { WorkBuddyUpstreamModel } from '../src/upstream.ts'

const SG = 'deepseek-v4.1-flash-sg'

/** The live `/v3/config` entry, in the shape `fetchModels` hands the catalog. */
const liveSg: WorkBuddyUpstreamModel = {
  id: SG,
  name: 'Deepseek-V4.1-Flash',
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  supportsImages: true,
  creditMultiplier: 0.03,
  reasoning: { supportedEfforts: ['low', 'high', 'max'] },
} as WorkBuddyUpstreamModel

/** A live roster that does NOT name the row, standing in for a CN answer. */
const liveWithoutSg: WorkBuddyUpstreamModel[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, maxTokens: 48_000 },
] as WorkBuddyUpstreamModel[]

describe('the international fallback carries the row only that gateway sells', () => {
  it('names deepseek-v4.1-flash-sg with the fields the gateway publishes', () => {
    const row = fallbackModelsFor('global').find(model => model.id === SG)
    expect(row, 'the global fallback must carry the -sg row').toBeDefined()
    // `supportedLengths` max, not `defaultLength`: resolveContextWindow takes the
    // largest length the row admits, which is what pi-ai then compacts against.
    expect(row?.contextWindow).toBe(1_000_000)
    expect(row?.maxOutputTokens).toBe(128_000)
    expect(row?.supportsImages).toBe(true)
    expect(row?.multiplier).toBe(0.03)
    expect(row?.supportedEfforts).toEqual(['low', 'high', 'max'])
  })

  it('does NOT put it in the domestic table, which answers 11102 for it', () => {
    // The CN gateway does not advertise this id; offering it there would be a
    // row that exists only to fail. This is why the row is appended to the
    // global table instead of merged into the shared one.
    expect(FALLBACK_WORKBUDDY_MODELS.some(model => model.id === SG)).toBe(false)
  })

  it('keeps every shared row, so a degraded picker is still the old picker', () => {
    const cn = new Set(FALLBACK_WORKBUDDY_MODELS.map(model => model.id))
    const global = fallbackModelsFor('global').map(model => model.id)
    for (const id of cn) expect(global).toContain(id)
    expect(global.length).toBe(cn.size + 1)
  })
})

describe('the live merge keeps the row exactly once', () => {
  it('takes the live row when the gateway names it', () => {
    const merged = catalogFromUpstream([liveSg], 'global')
    expect(merged.filter(model => model.id === SG)).toHaveLength(1)
    expect(merged.find(model => model.id === SG)?.multiplier).toBe(0.03)
  })

  it('appends the static row when a healthy roster omits it', () => {
    // The whole point of the append rule: `/v3/config` naming 13 rows must not
    // delete the rows an exhausted account depends on.
    const merged = catalogFromUpstream(liveWithoutSg, 'global')
    expect(merged.find(model => model.id === SG)?.contextWindow).toBe(1_000_000)
  })

  it('never withholds it from the merge', () => {
    // GLOBAL_WITHHELD_IDS exists for ids the gateway was measured REFUSING.
    // This one answers, so it must not have been added there by mistake.
    expect(catalogFromUpstream(liveWithoutSg, 'global').some(model => model.id === SG)).toBe(true)
  })
})

describe('a model the card lists but the provider does not serve is named as such', () => {
  /** A global catalog holding the live roster. */
  function liveCatalog(): WorkBuddyCatalog {
    const catalog = new WorkBuddyCatalog('global')
    catalog.updateFromUpstream([liveSg, ...liveWithoutSg])
    return catalog
  }

  it('reports the selection as the reason when the row is switched off', () => {
    const catalog = liveCatalog()
    catalog.applySelection({ enabledModelIds: ['glm-5.3'] })
    // The row is still IN the catalog — this is what the card draws.
    expect(catalog.current().some(model => model.id === SG)).toBe(true)
    // ...but it is not what the provider registers.
    expect(catalog.visible().some(model => model.id === SG)).toBe(false)
    expect(modelRouteGap(catalog, SG)).toBe('disabled-by-selection')
  })

  it('reports nothing when the row is enabled', () => {
    const catalog = liveCatalog()
    catalog.applySelection({ enabledModelIds: ['glm-5.3', SG] })
    expect(modelRouteGap(catalog, SG)).toBeUndefined()
  })

  it('reports nothing when the selection is absent, i.e. everything is on', () => {
    const catalog = liveCatalog()
    catalog.applySelection({})
    expect(modelRouteGap(catalog, SG)).toBeUndefined()
  })

  it('separates an id no roster knows from a switched-off one', () => {
    // A stale session or a hand-edited config names ids this gateway never had.
    // Saying "enable it in the list" for one of those would send the user
    // looking for a checkbox that does not exist.
    const catalog = liveCatalog()
    catalog.applySelection({ enabledModelIds: ['glm-5.3'] })
    expect(modelRouteGap(catalog, 'no-such-model')).toBe('not-in-catalog')
  })

  it('answers from the fallback roster too, so the diagnosis survives a dead fetch', () => {
    const catalog = new WorkBuddyCatalog('global')
    catalog.applySelection({ enabledModelIds: ['glm-5.3'] })
    expect(catalog.currentSource()).toBe('fallback')
    expect(modelRouteGap(catalog, SG)).toBe('disabled-by-selection')
  })
})

describe('the message names the switch, not the model', () => {
  it('points a switched-off row at the toggle that is off', () => {
    // The host's own wording for this state is `pi-ai provider "xdpool-global"
    // has no configured model "…"`, which is what made the row read as missing.
    // The replacement must not repeat that framing.
    const message = describeModelRouteGap('disabled-by-selection', SG, 'the international lane')
    expect(message).toContain(SG)
    expect(message).toContain('switched OFF')
    expect(message).toContain('model list')
    // And it must not be mistakable for the host's message.
    expect(message).not.toContain('has no configured model')
  })

  it('points an unknown id at the refresh button, not at a toggle that never existed', () => {
    // Saying "tick it in the list" for an id no roster has would send the user
    // hunting for a checkbox that is not there.
    const message = describeModelRouteGap('not-in-catalog', 'no-such-model', 'the domestic lane')
    expect(message).toContain('not in the domestic lane')
    expect(message).toContain('Refresh models')
    expect(message).not.toContain('switched OFF')
  })
})
