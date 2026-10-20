import { describe, expect, it } from 'vitest'
import {
  contextWindowChoice,
  formatModelCapacity,
  modelFactsFor,
  modelFigureLine,
  type ModelFacts,
} from '../src/client/model-facts.ts'
import { modelListsFrom } from '../src/client/channel-rpc.ts'

/**
 * The rule these tests exist to hold: the facts layer prints what it was given
 * and nothing else.
 *
 * Three quarters of the aggregate registry's model rows carry no window, no
 * image flag and no thinking levels at all, so "absent" is the common case, not
 * the edge case. A default that filled those in would make the card confident
 * and wrong about models this plugin has never asked anything.
 */
describe('reads only the facts a model row actually carries', () => {
  it('keeps nothing for a row that declares nothing', () => {
    expect(modelFactsFor({})).toEqual({})
  })

  it('ignores values of the wrong type instead of printing them', () => {
    expect(modelFactsFor({
      contextWindow: '1048576',
      maxOutputTokens: null,
      supportsImages: 'yes',
      supportedEfforts: 'high',
      description: 42,
    })).toEqual({})
  })

  it('drops a zero or negative window, which is a mistake rather than a size', () => {
    expect(modelFactsFor({ contextWindow: 0 }).contextWindow).toBeUndefined()
    expect(modelFactsFor({ contextWindow: -8 }).contextWindow).toBeUndefined()
  })

  it('keeps a positive window and output ceiling', () => {
    expect(modelFactsFor({ contextWindow: 131072, maxOutputTokens: 32768 })).toEqual({
      contextWindow: 131072,
      maxOutputTokens: 32768,
    })
  })

  it('reads an explicit "no images" as a fact, not as an absence', () => {
    // Three states, not two: unknown, images, text-only. An explicit false is
    // the upstream telling us the model is text-only, and rendering it as a gap
    // would make a text-only model look like one nobody has described.
    expect(modelFactsFor({ supportsImages: true }).vision).toBe(true)
    expect(modelFactsFor({ vision: true }).vision).toBe(true)
    expect(modelFactsFor({ supportsImages: false }).vision).toBe(false)
    expect(modelFactsFor({ supportsImages: 'true' }).vision).toBeUndefined()
    expect(modelFactsFor({ vision: 'true' }).vision).toBeUndefined()
    expect(modelFactsFor({}).vision).toBeUndefined()
  })

  it('lets the pool-lane spelling win over the registry spelling', () => {
    // `supportsImages` is what the pool lane publishes; `vision` is what the
    // registry publishes. A row carrying both comes from a merge, and the
    // post-toggle spelling is the one the served row actually has.
    expect(modelFactsFor({ supportsImages: false, vision: true }).vision).toBe(false)
    expect(modelFactsFor({ supportsImages: true, vision: false }).vision).toBe(true)
  })

  it('keeps only a non-empty list of thinking levels', () => {
    expect(modelFactsFor({ supportedEfforts: ['low', 'high'] }).supportedEfforts).toEqual(['low', 'high'])
    expect(modelFactsFor({ supportedEfforts: [] }).supportedEfforts).toBeUndefined()
    expect(modelFactsFor({ supportedEfforts: [1, 'high'] }).supportedEfforts).toEqual(['high'])
    expect(modelFactsFor({ supportedEfforts: 'high' }).supportedEfforts).toBeUndefined()
  })

  it('falls back to the provider note when the model has no description of its own', () => {
    expect(modelFactsFor({ notes: 'Daily free credit.' }).description).toBe('Daily free credit.')
    // A description of its own is the closer thing to the model, so it wins.
    expect(modelFactsFor({ description: 'A model', notes: 'A vendor.' }).description).toBe('A model')
  })

  it('drops a description that is empty or only whitespace', () => {
    expect(modelFactsFor({ description: '' }).description).toBeUndefined()
    expect(modelFactsFor({ description: '   ' }).description).toBeUndefined()
  })
})

describe('reads a window the way a person would say it out loud', () => {
  it('leaves anything under a thousand as plain digits', () => {
    expect(formatModelCapacity(999)).toBe('999')
  })

  it('says thousands to one decimal only when there is a decimal to say', () => {
    expect(formatModelCapacity(1000)).toBe('1K')
    expect(formatModelCapacity(1536)).toBe('1.5K')
    expect(formatModelCapacity(131072)).toBe('131K')
  })

  it('stops printing decimals once the digits would be noise', () => {
    // 131K, not 131.1K: the card is 510px wide and a decimal nobody can act on
    // only makes two numbers of the same size look different.
    expect(formatModelCapacity(131_100)).toBe('131K')
    expect(formatModelCapacity(999_900)).toBe('1000K')
  })

  it('refuses to print a size it was handed rather than formatting the rubbish', () => {
    // An em dash is the same mark the rest of the card uses for "no figure", so
    // a bad number reads as absent instead of as a fabricated one.
    expect(formatModelCapacity(0)).toBe('—')
    expect(formatModelCapacity(-1)).toBe('—')
    expect(formatModelCapacity(Number.NaN)).toBe('—')
  })

  it('switches to millions at a million, which is where people stop counting in K', () => {
    expect(formatModelCapacity(1_000_000)).toBe('1M')
    expect(formatModelCapacity(1_048_576)).toBe('1.05M')
    expect(formatModelCapacity(2_000_000)).toBe('2M')
  })

  it('rounds to two decimals rather than pretending to more precision than it has', () => {
    // 1_234_567 -> 1.23M, not 1.234567M: the extra digits are noise, and a
    // window printed to six decimals reads as a claim this plugin cannot back.
    expect(formatModelCapacity(1_234_567)).toBe('1.23M')
  })
})

describe('turns facts into the line the card prints', () => {
  it('says nothing at all for a row that carried nothing', () => {
    expect(modelFigureLine({})).toEqual({})
  })

  it('carries the window, the ceiling and the levels through', () => {
    const line = modelFigureLine({
      contextWindow: 131072,
      maxOutputTokens: 32768,
      vision: true,
      supportedEfforts: ['low', 'high'],
    })
    expect(line.context).toBe('131K')
    expect(line.output).toBe('32.8K')
    expect(line.vision).toBe('both')
    expect(line.efforts).toBe('low / high')
  })

  it('says text rather than leaving the figure out', () => {
    // Absent here would read as "the plugin does not know", and the row does
    // know: it said the model takes images and nothing else was claimed about
    // text, so text-only is the honest reading.
    expect(modelFigureLine({ vision: false }).vision).toBe('text')
  })

  it('prints a published window at the size the model publishes', () => {
    // This line used to clamp anything above 131 072 down to that number, on
    // the theory that the pool lane served nothing larger. It does serve larger
    // windows, so the clamp printed "131K" beside a model the picker in the same
    // row offered at 1M, and the two figures contradicted each other.
    expect(modelFigureLine({ contextWindow: 4_000_000 }).context).toBe(formatModelCapacity(4_000_000))
    expect(modelFigureLine({ contextWindow: 1_000_000 }).context).toBe('1M')
    expect(modelFigureLine({ contextWindow: 131_072 }).context).toBe('131K')
  })
})

describe('resolves the context-window picker for a row the pack sent', () => {
  const DEFAULT_BUDGET = 200_000

  it('serves the full native window when no cap was ever set', () => {
    // The pack sends neither nativeContextWindow nor contextBudget until the
    // user narrows the model, so "no cap" has to read as "full window". Reading
    // it as the conservative default left no radio selected for the full figure
    // and made a 1M model look stuck at 200K.
    const choice = contextWindowChoice({ contextWindow: 1_000_000 }, DEFAULT_BUDGET)
    expect(choice.native).toBe(1_000_000)
    expect(choice.budget).toBe(1_000_000)
    expect(choice.capped).toBe(true)
  })

  it('reads the stored cap when one exists', () => {
    const choice = contextWindowChoice(
      { contextWindow: DEFAULT_BUDGET, nativeContextWindow: 1_000_000, contextBudget: DEFAULT_BUDGET },
      DEFAULT_BUDGET,
    )
    expect(choice.native).toBe(1_000_000)
    expect(choice.budget).toBe(DEFAULT_BUDGET)
    expect(choice.capped).toBe(true)
  })

  it('offers no picker for a model that cannot be narrowed', () => {
    expect(contextWindowChoice({ contextWindow: DEFAULT_BUDGET }, DEFAULT_BUDGET).capped).toBe(false)
    expect(contextWindowChoice({ contextWindow: 8_192 }, DEFAULT_BUDGET).capped).toBe(false)
  })

  it('offers no picker when the row published no window at all', () => {
    const choice = contextWindowChoice({}, DEFAULT_BUDGET)
    expect(choice).toEqual({ native: undefined, capped: false, budget: undefined })
  })
})

describe('reads a model list off the wire without believing it', () => {
  it('answers nothing at all for a body that is not a list', () => {
    // An empty map is not "every channel has no models". It is "nothing was
    // readable here", and the page draws no rows for either -- but only the
    // second reading is true when the body turned out to be an error page.
    expect(modelListsFrom(undefined).size).toBe(0)
    expect(modelListsFrom(null).size).toBe(0)
    expect(modelListsFrom('nope').size).toBe(0)
    expect(modelListsFrom({}).size).toBe(0)
    expect(modelListsFrom({ models: null }).size).toBe(0)
    expect(modelListsFrom({ models: 'nope' }).size).toBe(0)
  })

  it('groups the rows under the provider that published them', () => {
    const lists = modelListsFrom({
      models: {
        zcode: [{ id: 'glm-4', name: 'GLM 4', contextWindow: 131072 }],
        codearts: [{ id: 'deepseek-v3', name: 'DeepSeek V3' }],
      },
    })
    expect([...lists.keys()].sort()).toEqual(['codearts', 'zcode'])
    expect(lists.get('zcode')?.[0]?.contextWindow).toBe(131072)
  })

  it('keeps an empty list as an empty list rather than dropping the provider', () => {
    // Present-but-empty and absent mean different things: signed in with
    // nothing to serve, versus no answer at all. Collapsing them would draw a
    // signed-out channel as a signed-in channel with no models.
    const lists = modelListsFrom({ models: { gemini: [] } })
    expect(lists.has('gemini')).toBe(true)
    expect(lists.get('gemini')).toEqual([])
  })

  it('falls back to the id when a model has no name, so it is still clickable', () => {
    const lists = modelListsFrom({ models: { gemini: [{ id: 'ghost-1' }] } })
    expect(lists.get('gemini')?.[0]?.name).toBe('ghost-1')
  })

  it('drops rows with no usable id rather than printing an empty button', () => {
    const lists = modelListsFrom({
      models: { gemini: [{ id: '' }, { name: 'no id' }, { id: 7 }, null, 'text'] },
    })
    expect(lists.get('gemini')).toEqual([])
  })

  it('drops a window or ceiling that is not a usable size', () => {
    const lists = modelListsFrom({
      models: {
        gemini: [
          { id: 'a', contextWindow: 0, maxTokens: -1 },
          { id: 'b', contextWindow: Number.NaN, maxTokens: Number.POSITIVE_INFINITY },
          { id: 'c', contextWindow: 131072, maxTokens: 32768 },
        ],
      },
    })
    expect(lists.get('gemini')?.map(row => row.id)).toEqual(['a', 'b', 'c'])
    expect(lists.get('gemini')?.[0]?.contextWindow).toBeUndefined()
    expect(lists.get('gemini')?.[1]?.maxTokens).toBeUndefined()
    expect(lists.get('gemini')?.[2]?.contextWindow).toBe(131072)
  })

  it('keeps only the modalities that are strings', () => {
    const lists = modelListsFrom({
      models: { gemini: [{ id: 'a', inputModalities: ['text', 'image', 3, null] }] },
    })
    expect(lists.get('gemini')?.[0]?.inputModalities).toEqual(['text', 'image'])
  })

  it('does not leave a description field behind when the row had none', () => {
    // An absent field and an empty string are different JSON, and the component
    // reads "is there a description" rather than "is it non-empty" in one place
    // and "is it truthy" in another.
    const lists = modelListsFrom({ models: { gemini: [{ id: 'a' }] } })
    expect('description' in (lists.get('gemini')?.[0] ?? {})).toBe(false)
  })
})