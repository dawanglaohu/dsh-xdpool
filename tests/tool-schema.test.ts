import { describe, expect, it } from 'vitest'
import { sanitiseToolSchemas } from '../src/tool-schema.ts'

/**
 * The gateway refuses a whole request when a tool schema uses a construct it
 * does not implement, and reports it as "the model cannot handle this request"
 * — which points at the model, not at the tool definitions that caused it.
 * These cases pin the rewrite to the shapes measured against the live gateway.
 */

function body(tools: unknown[]): Record<string, unknown> {
  return { model: 'kimi-k3.1-pro', messages: [{ role: 'user', content: 'hi' }], tools }
}

function params(schema: Record<string, unknown>): Record<string, unknown> {
  return schema
}

describe('tool schema repair', () => {
  it('drops a union that names no type, and keeps the type when every variant agrees', () => {
    const payload = body([
      {
        type: 'function',
        function: {
          name: 'a',
          parameters: {
            type: 'object',
            properties: {
              plain: { oneOf: [{ type: 'object' }, { type: 'object' }] },
              mixed: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            },
          },
        },
      },
    ])
    expect(sanitiseToolSchemas(payload)).toBe(true)
    const out = payload['tools'] as { function: { parameters: { properties: Record<string, Record<string, unknown>> } } }[]
    const props = out[0].function.parameters.properties
    expect(props['plain']).toEqual({ type: 'object' })
    expect(props['mixed']).toEqual({})
    expect(JSON.stringify(payload)).not.toContain('oneOf')
  })

  it('inlines a $ref instead of leaving a bare description where the shape was', () => {
    const payload = body([
      {
        type: 'function',
        function: {
          name: 'a',
          parameters: {
            type: 'object',
            $defs: {
              inner: { type: 'object', properties: { depth: { type: 'number' } }, required: ['depth'] },
            },
            properties: {
              nested: { description: 'the nested one', $ref: '#/$defs/inner' },
            },
          },
        },
      },
    ])
    expect(sanitiseToolSchemas(payload)).toBe(true)
    const out = payload['tools'] as { function: { parameters: { properties: Record<string, Record<string, unknown>> } } }[]
    const nested = out[0].function.parameters.properties['nested']
    expect(nested['type']).toBe('object')
    expect(nested['description']).toBe('the nested one')
    expect(nested['properties']).toEqual({ depth: { type: 'number' } })
    expect(JSON.stringify(payload)).not.toContain('$ref')
    expect(JSON.stringify(payload)).not.toContain('$defs')
  })

  it('removes a dangling $ref rather than forwarding an unresolvable pointer', () => {
    const payload = body([
      { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: { x: { $ref: '#/$defs/missing', description: 'gone' } } } } },
    ])
    expect(sanitiseToolSchemas(payload)).toBe(true)
    const out = payload['tools'] as { function: { parameters: { properties: Record<string, unknown> } } }[]
    expect(out[0].function.parameters.properties['x']).toEqual({ description: 'gone' })
    expect(JSON.stringify(payload)).not.toContain('$ref')
  })

  it('names the type of an untyped enum and keeps the values', () => {
    const payload = body([
      {
        type: 'function',
        function: {
          name: 'a',
          parameters: { type: 'object', properties: { mode: { enum: ['fast', 'slow'] }, any: { enum: ['a', 1] } } },
        },
      },
    ])
    expect(sanitiseToolSchemas(payload)).toBe(true)
    const out = payload['tools'] as { function: { parameters: { properties: Record<string, Record<string, unknown>> } } }[]
    expect(out[0].function.parameters.properties['mode']).toEqual({ type: 'string', enum: ['fast', 'slow'] })
    expect(out[0].function.parameters.properties['any']).toEqual({ enum: ['a', 1] })
  })

  it('leaves the keywords the gateway accepts exactly as it found them', () => {
    const kept = {
      type: 'object',
      properties: {
        a: { type: 'string', const: 'fixed' },
        b: { type: 'array', items: { type: 'string' }, minItems: 1 },
        c: { type: 'object', allOf: [{ type: 'object' }], not: { type: 'null' } },
        d: { type: 'object', dependentRequired: { a: ['b'] } },
      },
      additionalProperties: false,
      examples: [{ a: 'fixed' }],
    }
    const payload = body([{ type: 'function', function: { name: 'a', parameters: JSON.parse(JSON.stringify(kept)) } }])
    expect(sanitiseToolSchemas(payload)).toBe(false)
    const out = payload['tools'] as { function: { parameters: unknown } }[]
    expect(out[0].function.parameters).toEqual(kept)
  })

  it('reports no change for a schema the gateway already accepts', () => {
    const payload = body([
      { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    ])
    expect(sanitiseToolSchemas(payload)).toBe(false)
  })

  it('ignores a body with no tools, a non-array tools value, or malformed entries', () => {
    expect(sanitiseToolSchemas({ model: 'x', messages: [] })).toBe(false)
    expect(sanitiseToolSchemas({ tools: 'nope' })).toBe(false)
    expect(sanitiseToolSchemas({ tools: [null, 3, { type: 'function' }, { type: 'function', function: { name: 'a' } }] })).toBe(false)
  })

  it('stops inlining at a cycle instead of expanding for ever', () => {
    const payload = body([
      {
        type: 'function',
        function: {
          name: 'a',
          parameters: {
            type: 'object',
            $defs: { loop: { type: 'object', properties: { again: { $ref: '#/$defs/loop' } } } },
            properties: { start: { $ref: '#/$defs/loop' } },
          },
        },
      },
    ])
    expect(sanitiseToolSchemas(payload)).toBe(true)
    const text = JSON.stringify(payload)
    expect(text).not.toContain('$ref')
    // The cycle is cut, not unrolled: the pointer is gone and nothing recursed.
    expect(text.length).toBeLessThan(1000)
  })

  it('degrades an enormous inlined schema to names and descriptions', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 400; i += 1) {
      properties[`p${i}`] = { description: `parameter ${i}`, type: 'string' }
    }
    const payload = body([
      { type: 'function', function: { name: 'huge', parameters: { type: 'object', properties, required: ['p0'] } } },
    ])
    // Under the ceiling, so it survives intact rather than degrading.
    expect(sanitiseToolSchemas(payload)).toBe(false)
    expect(JSON.stringify(payload).length).toBeGreaterThan(10_000)
  })
})
