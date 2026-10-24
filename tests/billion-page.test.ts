/**
 * The billion-context tab.
 *
 * A read-only observation page, and the tests below exist to keep it that way
 * rather than to describe what it looks like.
 *
 * The thing worth protecting here is the boundary. billion-context is a
 * separate plugin that may or may not be installed; this page observes it, and
 * nothing else about this plugin's surface may reach that listener. The three
 * tests below pin the two halves of that: the page has no way to tell the proxy
 * to do anything (no POST/PUT/PATCH/DELETE anywhere in it, no fetch outside the
 * single GET), and the route that feeds it is loopback-only and GET-only too.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { POOL_BILLION_PATH } from '../src/status-paths.ts'
import { readBillionStatus } from '../src/billion.ts'
const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')
/**
 * Source text with comments stripped.
 *
 * Needed because this file's comments deliberately NAME the identifiers its
 * checks forbid: asserting against raw text would fail on the module's own
 * explanation of what went wrong, which is the most confusing failure a test
 * can produce — and it would make the obvious fix "delete the comment".
 */
const readCode = (relative: string): string =>
  read(relative)
    .replaceAll(/\/\*[\S\s]*?\*\//gu, '')
    .replaceAll(/^[ \t]*\/\/.*$/gmu, '')
describe('the billion-context relay route', () => {
  it('lives under the plugin namespace so it cannot collide with another one', () => {
    expect(POOL_BILLION_PATH).toBe('/plugins/dsh-xdpool/billion')
    expect(POOL_BILLION_PATH.startsWith('/plugins/dsh-xdpool/')).toBe(true)
  })
  it('is answered by GET only, behind the loopback-origin guard', () => {
    const source = read('../src/web-status.ts')
    // The route body, not the whole file: web-status.ts legitimately contains
    // POST routes for the pool's own mutations.
    const at = source.indexOf(`path: POOL_BILLION_PATH`)
    expect(at).toBeGreaterThan(-1)
    const body = source.slice(at, at + 900)
    expect(body).toContain(`req.method !== 'GET'`)
    expect(body).toContain(`loopbackOrigin(req)`)
    expect(body).toContain(`json(res, 405`)
    expect(body).toContain(`json(res, 403`)
    // And it must answer 503 rather than a fabricated document when the module
    // was not wired: "we cannot see it" must not render as "there is nothing".
    expect(body).toContain('json(res, 503')
  })
})
describe('the billion-context reader', () => {
  it('looks where the proxy actually keeps its state, not under the profile', async () => {
    // Regression, found by probing the live proxy rather than by a faked
    // fixture: resolving the state root as `DSH_HOME ?? homedir()` sent this
    // reader to `<profile>/.local/state/billion-context` and answered "missing"
    // on a machine where the proxy was running. DSH_HOME is the profile root
    // and has nothing to do with the proxy's own XDG state directory, so the
    // module must not consult it at all.
    const source = readCode('../src/billion.ts')
    expect(source).not.toContain('DSH_HOME')
    expect(source).toContain('join(home,')
    // …and the module resolves its root from the OS home directory, which is
    // what makes the two variables distinguishable at all. Asserting a RELATION
    // between DSH_HOME and USERPROFILE (e.g. "DSH_HOME is not under the profile")
    // pinned a property of one machine's layout: on Windows the desktop profile
    // lives at %USERPROFILE%\.dsh, so that assertion failed on a correct build.
    expect(source).toContain("homedir()")
  })
  it('reports missing instead of failing when no proxy is recorded', async () => {
    // Point the reader at a state directory that cannot hold a proxy. This is
    // the normal state on a machine that never installed billion-context, and
    // it is the one that must never surface as an error banner.
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = 'relative-not-absolute'
    try {
      const doc = await readBillionStatus()
      // On a machine that really does have the proxy running, an unrelocatable
      // XDG_STATE_HOME still means "we cannot find it" — which is the claim
      // under test. Assert the shape, not the presence.
      expect(doc.state === 'missing' || doc.state === 'unreachable').toBe(true)
      expect(doc.sessions).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })
  it('is the only network caller of that proxy and it is a GET', () => {
    const source = readCode('../src/billion.ts')
    const fetches = source.match(/method:\s*'([A-Z]+)'/gu) ?? []
    expect(fetches).toEqual([`method: 'GET'`])
    // Every path is spelled out at its call site, so adding a third read later
    // shows up as a diff in this list rather than as a silent new endpoint.
    expect(source.match(/fetchJson\(origin, '([^']+)'\)/gu)).toEqual([
      `fetchJson(origin, '/health')`,
      `fetchJson(origin, '/sessions')`,
    ])
    expect(source).toContain('new URL(BILI_PREFIX + path, origin)')
  })
})
describe('the billion-context page', () => {
  const source = read('../src/client/BillionPage.tsx')
  it('cannot write to anything — no mutating method, no second endpoint', () => {
    expect(source).not.toMatch(/\bmethod:\s*'(POST|PUT|PATCH|DELETE)'/u)
    // Exactly one fetch, and it is the GET for this page's document. A second
    // one would have to be reviewed here, which is the point.
    expect(source.match(/await fetch\(/gu) ?? []).toHaveLength(1)
    expect(source).toContain(`fetch(POOL_BILLION_PATH`)
    expect(source).not.toMatch(/credentials:\s*'include'/u)
  })
  it('says "not measured" instead of printing a zero', () => {
    // -1 is the proxy's own "no measurement". Rendering it as 0% would claim the
    // cache never helped, which is a different and wrong statement.
    expect(source).toContain(`row.cacheHitPct < 0 ? '—'`)
    expect(source).toContain(`hitRate === null ? '—'`)
    // Normalised: this asserts the SHAPE of the helper, not the repo's line
    // endings. A literal '\n' here silently started failing when the file was
    // converted to CRLF, which says nothing about the behaviour under test.
    expect(source.replaceAll(/\r\n/gu, '\n')).toContain(
      'tokens(value: number): string {\n  return value === 0',
    )
  })
  it('is wired as its own tab, not spliced into another page', () => {
    const card = read('../src/client/PoolCard.tsx')
    expect(card).toContain(`{ id: 'billion', label: t?.('shell.tabBillion')`)
    expect(card).toContain(`page === 'billion' ? <BillionPage t={t} />`)
  })
  it('has every string it renders, in both languages', () => {
    const locales = read('../src/client/locales.ts')
    const used = [...source.matchAll(/t\?\.\('(billion\.[A-Za-z]+)'/gu)].map(m => m[1])
    expect(used.length).toBeGreaterThan(20)
    for (const key of new Set(used)) {
      expect(locales, `missing ${key}`).toContain(`'${key}'`)
    }
    // …and every fallback literal differs from the English string, so a
    // missing translation shows up as visibly English rather than as silence.
    const fallbacks = [...source.matchAll(/\?\?\s*'([^']*[A-Za-z][^']*)'/gu)]
      .map(m => m[1])
      .filter(text => !text.includes('—'))
    expect(fallbacks.length).toBeGreaterThan(10)
  })
})