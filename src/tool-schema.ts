/**
 * Rewrite JSON Schema inside `tools[].function.parameters` into the subset the
 * WorkBuddy gateway accepts.
 *
 * The gateway refuses a whole request with HTTP 400 when a tool schema uses
 * keywords it does not implement. Measured against the live CN gateway with
 * `kimi-k3.1-pro`, one construct at a time, everything else held constant:
 *
 * | schema fragment                                  | result        |
 * | ------------------------------------------------ | ------------- |
 * | `{ oneOf: [...] }` with no sibling `type`         | 400 + 11133   |
 * | `{ anyOf: [...] }` with no sibling `type`         | 400 + 11133   |
 * | `{ enum: [...] }` with no sibling `type`          | 400 + 11133   |
 * | `$ref` resolving to any of the above              | 400 + 11133   |
 * | `$ref` resolving to nothing (dangling)            | 400 + 11133   |
 * | object nesting deeper than ~29 levels             | 400 + 11133   |
 * | the same fragments with a `type` present          | 200           |
 * | `const`, `allOf`, `not`, `dependentRequired`,     | 200           |
 * | `minProperties`, `$schema`, `examples`            |               |
 *
 * The failure is per-request, so one MCP server with an elaborate schema takes
 * every model in the session down with it: measured, a body that answered 200
 * with 107 tools answered 400 + 11133 the moment one MCP tool carrying
 * `oneOf`-without-`type` was appended. The plugin's own tools never look like
 * this, which is why the breakage tracks whichever MCP servers a session
 * happens to have enabled.
 *
 * The repair inlines `$ref` (bounded, cycle-safe) and then drops the keywords,
 * rather than only dropping them: dropping `$ref` alone leaves a bare
 * `{ description }` where a parameter's whole shape used to be, and the model
 * then has to guess the argument structure. Inlining first keeps the shape and
 * costs no extra request.
 */

/**
 * Keywords the gateway refuses. Kept to exactly the measured list: `$schema`,
 * `examples`, `dependentRequired`, `minProperties`, `not`, `allOf` and a typed
 * `const` were each sent on their own and all answered 200, so dropping them
 * would only take information away from the model.
 */
const UNSUPPORTED_KEYWORDS = new Set(['$defs', '$ref', 'oneOf', 'anyOf'])

/**
 * Ref-inlining ceiling. Measured: an object chain 28 levels deep answers 200,
 * 30 answers 400. The cap sits well under that so a schema written to the edge
 * of what the gateway tolerates still lands after inlining adds a level or two.
 */
const MAX_INLINE_DEPTH = 10

/**
 * Per-tool output ceiling. Inlining multiplies a heavily-shared `$defs` graph,
 * and a runaway result would trade one 400 for a body the gateway rejects for
 * size. Measured, 150 kB of tool definitions in one request is accepted, so the
 * ceiling is generous; past it the tool degrades to the shape-only form below.
 */
const MAX_TOOL_BYTES = 120_000

type Json = Record<string, unknown>

function isJsonObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve one `$ref` against the schema's own `$defs`.
 *
 * Returns `undefined` for anything this module cannot resolve — a ref into a
 * document it does not have, or a cycle already on the stack. Callers drop the
 * keyword in that case, which is exactly what a dangling ref needs.
 */
function resolveRef(ref: string, defs: Json, seen: ReadonlySet<string>): Json | undefined {
  const prefix = '#/$defs/'
  if (!ref.startsWith(prefix)) return undefined
  const key = ref.slice(prefix.length)
  if (seen.has(key)) return undefined
  const target = defs[key]
  return isJsonObject(target) ? target : undefined
}

/**
 * Name the JSON type of a literal list when every non-null member agrees.
 * `null` is skipped rather than treated as a fourth type: a mixed
 * `['a', null]` still describes a string parameter that may be absent.
 */
function inferTypeFromLiterals(values: readonly unknown[]): string | undefined {
  const kinds = new Set<string>()
  for (const value of values) {
    if (value === null) continue
    kinds.add(typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string')
  }
  return kinds.size === 1 ? [...kinds][0] : undefined
}

function inferTypeFromUnion(union: readonly unknown[], defs: Json): string | undefined {  const kinds = new Set<string>()
  for (const variant of union) {
    if (!isJsonObject(variant)) return undefined
    const resolved = typeof variant['$ref'] === 'string'
      ? resolveRef(variant['$ref'], defs, new Set())
      : variant
    if (resolved === undefined) return undefined
    const type = resolved['type']
    if (typeof type !== 'string') return undefined
    kinds.add(type)
  }
  return kinds.size === 1 ? [...kinds][0] : undefined
}

function walk(node: unknown, defs: Json, level: number, seen: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => walk(item, defs, level, seen))
  if (!isJsonObject(node)) return node

  const ref = node['$ref']
  if (typeof ref === 'string') {
    const target = level >= MAX_INLINE_DEPTH ? undefined : resolveRef(ref, defs, seen)
    if (target !== undefined) {
      const next = new Set(seen)
      next.add(ref.slice('#/$defs/'.length))
      const inlined = walk(target, defs, level + 1, next)
      // A sibling `description` written next to the `$ref` is the caller's own
      // wording for this position; the definition's own text describes the
      // shared shape. Keep the caller's.
      if (isJsonObject(inlined) && typeof node['description'] === 'string' && inlined['description'] === undefined) {
        inlined['description'] = node['description']
      }
      return inlined
    }
    const stripped: Json = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' || UNSUPPORTED_KEYWORDS.has(key)) continue
      stripped[key] = walk(value, defs, level, seen)
    }
    return stripped
  }

  const union = Array.isArray(node['oneOf'])
    ? node['oneOf'] as unknown[]
    : Array.isArray(node['anyOf'])
      ? node['anyOf'] as unknown[]
      : undefined

  const out: Json = {}
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue
    out[key] = walk(value, defs, level, seen)
  }
  // A union whose every member names the same type collapses to that type, so
  // the parameter keeps saying "object"/"string" instead of nothing at all.
  if (out['type'] === undefined && union !== undefined) {
    const inferred = inferTypeFromUnion(union, defs)
    if (inferred !== undefined) out['type'] = inferred
  }
  // `{ enum: ['a', 'b'] }` with no `type` is refused; with a `type` it is
  // accepted and means the same thing. Naming the type keeps the enumerated
  // values, which are the part the model actually needs.
  if (out['type'] === undefined && Array.isArray(out['enum'])) {
    const inferred = inferTypeFromLiterals(out['enum'] as unknown[])
    if (inferred !== undefined) out['type'] = inferred
  }
  return out
}

function sanitiseParameters(parameters: unknown): unknown {
  if (!isJsonObject(parameters)) return parameters
  const defs = isJsonObject(parameters['$defs']) ? parameters['$defs'] : {}
  const result = walk(parameters, defs, 0, new Set())
  if (!isJsonObject(result)) return parameters
  delete result['$defs']
  if (JSON.stringify(result).length > MAX_TOOL_BYTES) return shapeOnly(parameters)
  return result
}

/**
 * Last resort for a schema too large to inline: keep every top-level parameter
 * name and its own description, and say nothing about their structure. The
 * model can still call the tool; what it loses is the argument detail, which is
 * strictly better than the whole session failing on every request.
 */
function shapeOnly(parameters: Json): Json {
  const properties = isJsonObject(parameters['properties']) ? parameters['properties'] : {}
  const kept: Json = {}
  for (const [name, value] of Object.entries(properties)) {
    kept[name] = isJsonObject(value) && typeof value['description'] === 'string'
      ? { description: value['description'] }
      : {}
  }
  const required = Array.isArray(parameters['required'])
    ? (parameters['required'] as unknown[]).filter((name): name is string => typeof name === 'string' && kept[name] !== undefined)
    : []
  const out: Json = { type: 'object', properties: kept }
  if (required.length > 0) out['required'] = required
  return out
}

/**
 * Rewrite `body.tools` in place. Returns whether anything changed, so the
 * caller can log a rewrite without re-serialising to find out.
 */
export function sanitiseToolSchemas(body: Json): boolean {
  const tools = body['tools']
  if (!Array.isArray(tools)) return false
  let changed = false
  for (const tool of tools) {
    if (!isJsonObject(tool)) continue
    const fn = tool['function']
    if (!isJsonObject(fn)) continue
    const params = fn['parameters']
    if (!isJsonObject(params)) continue
    const next = sanitiseParameters(params)
    if (JSON.stringify(next) === JSON.stringify(params)) continue
    fn['parameters'] = next
    changed = true
  }
  return changed
}
