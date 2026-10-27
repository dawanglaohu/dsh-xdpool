/**
 * A byte-order mark must not turn a valid document into "nothing configured".
 *
 * Every file here is hand-editable, and the Windows editors users actually open
 * them with (Notepad, PowerShell's `Out-File`, several IDEs' "UTF-8 with BOM")
 * prefix the text with U+FEFF. `JSON.parse` rejects that prefix, and every
 * reader in this plugin used to swallow the throw into its own empty value — so
 * a pin silently stopped applying, an ignore list silently emptied, an aggregate
 * key silently disappeared from the card. The live symptom that found this was
 * a `preferred.json` holding 47 bytes: three of them a BOM, the rest a perfectly
 * good pin the pool never saw.
 *
 * The mark belongs to the ENCODING, not the document, so it is stripped in one
 * place ({@link parseJsonDocument}) and every reader goes through it. These
 * tests pin that per reader, because "all of them" is exactly the claim that
 * rots.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseJsonDocument, stripBom } from '../src/json-file.ts'
import { parseWorkBuddyAuth, cheapIdentityId } from '../src/accounts.ts'
import { loadStoredAccounts } from '../src/account-store.ts'
import { readIgnoredAccounts, readIgnoredAccountsSync } from '../src/ignored.ts'
import { readPreferredId, readPreferredIdSync } from '../src/preferred.ts'
import { readProxies, readProxiesSync } from '../src/proxy-store.ts'
import { readAggregateSettings, readAggregateSettingsSync } from '../src/store.ts'

const BOM = '\uFEFF'

/** Write `body` into a fresh temp file and return its path. */
async function file(body: string, name = 'document.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-bom-'))
  const path = join(dir, name)
  await writeFile(path, body, 'utf8')
  return path
}

describe('the mark is a property of the encoding', () => {
  it('strips exactly one leading mark and nothing else', () => {
    expect(stripBom(`${BOM}{}`)).toBe('{}')
    expect(stripBom('{}')).toBe('{}')
    // Two marks is not a BOM any editor writes; the second one is document text.
    expect(stripBom(`${BOM}${BOM}{}`)).toBe(`${BOM}{}`)
  })

  it('parses a marked document and still rejects a broken one', async () => {
    expect(parseJsonDocument(`${BOM}{"a":1}`)).toEqual({ a: 1 })
    expect(parseJsonDocument(` ${BOM}{"a":1}`)).toEqual({ a: 1 })
    // A document that is genuinely malformed must stay absent, not be guessed at.
    expect(parseJsonDocument(`${BOM}{"a":`)).toBeUndefined()
    expect(parseJsonDocument('not json')).toBeUndefined()
    // A file holding nothing but a mark is an empty file, not a parse error.
    expect(parseJsonDocument(BOM)).toBeUndefined()
    expect(parseJsonDocument(BOM + '  \n')).toBeUndefined()
  })
})

describe('the pin survives a marked file', () => {
  it('reads the preferred id from a BOM-prefixed document, both readers', async () => {
    // The exact live shape: three BOM bytes plus {"version":1,"accountId":"…"}.
    const path = await file(`${BOM}{\n  "version": 1,\n  "accountId": "acct-7"\n}\n`)
    expect(await readPreferredId(path)).toBe('acct-7')
    expect(readPreferredIdSync(path)).toBe('acct-7')
  })
})

describe('every other plugin-owned document survives it too', () => {
  it('reads an ignore list', async () => {
    const path = await file(`${BOM}{"version":1,"accounts":[{"id":"acct-9","label":"Nine"}]}`)
    expect(await readIgnoredAccounts(path)).toEqual([{ id: 'acct-9', label: 'Nine', ignoredAt: '' }])
    expect(readIgnoredAccountsSync(path)).toHaveLength(1)
  })

  it('reads a proxy table', async () => {
    const path = await file(`${BOM}{"version":1,"accounts":{"acct-1":["http://127.0.0.1:7890"]}}`)
    expect((await readProxies(path))['acct-1']).toEqual(['http://127.0.0.1:7890'])
    expect(readProxiesSync(path)['acct-1']).toHaveLength(1)
  })

  it('reads the durable account store, which a mark would otherwise empty', async () => {
    const document = {
      version: 1,
      accounts: [{
        id: 'acct-1',
        label: 'One',
        savedAtMs: 1,
        credential: { accessToken: 'token', refreshToken: 'refresh' },
      }],
    }
    const path = await file(`${BOM}${JSON.stringify(document)}`)
    expect(await loadStoredAccounts(path)).toHaveLength(1)
  })

  it('reads an aggregate settings document', async () => {
    const previous = process.env['DSH_HOME']
    const home = await mkdtemp(join(tmpdir(), 'wbp-bom-home-'))
    process.env['DSH_HOME'] = home
    try {
      await mkdir(join(home, '.xdpool'), { recursive: true })
      await writeFile(join(home, '.xdpool', 'aggregate.json'), `${BOM}{"version":1,"enabled":true}`, 'utf8')
      expect(await readAggregateSettings()).toEqual({ enabled: true })
      expect(readAggregateSettingsSync()).toEqual({ enabled: true })
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('reads a WorkBuddy auth document handed to the parsers as text', () => {
    // Not a file reader: the desktop app writes these, and a future build that
    // writes a BOM would otherwise look like a signed-out account.
    const text = `${BOM}${JSON.stringify({
      auth: { accessToken: 'token-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 },
      account: { uin: '100000000001', nickname: 'One' },
    })}`
    expect(parseWorkBuddyAuth(text, 'virtual.info')?.accessToken).toBe('token-1')
    expect(cheapIdentityId(text)).toBeDefined()
  })
})
