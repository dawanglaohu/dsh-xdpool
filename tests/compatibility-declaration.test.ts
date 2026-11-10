/**
 * Guard the declarations a user reads BEFORE they trust the plugin.
 *
 * A false compatibility declaration is expensive in a specific way: it makes
 * everyone diagnose in the wrong direction. `engines.dsh` said `<0.2.0` while
 * the card demonstrably worked on 0.2.0, so the first thing anyone did was
 * assume the plugin was out of range — and a bug report was filed and later
 * withdrawn on that assumption.
 *
 * These tests keep the stated range and the documented entry point honest, since
 * both are cheap to let rot.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  version?: string
  dsh?: {
    bundle?: { patch?: string; platforms?: unknown }
    client?: { inject?: readonly string[], platform?: string }
  }
}
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const adapterSource = readFileSync(join(ROOT, 'src', 'adapter.ts'), 'utf8')

describe('engines.dsh admits the generation that actually works', () => {
  it('allows 0.2.x', () => {
    const range = pkg.engines?.['dsh'] ?? ''
    expect(range).not.toBe('')
    // The concrete regression: `<0.2.0` excluded a host the plugin runs on
    // fine, so the declaration contradicted reality.
    expect(range).toContain('<0.3.0')
  })

  it('still refuses a major version it has never been tested against', () => {
    // Widening is not "accept anything": an untested major should still be
    // flagged by the range rather than silently claimed as supported.
    const range = pkg.engines?.['dsh'] ?? ''
    expect(range).not.toMatch(/^>=0\.1\.5-rc\.1$/)
    expect(range).toContain('<0.3.0')
  })

  it('keeps the host peer ranges in step with engines.dsh', () => {
    // These bound the SAME host packages; letting them disagree is how the
    // original inconsistency appeared.
    for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-settings']) {
      const range = pkg.peerDependencies?.[name] ?? ''
      expect(range, `${name} must admit the 0.2.x line too`).toContain('<0.3.0')
    }
  })
})

describe('the README points at the entry point that exists', () => {
  it('does not INSTRUCT the reader to use the removed 0.1.x path', () => {
    // "设置 → 插件 → DSH WorkBuddy XD Pool" was right for 0.1.x and is wrong
    // from 0.2.0 on, where the card is a PEER tab of 通用设置/模型/内置插件.
    //
    // A historical mention is fine and deliberately kept — it is what tells an
    // upgrading user why their old habit stopped working. What must not appear
    // is that path as an INSTRUCTION, so the assertions target the imperative
    // forms (the image caption and the "装完以后" line) rather than the string
    // appearing anywhere at all.
    expect(readme).not.toMatch(/插件配置卡片（设置 → 插件/u)
    expect(readme).not.toMatch(/装完以后：[^。]*设置 → 插件/u)
    // And the explanatory mention must be framed as history, not as guidance.
    const mention = /（0\.1\.x 时代它叫「设置 → 插件 → DSH WorkBuddy XD Pool」[^）]*）/u.exec(readme)
    expect(mention, 'the old path may only appear as a historical note').not.toBeNull()
    expect(mention?.[0]).toContain('找不到')
  })

  it('names the tab the user will actually see', () => {
    expect(readme).toContain('XD Pool')
  })

  it('says how to OPEN the settings panel', () => {
    // The entry point is only actionable with the way in: the gear in the
    // sidebar, or the shortcut.
    expect(readme).toMatch(/Ctrl\+Alt\+,/)
  })

  it('does not still claim adaptation to the 0.1.2 host alone', () => {
    expect(readme).not.toContain('已针对 DSH Desktop host `0.1.2` 适配')
    expect(readme).toContain('0.2.0')
  })
})

describe('the image budgets keep the 0.2.2 count fields', () => {
  // dsh-llm-pi-ai 0.2.2 made `maxRequestImages` and `imageOffloadCountQuantum`
  // REQUIRED on `ResolvedPiAiProviderProfile`. We build that profile by hand, so
  // the compiler already refuses a regression — but only while the dependency is
  // the 0.2.2 generation. Pinned back to 0.2.1 (or a future line that renames
  // them) the type check goes quiet again while the runtime consequence stays:
  // `requiredImageOffload()` reads `budget.maxImages === undefined ? 0 : …`, so a
  // missing field silently disables the whole image-COUNT bound and leaves only
  // the 20 MB byte budget. Nothing throws; requests just carry far more images
  // than intended, and the offload step degrades to one image at a time.
  it('declares both count fields', () => {
    expect(adapterSource).toMatch(/\bmaxRequestImages:\s*\d+/)
    expect(adapterSource).toMatch(/\bimageOffloadCountQuantum:\s*\d+/)
  })

  it('keeps the quantum within the count bound', () => {
    const count = /maxRequestImages:\s*(\d+)/.exec(adapterSource)?.[1]
    const quantum = /imageOffloadCountQuantum:\s*(\d+)/.exec(adapterSource)?.[1]
    expect(count, 'maxRequestImages must be a literal so this check can read it').toBeDefined()
    expect(quantum, 'imageOffloadCountQuantum must be a literal so this check can read it').toBeDefined()
    // The upstream validator states the same rule:
    // "imageOffloadCountQuantum must be a positive safe integer no greater than
    // maxRequestImages". It only runs on the config-driven path, which we bypass.
    expect(Number(quantum)).toBeGreaterThan(0)
    expect(Number(quantum)).toBeLessThanOrEqual(Number(count))
  })
})

describe('the bundle platform gate stays declarative', () => {
  // 0.2.2's app-boot validates `dsh.bundle.platforms` and refuses to start when
  // the Host is not in it. Omitted means "every platform", so declaring it is a
  // tightening — and a mistyped entry would turn a working install into a
  // startup refusal, which is a far worse failure than the one it guards.
  it('names Node platform ids, not marketing names', () => {
    const platforms = pkg.dsh?.bundle?.platforms
    expect(Array.isArray(platforms), 'declared platforms must be a list').toBe(true)
    const list = platforms as readonly unknown[]
    expect(list.length).toBeGreaterThan(0)
    for (const platform of list) {
      expect(typeof platform).toBe('string')
      // `process.platform` values only. "windows" or "macos" would be rejected
      // by assertBundlePlatform() as invalid metadata and block startup.
      expect(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd',
        'sunos', 'win32', 'cygwin', 'netbsd']).toContain(platform)
    }
  })
})
