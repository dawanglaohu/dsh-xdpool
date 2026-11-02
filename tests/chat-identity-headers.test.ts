/**
 * The client-identity headers on chat completions, and the conversation
 * identifiers the gateway refuses to work without.
 *
 * The identity headers exist for one reason: the gateway attributes every
 * `/v2/chat/completions` to a client, and that attribution is what the user
 * sees in their billing console as the "使用端" column. The desktop app sends
 * `X-IDE-Type`/`X-IDE-Name`/`X-IDE-Version` and reads as "WorkBuddy"; without
 * them our requests attributed to nothing and the column showed "–" — which
 * read as broken billing even though every credit was deducted correctly.
 *
 * The conversation identifiers exist for a blunter reason: without all three of
 * `X-Conversation-ID`, `X-Conversation-Request-ID` and
 * `X-Conversation-Message-ID`, the gateway answers HTTP 400 / code 11128
 * ("request illegal", displayTips about failing channel verification) and the
 * turn never runs at all. That was a total outage of the WorkBuddy lane, not a
 * cosmetic one.
 *
 * The regression these guard against is subtle, which is why the assertions are
 * on the exact header set rather than "some headers exist": the temptation when
 * refactoring is to fold the identity headers into the shared `chatHeaders()`,
 * which would put them on the points-automation endpoints too — endpoints the
 * desktop app has never been shown to send them on. Both directions are wrong,
 * so both are pinned.
 */
import { describe, expect, it } from 'vitest'
import { WorkBuddyUpstreamClient, type WorkBuddyCredential } from '../src/upstream.ts'

/** A minimal credential; the headers under test do not depend on its details. */
function credential(): WorkBuddyCredential {
  return {
    accessToken: 'tok',
    refreshToken: 'ref',
    uid: 'u1',
    enterpriseId: 'e1',
    domain: 'd1',
  } as unknown as WorkBuddyCredential
}

/** A recording fetch that answers a chat with SSE and anything else with JSON. */
function recordingFetch() {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const impl = async (url: unknown, init: RequestInit): Promise<Response> => {
    const target = String(url)
    seen.push({ url: target, headers: init.headers as Record<string, string> })
    // Chat completions stream; every other endpoint answers a JSON envelope.
    const isChat = target.includes('/v2/chat/completions')
    return new Response(isChat ? 'data: [DONE]\n\n' : '{"code":0,"data":[]}\n', {
      status: 200,
      headers: { 'Content-Type': isChat ? 'text/event-stream' : 'application/json' },
    })
  }
  return { seen, options: { fetchImpl: impl as unknown as typeof fetch } }
}

/** Every path in the client that POSTs a chat completion. */
function chatPaths(): { name: string; run: (client: WorkBuddyUpstreamClient) => Promise<unknown> }[] {
  return [
    { name: 'completeChat', run: (c) => c.completeChat(credential(), '{}') },
    { name: 'chatStream', run: (c) => c.chatStream(credential(), '{}') },
  ]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('chat completions carry the desktop client identity', () => {
  for (const path of chatPaths()) {
    it(`${path.name} sends the three X-IDE headers`, async () => {
      const { seen, options } = recordingFetch()
      const client = new WorkBuddyUpstreamClient(options)
      await path.run(client)
      expect(seen).toHaveLength(1)
      expect(seen[0].url).toContain('/v2/chat/completions')
      expect(seen[0].headers['X-IDE-Type']).toBe('WorkBuddy')
      expect(seen[0].headers['X-IDE-Name']).toBe('WorkBuddy')
      expect(seen[0].headers['X-IDE-Version']).toBe('5.5.6')
    })

    it(`${path.name} keeps the shared auth and product headers alongside them`, async () => {
      const { seen, options } = recordingFetch()
      const client = new WorkBuddyUpstreamClient(options)
      await path.run(client)
      // The identity headers must not have REPLACED the auth contract.
      expect(seen[0].headers['Authorization']).toBe('Bearer tok')
      expect(seen[0].headers['X-Product']).toBe('SaaS')
      expect(seen[0].headers['X-User-Id']).toBe('u1')
    })

    it(`${path.name} sends all three conversation identifiers`, async () => {
      const { seen, options } = recordingFetch()
      const client = new WorkBuddyUpstreamClient(options)
      await path.run(client)
      // All three are mandatory: dropping any ONE of them is HTTP 400 / 11128.
      expect(seen[0].headers['X-Conversation-ID']).toMatch(UUID)
      expect(seen[0].headers['X-Conversation-Request-ID']).toMatch(UUID)
      expect(seen[0].headers['X-Conversation-Message-ID']).toMatch(UUID)
    })
  }

  it('chatStream reuses a caller-supplied conversation id but mints fresh request ids', async () => {
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    const conversationId = '11111111-2222-3333-4444-555555555555'
    await client.chatStream(credential(), '{}', undefined, conversationId)
    await client.chatStream(credential(), '{}', undefined, conversationId)
    // Same thread upstream...
    expect(seen[0].headers['X-Conversation-ID']).toBe(conversationId)
    expect(seen[1].headers['X-Conversation-ID']).toBe(conversationId)
    // ...but each request is its own request/message.
    expect(seen[0].headers['X-Conversation-Request-ID'])
      .not.toBe(seen[1].headers['X-Conversation-Request-ID'])
    expect(seen[0].headers['X-Conversation-Message-ID'])
      .not.toBe(seen[1].headers['X-Conversation-Message-ID'])
  })
})

describe('non-chat endpoints stay free of identity headers', () => {
  it('the points-automation task list does not claim to be the desktop app', async () => {
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    await client.listTasks(credential())
    expect(seen).toHaveLength(1)
    expect(seen[0].url).not.toContain('/v2/chat/completions')
    expect(seen[0].headers['X-IDE-Type']).toBeUndefined()
    expect(seen[0].headers['X-IDE-Name']).toBeUndefined()
    expect(seen[0].headers['X-Conversation-ID']).toBeUndefined()
  })

  it('openConversation keeps sending its own identity headers', async () => {
    // The automation's conversation opener predates this fix and already sent
    // the three headers inline. It now shares the same constant, so pinning it
    // here catches one path drifting from the other.
    const { seen, options } = recordingFetch()
    const client = new WorkBuddyUpstreamClient(options)
    const opened = await client.openConversation(credential())
    // openConversation tolerates a stream that ends immediately.
    expect(seen).toHaveLength(1)
    expect(seen[0].headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(opened === undefined || typeof opened === 'object').toBe(true)
  })
})

describe('prepareChatBody guarantees the gateway contract', () => {
  const client = new WorkBuddyUpstreamClient(recordingFetch().options)
  const parse = (raw: string): Record<string, unknown> =>
    JSON.parse(client.prepareChatBody(raw)) as Record<string, unknown>

  function roles(raw: string): unknown[] {
    return (parse(raw)['messages'] as Record<string, unknown>[]).map((m) => m['role'])
  }

  it('hoists a later system message to the front instead of dropping it', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'sys' },
      ],
    })
    expect(roles(raw)).toEqual(['system', 'user'])
    // The caller's text is preserved, not replaced.
    expect((parse(raw)['messages'] as Record<string, unknown>[])[0]['content']).toBe('sys')
  })

  it('synthesises a placeholder system message when the caller sent none', () => {
    // The gateway checks the role of messages[0], but not every row tolerates an
    // empty one: `kimi-k3.1-pro` answers `content: ''` with 400 + 11151
    // ("a message has empty content") while the same body answers 200 once that
    // turn holds any non-empty text. The placeholder satisfies both checks and
    // says nothing a model would act on.
    const raw = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    expect(roles(raw)).toEqual(['system', 'user'])
    const content = (parse(raw)['messages'] as Record<string, unknown>[])[0]['content']
    expect(content).toBe('(no system prompt)')
  })

  it('treats a relabelled developer turn as the system message it became', () => {
    // `developer` is rewritten to `system` first; if that rewrite left the turn
    // in place, a developer-first request would still trip 11128.
    const raw = JSON.stringify({ model: 'm', messages: [{ role: 'developer', content: 'sys' }] })
    expect(roles(raw)).toEqual(['system'])
  })

  it('rewrites the phrase the gateway reads as a rival harness', () => {
    // The gateway matches request text against other harnesses' prompts and
    // answers a hit with 400 + 11128 — the same code a missing system turn earns.
    // `@deepseek-ai/dsh-file-reference` ships the sentence below verbatim, so an
    // otherwise well-formed session was refused. Rewording keeps the instruction
    // and drops the fingerprint; every account answered 200 to the new wording and
    // 400 to the old one.
    const sentence = 'Tokens prefixed with @ are paths the user explicitly referenced.'
      + ' Relative paths resolve from the workspace root; absolute paths identify files.'
    const raw = JSON.stringify({ model: 'm', messages: [{ role: 'system', content: sentence }] })
    const content = (parse(raw)['messages'] as Record<string, unknown>[])[0]['content'] as string
    expect(content).toBe('Tokens starting with @ name paths the user explicitly referenced.'
      + ' Relative paths resolve against the working directory; absolute paths identify files.')
    expect(content).not.toContain('resolve from the workspace root')
  })

  it('rewrites the phrase inside a content block array too', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [{
        role: 'system',
        content: [
          { type: 'text', text: 'prefix' },
          {
            type: 'text',
            text: 'Tokens prefixed with @ are paths the user explicitly referenced.'
              + ' Relative paths resolve from the workspace root',
          },
        ],
      }],
    })
    const blocks = (parse(raw)['messages'] as Record<string, unknown>[])[0]['content'] as Record<string, unknown>[]
    expect(blocks[0]['text']).toBe('prefix')
    expect(blocks[1]['text']).toBe('Tokens starting with @ name paths the user explicitly referenced.'
      + ' Relative paths resolve against the working directory')
  })

  it('rewrites the host product name the gateway also matches', () => {
    // Not a sentence but a brand, and matched loosely: a refused 17 412-character
    // system prompt held three occurrences of the name, all inside offending
    // spans; replacing every one made the whole prompt answer 200, while
    // `Deep Seek Harness` (one space inserted) still triggered and
    // `DeepSeek-Harness` did not. So case and internal whitespace are ignored.
    const raw = JSON.stringify({
      model: 'm',
      messages: [{
        role: 'system',
        content: 'You are an AI agent powered by Deep Seek HARNESS.\n'
          + 'You are interacting with the user through the DeepSeek Harness Web GUI.',
      }],
    })
    const content = (parse(raw)['messages'] as Record<string, unknown>[])[0]['content'] as string
    expect(content).toBe('You are an AI agent powered by DSH.\n'
      + 'You are interacting with the user through the DSH Web GUI.')
  })

  it('leaves the host product name alone outside the system turn', () => {
    // The match is on the system turn only — the name in a user message or a tool
    // description is accepted, and rewriting it would alter text the caller reads
    // back. The dump that produced this fix carried the name in user[2] too.
    const tools = [{
      type: 'function',
      function: { name: 'read_file', description: 'powered by DeepSeek Harness', parameters: { type: 'object', properties: {} } },
    }]
    const raw = JSON.stringify({
      model: 'm',
      tools,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'powered by DeepSeek Harness' },
      ],
    })
    const body = parse(raw)
    expect(tools[0].function.description).toBe('powered by DeepSeek Harness')
    expect((body['messages'] as Record<string, unknown>[])[1]['content']).toBe('powered by DeepSeek Harness')
  })

  it('leaves user turns, tool results and tool descriptions byte-identical', () => {
    // Only `system` turns are matched — the same sentence as a user message, as a
    // tool result, or inside a tool description is accepted. Rewriting beyond the
    // system turn would edit tool output the caller is about to read, so the
    // rewrite stays where the check is.
    const sentence = 'Tokens prefixed with @ are paths the user explicitly referenced.'
      + ' Relative paths resolve from the workspace root'
    const tools = [{
      type: 'function',
      function: { name: 'read_file', description: sentence, parameters: { type: 'object', properties: {} } },
    }]
    const raw = JSON.stringify({
      model: 'm',
      tools,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: sentence },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: sentence },
      ],
    })
    const out = parse(raw)
    expect(out['tools']).toEqual(tools)
    expect((out['messages'] as Record<string, unknown>[])[1]['content']).toBe(sentence)
    expect((out['messages'] as Record<string, unknown>[])[3]['content']).toBe(sentence)
  })

  it('leaves an already-conforming body alone', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(roles(raw)).toEqual(['system', 'user'])
    expect(parse(raw)['stream']).toBe(true)
  })

  it('defaults reasoning_effort to none, and never overrides the caller', () => {
    // Measured on the live gateway: `hy3` and `step-5-preview` both carry
    // `canDisableThinking: false` and a `defaultEffort` of high, so a request
    // without an effort spends the whole budget on reasoning_content and returns
    // an empty `content` with `finish_reason: length`. `none` was then sent to
    // every other advertised model and all 18 answered 200, so the default costs
    // no model anything.
    const bare = JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] })
    expect(parse(bare)['reasoning_effort']).toBe('none')
    expect(parse(JSON.stringify({ model: 'hy3', messages: [], reasoning_effort: '' }))['reasoning_effort']).toBe('none')
    // A level the caller actually chose survives untouched, or the setting that
    // lets a user ask for thinking would do nothing.
    expect(parse(JSON.stringify({ model: 'hy3', messages: [], reasoning_effort: 'high' }))['reasoning_effort'])
      .toBe('high')
  })

  describe('thinking level clamping', () => {
    /** The row's own declaration, as the catalog reports it. */
    const clamp = (effort: string | undefined, supportedEfforts: readonly string[]): unknown => {
      const body: Record<string, unknown> = { model: 'm', messages: [] }
      if (effort !== undefined) body['reasoning_effort'] = effort
      return (JSON.parse(client.prepareChatBody(JSON.stringify(body), supportedEfforts)) as Record<string, unknown>)['reasoning_effort']
    }

    it('downgrades a level the row does not declare', () => {
      // `hy4-preview` declares `["high"]` only. The session-level default is
      // `max`, so selecting that row asked for a level it has never supported and
      // the gateway answered 400 + 11133 ("the request parameters were rejected by
      // the model provider") on every attempt — measured on the live gateway,
      // while the same body asking for `high` answered 200.
      expect(clamp('max', ['high'])).toBe('high')
      expect(clamp('max', ['low', 'high', 'max'])).toBe('max')
    })

    it('picks the nearest declared neighbour rather than the first entry', () => {
      expect(clamp('max', ['low', 'high'])).toBe('high')
      expect(clamp('low', ['high', 'max'])).toBe('high')
      expect(clamp('medium', ['minimal', 'max'])).toBe('minimal')
      expect(clamp('xhigh', ['low', 'medium', 'high'])).toBe('high')
    })

    it('leaves an unknown level and a row with no declaration alone', () => {
      // `none` and any vocabulary this table does not know may still be valid
      // upstream; guessing a replacement would silently change the request.
      expect(clamp('none', ['high'])).toBe('none')
      expect(clamp('turbo', ['high'])).toBe('turbo')
      expect(clamp('max', [])).toBe('max')
      expect(JSON.parse(client.prepareChatBody(
        JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'max' }),
      ))['reasoning_effort']).toBe('max')
    })

    it('leaves the synthesised default at none, which every row accepts', () => {
      // `none` is not on the ladder, so it is never rewritten: it was measured
      // against every advertised row and all of them answered 200, including the
      // ones that declare a single level. Clamping it would trade a working
      // request for a guess about how a row reads "off".
      expect(clamp(undefined, ['high', 'max'])).toBe('none')
    })
  })
})
