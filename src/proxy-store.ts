/**
 * Per-account egress proxies: which account leaves the machine through which
 * address.
 *
 * Kept in a plugin-owned file rather than in the settings document for the same
 * reason as the ignore list: the CLI has no settings service. A table written
 * only by the card could never be read by dsh-xdpool from a terminal, and the
 * two views of "where does this account leave from" would drift.
 *
 * Two properties of the shape carry meaning, so they are not incidental:
 *
 * - The array is an ORDERED FALLBACK LIST. Index 0 is the account's primary
 *   egress; the rest are tried in turn when it fails. Treating it as a set
 *   would silently pick a different primary.
 * - An ABSENT key means direct. An empty array means the same thing, so it is
 *   never written: a key holding [] would be a second spelling of "direct" and
 *   every reader would need to know about both.
 *
 * @module dsh-xdpool/proxy-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pluginDataDir } from './ignored.ts'
import { parseJsonDocument } from './json-file.ts'
import { parseProxyUrl } from './proxy-fetch.ts'

/** File holding the per-account proxy table, inside {@link pluginDataDir}. */
export const PROXIES_FILE_NAME = 'proxies.json'

/** Account id to its ordered proxy chain. Absent means "direct". */
export type ProxyTable = Readonly<Record<string, readonly string[]>>

/**
 * Absolute path of the proxy table.
 *
 * Resolved through {@link pluginDataDir} rather than recomputing DSH_HOME here:
 * a second copy of that rule is a second place for the host and the CLI to
 * disagree about which file they are talking about.
 */
export function proxiesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginDataDir(env), PROXIES_FILE_NAME)
}

/**
 * One account's chain, with every entry that cannot be used dropped.
 *
 * Tolerant on purpose: this file is hand-editable, and one bad line must not
 * cost the user every proxy they configured. An entry that does not parse is
 * dropped rather than stored, because it would otherwise fail at request time
 * with the pool already committed to that account.
 */
function normalizeProxies(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    if (text === '' || seen.has(text)) continue
    if (parseProxyUrl(text) === undefined) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * Whatever the file holds, as a usable table.
 *
 * A whole-document failure yields {} — "everyone goes direct" — because the
 * pool must still start on a machine whose proxy file was hand-mangled.
 */
function normalizeTable(raw: unknown): ProxyTable {
  if (typeof raw !== 'object' || raw === null) return {}
  const accounts = (raw as { accounts?: unknown }).accounts
  if (typeof accounts !== 'object' || accounts === null) return {}
  const out: Record<string, readonly string[]> = {}
  for (const [accountId, value] of Object.entries(accounts as Record<string, unknown>)) {
    const id = accountId.trim()
    if (id === '') continue
    const proxies = normalizeProxies(value)
    // Empty means direct, and direct is spelled by the ABSENCE of the key.
    if (proxies.length === 0) continue
    out[id] = proxies
  }
  return out
}

/** Read the table, tolerating every "nothing configured yet" shape. */
export async function readProxies(path: string = proxiesPath()): Promise<ProxyTable> {
  try {
    return normalizeTable(parseJsonDocument(await readFile(path, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * Synchronous read, for startup.
 *
 * The host applies the table from inside its synchronous apply(), and doing it
 * there removes a startup race: an async load could resolve AFTER the first
 * account scan and route one request direct that should have been proxied. The
 * file is a few hundred bytes.
 */
export function readProxiesSync(path: string = proxiesPath()): ProxyTable {
  try {
    return normalizeTable(parseJsonDocument(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * Replace the table, atomically.
 *
 * Written to a sibling temp file and renamed over the target so a crash cannot
 * leave a half-written document: a truncated proxy table reads as "everything
 * is direct", which would quietly move every account onto the user's own IP —
 * the exact leak the feature exists to prevent.
 */
export async function writeProxies(table: ProxyTable, path: string = proxiesPath()): Promise<void> {
  const payload = JSON.stringify({ version: 1, accounts: table }, null, 2)
  // Create the directory the TARGET lives in, not the default one: callers pass
  // an explicit path, and creating the wrong directory leaves the write to fail.
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  await writeFile(temp, payload + '\n', 'utf8')
  await rename(temp, path)
}

/** True when two tables hold the same chains in the same order. */
function sameTable(left: ProxyTable, right: ProxyTable): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(key => {
    const one = left[key]
    const two = right[key]
    if (one === undefined || two === undefined) return false
    return one.length === two.length && one.every((value, index) => value === two[index])
  })
}

/**
 * Set one account's chain, preserving every other account.
 *
 * A read-modify-write rather than a wholesale replace: the card and the CLI can
 * both be open, and each request names exactly one account, so re-writing the
 * whole table from a stale view would drop the other side's edits.
 *
 * An empty chain DELETES the key rather than storing [], so "direct" has exactly
 * one on-disk spelling. Returns the table as written.
 */
export async function setAccountProxies(
  accountId: string,
  proxies: readonly string[],
  path: string = proxiesPath(),
): Promise<ProxyTable> {
  const current = await readProxies(path)
  const next: Record<string, readonly string[]> = { ...current }
  const normalized = normalizeProxies(proxies)
  if (normalized.length === 0) delete next[accountId]
  else next[accountId] = normalized
  // Clearing an account that had nothing must not create a file, or "no proxies
  // configured" would become two states a reader has to tell apart.
  if (!sameTable(current, next)) await writeProxies(next, path)
  return next
}
