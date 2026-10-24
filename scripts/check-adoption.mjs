#!/usr/bin/env node
/**
 * Prove the plugin is installed AND live on the host it runs against.
 *
 * The failure this exists to catch is silent: a bundle whose dsh requirement the
 * profile does not satisfy is skipped during profile load, nothing is printed,
 * and the host starts normally - so "installed" and "working" look identical
 * from the outside. The client half has the same shape of silence: a name in
 * `dsh.client.inject` that is not in the boot graph is skipped without a word.
 *
 * Each check answers one question a passing build does not:
 *   1. does the host accept this manifest at all (engines.dsh + dsh peers)?
 *   2. did the profile actually start this bundle, or skip it?
 *   3. are the loaded bytes the bytes this checkout builds?
 *   4. has apply run since the last restart (startup.log)?
 *   5. do the inject names resolve, or are some dead weight?
 *
 * Usage: node scripts/check-adoption.mjs [--profile <dir>] [--dsh-root <dir>] [--json]
 */

import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function flag(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error('--' + name + ' needs a value')
  return value
}

const dshRoot = resolve(flag('dsh-root', process.env.DSH_HARNESS_ROOT ?? 'D:\\Program Files\\DeepSeek Harness\\resources\\app\\dsh'))
const profileDir = resolve(flag('profile', process.env.DSH_PROFILE_DIR ?? join(process.env.DSH_HOME ?? '', 'profiles', 'desktop')))
const asJson = process.argv.includes('--json')

/**
 * Collected findings, so the exit code and the report cannot disagree.
 *
 * `warn` exists for the one check that cannot be a pass/fail: a client inject
 * name absent from this host's graph is skipped silently and has no effect here,
 * yet the same name is a real bundle on an older host line, so removing it to
 * turn the check green would break the other line.
 */
const results = []
function record(id, level, detail) {
  results.push({ id, level, detail })
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// 1. Does the host accept this manifest?
const manifest = readJson(join(ROOT, 'package.json'))
let runtimeVersion
let evaluate
try {
  const bootUrl = pathToFileURL(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href
  // A declared subpath, so it must go through ESM - `require` on the same file
  // fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
  ;({ evaluatePluginCompatibility: evaluate, getDshRuntimeVersion: runtimeVersion } = await import(bootUrl))
} catch (error) {
  console.error('cannot load the host compatibility gate from ' + dshRoot + ': ' + error.message)
  process.exit(2)
}

const hostVersion = runtimeVersion()
const issue = evaluate(manifest, {}, hostVersion)
record(
  'manifest-accepted',
  issue === undefined ? 'pass' : 'fail',
  issue === undefined
    ? manifest.name + '@' + manifest.version + ' is accepted by host ' + hostVersion
    : manifest.name + '@' + manifest.version + ' is REJECTED by host ' + hostVersion + ': ' + JSON.stringify(issue),
)

// 2. Did the profile start the bundle, or skip it?
const profileManifest = readJson(join(profileDir, 'package.json'))
const bundles = profileManifest.dsh?.profile?.bundles ?? []
record(
  'bundle-selected',
  bundles.includes(manifest.name) ? 'pass' : 'fail',
  bundles.includes(manifest.name)
    ? manifest.name + ' is in dsh.profile.bundles'
    : manifest.name + ' is NOT in dsh.profile.bundles (' + bundles.join(', ') + ') - the profile never loads it',
)

const exemptions = (() => {
  const path = join(profileDir, 'compatibility.json')
  if (!existsSync(path)) return {}
  try {
    return readJson(path)
  } catch {
    return {}
  }
})()
const exempted = Object.keys(exemptions).filter((key) => key.startsWith(manifest.name + '@'))
record(
  'no-exemption-needed',
  exempted.length === 0 ? 'pass' : 'fail',
  exempted.length === 0
    ? 'the declared range admits the running host, so no compatibility.json entry is needed'
    : 'riding on an exact-version exemption (' + exempted.join(', ') + ') - the next host patch stops it loading',
)

// 3. Are the loaded bytes the bytes this checkout builds?
const installedLib = join(profileDir, 'node_modules', manifest.name, 'lib')
const workspaceLib = join(ROOT, 'lib')
const drift = []
for (const file of ['index.js', 'client.js', 'bin.js']) {
  const a = join(workspaceLib, file)
  const b = join(installedLib, file)
  if (!existsSync(a) || !existsSync(b)) {
    drift.push(file + ': missing on ' + (existsSync(a) ? 'the installed side' : 'the workspace side'))
    continue
  }
  if (sha256(a) !== sha256(b)) drift.push(file + ': workspace and installed differ')
}
record(
  'installed-bytes-match-build',
  drift.length === 0 ? 'pass' : 'fail',
  drift.length === 0 ? 'lib/ in the profile is byte-identical to this checkout' : drift.join('; '),
)

// 4. Has apply run since the last restart?
const startupLog = join(process.env.DSH_HOME ?? '', '.xdpool', 'startup.log')
const applied = (() => {
  if (!existsSync(startupLog)) return undefined
  const lines = readFileSync(startupLog, 'utf8').trimEnd().split(/\r?\n/u)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes('apply entered')) return lines.slice(i, i + 5).join(' / ')
  }
  return undefined
})()
record(
  'apply-ran',
  applied !== undefined ? 'pass' : 'fail',
  applied === undefined
    ? 'no "apply entered" in ' + startupLog + ' - the host never ran this plugin apply'
    : 'last apply: ' + applied,
)

// 5. Do the inject names resolve in the boot graph?
const declaredInject = manifest.dsh?.client?.inject ?? []
const hostPatch = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml')
const graphNames = existsSync(hostPatch)
  ? new Set(
      readFileSync(hostPatch, 'utf8')
        .split(/\r?\n/u)
        .map((line) => /^\s*(?:-\s*)?name:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line)?.[1])
        .filter(Boolean),
    )
  : undefined
const unresolved = graphNames === undefined ? [] : declaredInject.filter((name) => !graphNames.has(name))
record(
  'inject-names-resolve',
  graphNames === undefined || unresolved.length > 0 ? 'warn' : 'pass',
  graphNames === undefined
    ? 'cannot read ' + hostPatch + ', so the inject names were not checked'
    : unresolved.length === 0
      ? 'all ' + declaredInject.length + ' inject names are in the host graph'
      : unresolved.join(', ') + ' are not in the host graph - skipped silently, no ordering effect',
)

// Report.
if (asJson) {
  console.log(JSON.stringify({ hostVersion, profileDir, results }, null, 2))
} else {
  console.log('host ' + hostVersion + '  profile ' + profileDir + '\n')
  for (const { id, level, detail } of results) {
    console.log(level.toUpperCase().padEnd(4) + '  ' + id + '\n      ' + detail)
  }
}
process.exit(results.every((r) => r.level !== 'fail') ? 0 : 1)
