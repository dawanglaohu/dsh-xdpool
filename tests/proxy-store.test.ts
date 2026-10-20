/**
 * The proxy table is the file the pool reads at startup to decide where each
 * account leaves from, so the cases here are the ones that decide whether a
 * request is proxied at all. Each one exists because getting it wrong is
 * silent: a dropped entry means an account quietly goes direct.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginDataDir } from '../src/ignored.ts'
import {
  PROXIES_FILE_NAME,
  proxiesPath,
  readProxies,
  readProxiesSync,
  setAccountProxies,
  writeProxies,
} from '../src/proxy-store.ts'

const PRIMARY = 'http://u:p@1.2.3.4:8080'
const SECONDARY = 'socks5://u:p@5.6.7.8:1080'
const ACCOUNT = '0123456789abcdef'

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wbp-proxyfile-'))
  return join(dir, PROXIES_FILE_NAME)
}

describe('proxy store', () => {
  it('resolves its path from the plugin data directory', () => {
    const env = { DSH_HOME: 'D:/xdpool-proxy-home' } as NodeJS.ProcessEnv
    expect(proxiesPath(env)).toBe(join(pluginDataDir(env), PROXIES_FILE_NAME))
  })

  it('reads back exactly what it wrote, order preserved', async () => {
    const path = await tempFile()
    await writeProxies({ [ACCOUNT]: [PRIMARY, SECONDARY] }, path)
    expect(await readProxies(path)).toEqual({ [ACCOUNT]: [PRIMARY, SECONDARY] })
    expect(readProxiesSync(path)).toEqual({ [ACCOUNT]: [PRIMARY, SECONDARY] })
  })

  it('writes the documented document shape', async () => {
    const path = await tempFile()
    await writeProxies({ [ACCOUNT]: [PRIMARY] }, path)
    const document = JSON.parse(await readFile(path, 'utf8')) as { version: number; accounts: unknown }
    expect(document.version).toBe(1)
    expect(document.accounts).toEqual({ [ACCOUNT]: [PRIMARY] })
  })

  it('drops entries that are not usable proxies', async () => {
    const path = await tempFile()
    // A hand-edited file is the normal case: one bad line must not cost the user
    // the entry next to it.
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: {
        [ACCOUNT]: [PRIMARY, 'not a proxy', '', 'ftp://1.2.3.4:21', 42, SECONDARY],
      },
    }), 'utf8')
    expect(await readProxies(path)).toEqual({ [ACCOUNT]: [PRIMARY, SECONDARY] })
  })

  it('keeps the first occurrence when an entry repeats', async () => {
    const path = await tempFile()
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: { [ACCOUNT]: [PRIMARY, SECONDARY, PRIMARY] },
    }), 'utf8')
    expect(await readProxies(path)).toEqual({ [ACCOUNT]: [PRIMARY, SECONDARY] })
  })

  it('treats an account with no usable proxy as direct, without a key', async () => {
    const path = await tempFile()
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: { [ACCOUNT]: [], other: ['nonsense'] },
    }), 'utf8')
    // Direct is spelled by the ABSENCE of the key, so an empty chain must not
    // come back as a key holding an empty array.
    expect(await readProxies(path)).toEqual({})
  })

  it('returns an empty table for a missing file, bad JSON, or a wrong shape', async () => {
    const missing = await tempFile()
    expect(await readProxies(missing)).toEqual({})
    expect(readProxiesSync(missing)).toEqual({})

    const broken = await tempFile()
    await writeFile(broken, '{ not json', 'utf8')
    expect(await readProxies(broken)).toEqual({})
    expect(readProxiesSync(broken)).toEqual({})

    const wrong = await tempFile()
    await writeFile(wrong, JSON.stringify({ version: 1, accounts: 'nope' }), 'utf8')
    expect(await readProxies(wrong)).toEqual({})
  })

  it('sets one account without disturbing the others', async () => {
    const path = await tempFile()
    await setAccountProxies(ACCOUNT, [PRIMARY], path)
    const next = await setAccountProxies('fedcba9876543210', [SECONDARY], path)
    expect(next).toEqual({ [ACCOUNT]: [PRIMARY], fedcba9876543210: [SECONDARY] })
    expect(await readProxies(path)).toEqual(next)
  })

  it('deletes the key when an account is set back to direct', async () => {
    const path = await tempFile()
    await setAccountProxies(ACCOUNT, [PRIMARY], path)
    const next = await setAccountProxies(ACCOUNT, [], path)
    expect(next).toEqual({})
    expect(await readProxies(path)).toEqual({})
  })

  it('clearing an account that had nothing does not create a file', async () => {
    const path = await tempFile()
    const next = await setAccountProxies(ACCOUNT, [], path)
    expect(next).toEqual({})
    // readProxies returning {} would hide the difference, so assert on the file.
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('creates the directory holding an explicitly given path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wbp-proxyfile-'))
    const nested = join(dir, 'a', 'b', PROXIES_FILE_NAME)
    await writeProxies({ [ACCOUNT]: [PRIMARY] }, nested)
    expect(await readProxies(nested)).toEqual({ [ACCOUNT]: [PRIMARY] })
  })
})
