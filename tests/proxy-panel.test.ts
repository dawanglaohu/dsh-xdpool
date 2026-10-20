/**
 * The per-account proxy panel.
 *
 * A proxy list is the one control on this card where the ORDER is the data: the
 * chain is tried top-down, so a panel that quietly sorts, dedupes or loses a
 * line changes which address the account goes out through. Nothing here renders
 * React -- the card is a bundle the host dialog mounts in a DOM this process
 * does not have -- so the assertions are on the source contract, the same way
 * `card-shell.test.ts` asserts the shell.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const card = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

/** The nine strings this panel prints. */
const KEYS = [
  'row.proxyTitle',
  'row.proxyHint',
  'row.proxyDirect',
  'row.proxyActive',
  'row.proxySave',
  'row.proxyTest',
  'row.proxySaved',
  'row.proxyCleared',
  'row.proxyFailed',
] as const

/** Whether the zh table declares a key. It is typed, not `as const`, so it runs to EOF. */
function zhHas(source: string, key: string): boolean {
  return source.slice(source.indexOf('export const zh')).includes(`'${key}':`)
}

/** Whether the en table declares a key. Sliced to its `} as const` terminator. */
function enHas(source: string, key: string): boolean {
  const enStart = source.indexOf('export const en = {')
  const enEnd = source.indexOf('} as const', enStart)
  return source.slice(enStart, enEnd).includes(`'${key}':`)
}

/** The literal value a table gives `key`, or undefined when it has none. */
function valueOf(source: string, key: string): string | undefined {
  const match = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(source)
  return match?.[1]
}

/** Whether `table` carries a rule targeting `name` itself, not a longer name it prefixes. */
function targets(table: string, name: string): boolean {
  return new RegExp(`\\.${name}(?=[{,:.[>+~ ])`).test(table)
}

describe('the proxy panel', () => {
  it('edits the chain as text, so line order survives', () => {
    // The draft starts from exactly what the host reports, joined on newlines --
    // no re-sorting on the way in, or the first hop the user chose becomes the
    // first hop we chose.
    expect(card).toContain("const saved = account.proxies.join('\\n')")
    expect(card).toContain('const [draft, setDraft] = useState<string>(saved)')
    expect(card).toMatch(/<textarea[\s\S]{0,400}?value=\{draft\}/)
    expect(card).toContain('spellCheck={false}')
  })

  it('keeps Enter a newline and commits on Ctrl/Cmd+Enter', () => {
    expect(card).toMatch(/event\.key === 'Enter' && \(event\.ctrlKey \|\| event\.metaKey\)/)
    expect(card).toMatch(/event\.preventDefault\(\)[\s\S]{0,80}?void commit\(\)/)
  })

  it('drops blank lines and trims, but keeps the remaining order', () => {
    // Trailing newlines and stray spaces are noise; the sequence is not.
    expect(card).toContain("draft.split('\\n').map(line => line.trim()).filter(line => line !== '')")
  })

  it('reports direct vs a configured chain on the badge', () => {
    expect(card).toContain("account.proxyHealth === 'direct'")
    expect(card).toContain("t?.('row.proxyDirect')")
    // The count, not the masked URLs: the badge has to say "x2" without
    // printing a password slot twice.
    expect(card).toContain("t?.('row.proxyActive', { count: account.proxyCount })")
    // Direct is an ordinary state, not a warning: the badge carries the health
    // so only a chain that was just measured dead keeps the alarm colour.
    expect(card).toContain('data-health="direct"')
    expect(card).toContain('data-health={account.proxyHealth}')
  })

  it('settles on what the host stored, and says so', () => {
    expect(card).toMatch(/const ok = await onSave\(account\.id, lines\)/)
    expect(card).toMatch(/setSettled\(ok \? draft : settled\)/)
    expect(card).toContain("setNote(ok ? (lines.length === 0 ? 'cleared' : 'saved') : 'failed')")
  })

  it('saves and probes through the host routes, never by dialling itself', () => {
    expect(card).toMatch(/fetch\(POOL_ACCOUNT_PROXY_PATH, \{[\s\S]{0,200}?JSON\.stringify\(\{ accountId, proxies: lines \}\)/)
    expect(card).toMatch(/fetch\(POOL_PROXY_TEST_PATH, \{[\s\S]{0,200}?JSON\.stringify\(\{ accountId \}\)/)
  })

  it('renders one probe reading per hop', () => {
    expect(card).toMatch(/reading\.ok[\s\S]{0,200}?dsm-xdpool-proxy-probe-ok/)
    expect(card).toContain('dsm-xdpool-proxy-probe-bad')
  })

  it('styles every class it emits', () => {
    const table = styles.slice(styles.indexOf('export const POOL_CARD_CSS'), styles.indexOf('export const AGGREGATE_CARD_CSS'))
    for (const name of [
      'dsm-xdpool-proxy',
      'dsm-xdpool-proxy-head',
      'dsm-xdpool-proxy-label',
      'dsm-xdpool-proxy-badge',
      'dsm-xdpool-proxy-input',
      'dsm-xdpool-proxy-actions',
      'dsm-xdpool-proxy-save',
      'dsm-xdpool-proxy-test',
      'dsm-xdpool-proxy-note',
      'dsm-xdpool-proxy-note-ok',
      'dsm-xdpool-proxy-note-bad',
      'dsm-xdpool-proxy-hint',
      'dsm-xdpool-proxy-probe',
      'dsm-xdpool-proxy-probe-ok',
      'dsm-xdpool-proxy-probe-bad',
    ]) {
      expect(targets(table, name), `${name} has no CSS rule`).toBe(true)
    }
    // A list is edited as text: monospace and vertically resizable, or the
    // columns of a chain stop lining up the moment a password changes length.
    expect(table).toMatch(/\.dsm-xdpool-proxy-input\{[^}]*font-family:/)
    expect(table).toMatch(/\.dsm-xdpool-proxy-input\{[^}]*resize:vertical/)
  })

  it('offers every locale string the panel prints, in both languages', () => {
    for (const key of KEYS) {
      expect(enHas(locales, key), `${key} missing from en`).toBe(true)
      // The zh table is a hand-maintained twin; a key added to one and not the
      // other renders as the key name itself in half the UI.
      expect(zhHas(locales, key), `${key} missing from zh`).toBe(true)
      expect(valueOf(locales, key), `${key} has no value`).toBeDefined()
    }
    // Declared exactly twice: once per table. A third copy means a duplicate key
    // that silently shadows the other language.
    for (const key of KEYS) {
      const hits = locales.split('\n').filter(line => line.includes(`'${key}':`))
      expect(hits, `${key} must appear once per locale table`).toHaveLength(2)
    }
  })

  it('labels the egress address on a probe line in both languages', () => {
    // A bare IP after a middot reads as part of the latency figure; the word in
    // front of it is what makes it "the address the far end saw".
    for (const key of ['row.proxyEgress']) {
      expect(enHas(locales, key), `${key} missing from en`).toBe(true)
      expect(zhHas(locales, key), `${key} missing from zh`).toBe(true)
    }
    expect(card).toContain("t?.('row.proxyEgress')")
  })

  it('keeps the {count} placeholder in the plural label of both languages', () => {
    // The badge interpolates a number; a translation that drops the placeholder
    // reads "Proxy x" with nothing after it.
    for (const key of ['row.proxyActive']) {
      const line = locales.split('\n').filter(l => l.includes(`'${key}':`))
      expect(line.length).toBe(2)
      for (const entry of line) expect(entry).toContain('{count}')
    }
  })
})
