/**
 * A 400 the gateway blames on "the model provider" with an empty `param` cannot
 * be diagnosed from the log alone: `requestShape` prints keys and counts, and
 * the two things that actually cause it live in the bytes — a content block the
 * gateway does not know, or a parameter whose value the row refuses. Both are
 * invisible in a shape summary and neither reproduces from a rebuilt body, so
 * the only honest next step is to keep the body that was refused.
 *
 * Exactly one file, overwritten every time, capped at 4 MiB. A pool directory
 * is state, not a log sink: N refused requests must not become N megabytes the
 * user has to find and delete.
 *
 * `XDPOOL_NO_BODY_DUMP=1` turns it off. The test suite sets it: a unit test
 * that produces a refusal would otherwise write over the file a real
 * investigation is reading, and the value of a dump is that it is the one the
 * user actually hit.
 *
 * @module dsh-xdpool/rejected-body
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'

/** The dump is skipped above this size, so a huge prompt cannot fill the disk. */
const MAX_DUMP_BYTES = 4 * 1024 * 1024

/**
 * Where the last refused body lives, or undefined when no home resolves.
 *
 * `DSH_HOME` first because that is what the rest of the plugin's state follows;
 * a user who moved their home expects the dump to move with it.
 */
export function rejectedBodyPath(): string | undefined {
  const home = env.DSH_HOME ?? homedir()
  if (typeof home !== 'string' || home === '') return undefined
  return join(home, '.xdpool', 'last-rejected-body.json')
}

/** One refused request, as much as is needed to reproduce it by hand. */
export interface RejectedBodyRecord {
  /** ISO timestamp of the refusal. */
  at: string
  /** Model id the caller asked for. */
  model: string
  /** Account label that was served the refusal. */
  account: string
  /** HTTP status the upstream returned. */
  status: number
  /** The upstream's own words, verbatim. */
  upstream: string
  /** The exact JSON body the shim sent. Parsed when possible, else the raw text. */
  body: unknown
}

/**
 * Write (or overwrite) the dump. Failures are swallowed on purpose: this runs on
 * the path that is already reporting a 400, and a dump error must never replace
 * the real one with a filesystem error the user cannot act on.
 */
export async function recordRejectedBody(record: RejectedBodyRecord): Promise<string | undefined> {
  if (env['XDPOOL_NO_BODY_DUMP'] === '1') return undefined
  const path = rejectedBodyPath()
  if (path === undefined) return undefined
  const text = JSON.stringify(record, undefined, 2)
  if (text.length > MAX_DUMP_BYTES) return undefined
  try {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${text}\n`, 'utf8')
    return path
  } catch {
    return undefined
  }
}
