/**
 * The refused-body dump is the last-resort diagnostic for a 400 the gateway
 * refuses to explain. Its whole value is that a later reader can replay the
 * exact bytes, so the tests pin what that reader needs: the file lands where the
 * rest of the pool state lives, it is ONE file however many refusals happen, and
 * an unparseable body is kept as text instead of being dropped.
 *
 * The suite runs with `XDPOOL_NO_BODY_DUMP=1` so a test that trips a refusal
 * cannot overwrite the dump a live investigation is reading; these cases opt
 * back in for themselves.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recordRejectedBody, rejectedBodyPath } from '../src/rejected-body.ts'

let home: string
let previous: string | undefined
let previousGuard: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'xdpool-rejected-'))
  previous = process.env['DSH_HOME']
  previousGuard = process.env['XDPOOL_NO_BODY_DUMP']
  process.env['DSH_HOME'] = home
  delete process.env['XDPOOL_NO_BODY_DUMP']
})

afterEach(async () => {
  if (previous === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previous
  if (previousGuard === undefined) delete process.env['XDPOOL_NO_BODY_DUMP']
  else process.env['XDPOOL_NO_BODY_DUMP'] = previousGuard
  await rm(home, { recursive: true, force: true })
})

describe('the refused body dump', () => {
  it('writes beside the pool state, under DSH_HOME', async () => {
    expect(rejectedBodyPath()).toBe(join(home, '.xdpool', 'last-rejected-body.json'))

    const path = await recordRejectedBody({
      at: '2026-10-30T11:42:46.000Z',
      model: 'kimi-k3.1-pro',
      account: '🍀眠#1269d013',
      status: 400,
      upstream: '{"code":11133,"msg":"Invalid request parameters"}',
      body: { model: 'kimi-k3.1-pro', messages: [{ role: 'user', content: 'hi' }] },
    })

    expect(path).toBe(join(home, '.xdpool', 'last-rejected-body.json'))
    const saved = JSON.parse(await readFile(path as string, 'utf8'))
    expect(saved.model).toBe('kimi-k3.1-pro')
    expect(saved.body.messages[0].content).toBe('hi')
  })

  it('keeps exactly one file however many refusals happen', async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordRejectedBody({
        at: `2026-10-30T11:42:4${i}.000Z`,
        model: 'glm-5.3',
        account: 'a',
        status: 400,
        upstream: 'nope',
        body: { attempt: i },
      })
    }

    const entries = await readdir(join(home, '.xdpool'))
    expect(entries).toEqual(['last-rejected-body.json'])
    const saved = JSON.parse(await readFile(join(home, '.xdpool', 'last-rejected-body.json'), 'utf8'))
    expect(saved.body.attempt).toBe(2)
  })

  it('keeps an unparseable body as text rather than dropping it', async () => {
    const path = await recordRejectedBody({
      at: '2026-10-30T11:42:46.000Z',
      model: 'kimi-k3.1-pro',
      account: 'a',
      status: 400,
      upstream: 'nope',
      body: '{"truncated',
    })

    const saved = JSON.parse(await readFile(path as string, 'utf8'))
    expect(saved.body).toBe('{"truncated')
  })

  it('stays silent when the dump is switched off', async () => {
    process.env['XDPOOL_NO_BODY_DUMP'] = '1'
    const path = await recordRejectedBody({
      at: '2026-10-30T11:42:46.000Z',
      model: 'kimi-k3.1-pro',
      account: 'a',
      status: 400,
      upstream: 'nope',
      body: { attempt: 0 },
    })

    expect(path).toBeUndefined()
    await expect(readdir(join(home, '.xdpool'))).rejects.toThrow(/ENOENT/)
  })
})
