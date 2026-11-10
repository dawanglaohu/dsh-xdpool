/**
 * The model badge, and the display name that must not say the same thing twice.
 *
 * `dsh-llm` 0.2.2 gave `LlmModelInfo` an optional `badge` and the model picker
 * renders it as a coloured `Tag`. Before that, the host's own listing mapper
 * rebuilt every row from a fixed field list, so a badge could not have reached
 * the picker even if one had been published. The plugin therefore keeps TWO
 * channels and picks between them at runtime:
 *
 *   host keeps badges  -> promotions ride `badge`, the name keeps only the rate
 *   host drops badges   -> promotions stay appended to the name, as since 0.1.2
 *
 * What must never happen is both at once: `hy3` would then read
 * "免费 · 限时免费" next to a `限时免费` tag.
 */

import { describe, expect, it } from 'vitest'
import { badgeTone, displayBadge } from '../src/badges.ts'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/catalog.ts'

/** A shim stand-in: the adapter only asks it for a base URL and a token. */
function fakeShim(): Parameters<typeof createWorkBuddyAdapter>[0]['shim'] {
  return {
    ready: Promise.resolve(),
    baseUrl: () => 'http://127.0.0.1:1',
    token: () => 'loopback-secret',
    close: async () => {},
  } as unknown as Parameters<typeof createWorkBuddyAdapter>[0]['shim']
}

function poolAdapter(): ReturnType<typeof createWorkBuddyAdapter> {
  return createWorkBuddyAdapter({
    shim: fakeShim(),
    catalog: new WorkBuddyCatalog(),
    // The attachment hooks are the only reason the adapter wants a Context, and
    // no test here sends a request.
    ctx: { get: () => undefined } as unknown as Parameters<typeof createWorkBuddyAdapter>[0]['ctx'],
  })
}

function nameOf(adapter: ReturnType<typeof createWorkBuddyAdapter>, id: string): string {
  const model = adapter.buildModels().find(candidate => (candidate as { id: string }).id === id)
  expect(model, `${id} must be in the pool catalog`).toBeDefined()
  return (model as unknown as { name: string }).name
}

describe('a hex colour becomes one of the four picker tones', () => {
  it('reads the gateway palette by hue, not by literal value', () => {
    // The gateway writes promotions with these exact colours today; matching on
    // the hue means a re-themed red is still a warning instead of a silent
    // fall-through to neutral.
    expect(badgeTone('FF0000')).toBe('warning')
    expect(badgeTone('1E90FF')).toBe('info')
    expect(badgeTone('00A000')).toBe('success')
    expect(badgeTone('808080')).toBe('neutral')
  })

  it('falls back to neutral when there is no usable colour', () => {
    expect(badgeTone(undefined)).toBe('neutral')
    expect(badgeTone('not-a-colour')).toBe('neutral')
  })

  it('accepts the short and alpha forms the parser lets through', () => {
    // `parseBadgeTags` admits 3..8 hex digits, so the tone reader must not be
    // stricter than the tag reader or a valid badge would lose its colour.
    expect(badgeTone('F00')).toBe('warning')
    expect(badgeTone('FF000080')).toBe('warning')
  })
})

describe('the badge text merges both promo vocabularies', () => {
  it('keeps the gateway label and the legacy code label, in that order', () => {
    // `free` is the old bare code; `badge:限时免费` is the current spelling. A row
    // carrying both must print one label once, not the same fact twice.
    const badge = displayBadge(['free', 'badge:限时免费:#FF0000'], ['限时免费'])
    expect(badge?.text).toBe('限时免费')
  })

  it('joins distinct labels and takes the tone from the coloured one', () => {
    const badge = displayBadge(['badge:夜间折扣:#1E90FF'], ['限时免费'])
    expect(badge).toEqual({ text: '限时免费 · 夜间折扣', tone: 'info' })
  })

  it('is undefined when there is nothing to promote', () => {
    expect(displayBadge(['craft'])).toBeUndefined()
    expect(displayBadge(undefined, [])).toBeUndefined()
  })
})

describe('the pool lanes publish a badge on every promoted row', () => {
  it('publishes badges unconditionally, whatever the host does with them', async () => {
    // Publishing is how the probe LEARNS whether the host keeps badges, so it
    // cannot be conditional on already knowing the answer.
    const adapter = poolAdapter()
    const rows = await adapter.adapter.listModels('xdpool')
    const badged = rows.filter(row => (row as { badge?: unknown }).badge !== undefined)
    expect(badged.length).toBeGreaterThan(0)
    const ids = rows.map(row => row.id)
    for (const info of FALLBACK_WORKBUDDY_MODELS) {
      if (!(info.tags ?? []).some(tag => tag.startsWith('badge:'))) continue
      expect(ids, `${info.id} must be listed`).toContain(info.id)
    }
  })

  it('gives hy3 the gateway wording, not "免费"', async () => {
    // `hy3` is `multiplier: 0` AND `badge:限时免费`. The rate half would print
    // "免费"; the gateway's own label is the more informative of the two.
    const adapter = poolAdapter()
    const rows = await adapter.adapter.listModels('xdpool')
    const hy3 = rows.find(row => row.id === 'hy3')
    expect((hy3 as unknown as { badge?: { text: string } }).badge?.text).toBe('限时免费')
  })
})

describe('the display name carries promotions only on hosts without a badge channel', () => {
  it('starts on the name channel and keeps the rate there', () => {
    const adapter = poolAdapter()
    // `glm-5.2` is `x0.79` with `badge:夜间折扣`: both facts, both in the name.
    expect(nameOf(adapter, 'glm-5.2')).toBe('GLM-5.2 · x0.79 · 夜间折扣')
  })

  it('drops the promo words from the name once the host keeps badges', () => {
    const adapter = poolAdapter()
    adapter.setHostKeepsBadges(true)
    // The rate is a price, not a promotion: it stays. The promo label moved to
    // the badge, so repeating it here would draw it twice.
    expect(nameOf(adapter, 'glm-5.2')).toBe('GLM-5.2 · x0.79')
  })

  it('leaves an unpromoted paid row alone on both channels', () => {
    const adapter = poolAdapter()
    // `deepseek-v4-pro` is `x0.51` with no promo tag at all: switching channels
    // must not touch it, or the flag is leaking into rows it has no business in.
    const before = nameOf(adapter, 'deepseek-v4-pro')
    adapter.setHostKeepsBadges(true)
    expect(nameOf(adapter, 'deepseek-v4-pro')).toBe(before)
    expect(before).toBe('Deepseek-V4-Pro · x0.51')
  })

  it('survives being told the same thing twice', () => {
    const adapter = poolAdapter()
    adapter.setHostKeepsBadges(true)
    adapter.setHostKeepsBadges(true)
    expect(nameOf(adapter, 'glm-5.2')).toBe('GLM-5.2 · x0.79')
  })
})
