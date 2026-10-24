#!/usr/bin/env node
/**
 * Report and remove profile links whose target no longer exists.
 *
 * A dead link is inert: `linkedProfileRoots` in the host's app-boot catches the
 * ENOENT from `realModuleDirectory` and `continue`s, so a profile full of them
 * starts normally. That is exactly why they are worth removing - they make
 * "is this package installed?" unanswerable, because a directory that looks
 * present resolves to nothing. The classic case is a harness upgrade that moved
 * its install directory: every link the old location projected stays behind,
 * pointing at a path that is gone.
 *
 * Links whose module still exists under the live harness are REPOINTED rather
 * than deleted, so the shared layer keeps serving the same names.
 *
 * Usage:
 *   node scripts/repair-profile-links.mjs                 # report only
 *   node scripts/repair-profile-links.mjs --apply         # repoint + remove
 *   node scripts/repair-profile-links.mjs --apply --dsh-home <dir> --dsh-root <dir>
 */

import { readdirSync, lstatSync, existsSync, rmdirSync, symlinkSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'

function flag(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error('--' + name + ' needs a value')
  return value
}

const apply = process.argv.includes('--apply')
const dshHome = resolve(flag('dsh-home', process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')))
const dshRoot = resolve(flag('dsh-root', process.env.DSH_HARNESS_ROOT ?? 'D:\\Program Files\\DeepSeek Harness\\resources\\app\\dsh'))

/**
 * Every link in the profile layer, without following any of them.
 *
 * The walk stops at `node_modules` plus one scope directory: those are the only
 * places the host projects packages, and descending further would follow real
 * package trees for no gain. Anything outside a node_modules tree is user data
 * and is never touched.
 */
function linksUnder(root) {
  const found = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      let stat
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) {
        found.push(path)
        continue
      }
      if (!stat.isDirectory()) continue
      if (entry.name === 'node_modules') walk(path, 1)
      else if (depth === 1 && entry.name.startsWith('@')) walk(path, 2)
    }
  }
  walk(join(root, 'profiles'), 0)
  return found
}

function targetOf(path) {
  const raw = readlinkSync(path)
  // A junction's reparse target is absolute; a symlink's may be relative to the link.
  return resolve(dirname(path), raw)
}

/** The bare module specifier a link stands for, e.g. `@scope/name`. */
function moduleName(path) {
  const parent = dirname(path)
  const name = parent.split(sep).pop()
  return name.startsWith('@') ? name + '/' + path.split(sep).pop() : path.split(sep).pop()
}

const liveModules = join(dshRoot, 'node_modules')
const links = linksUnder(dshHome)
const dead = [];
const alive = [];
for (const path of links) {
  let target
  try {
    target = targetOf(path)
  } catch {
    target = undefined
  }
  if (target !== undefined && existsSync(target)) alive.push({ path, target })
  else dead.push({ path, target, name: moduleName(path) })
}

const repoint = [];
const remove = [];
for (const entry of dead) {
  const candidate = join(liveModules, entry.name)
  if (existsSync(candidate)) repoint.push({ ...entry, candidate })
  else remove.push(entry);
}

console.log('dsh home   ' + dshHome)
console.log('harness    ' + dshRoot)
console.log('links      ' + links.length + '  alive ' + alive.length + '  dead ' + dead.length + '\n')

const groupBy = (rows, key) => {
  const map = new Map()
  for (const row of rows) {
    const bucket = key(row)
    map.set(bucket, (map.get(bucket) ?? 0) + 1)
  }
  return [...map].sort((a, b) => b[1] - a[1])
}
for (const [target, count] of groupBy(dead, (row) => (row.target === undefined ? '<unreadable>' : row.target.split('node_modules')[0]))) {
  console.log('  ' + String(count).padStart(4) + '  ' + target)
}
console.log('')
console.log('repoint (' + repoint.length + ')  the module still exists under the live harness')
for (const row of repoint) console.log('  ' + row.name + '  ->  ' + row.candidate)
console.log('remove  (' + remove.length + ')  nothing under the live harness serves this name')
for (const row of remove.slice(0, 12)) console.log('  ' + relative(dshHome, row.path))
if (remove.length > 12) console.log('  ... and ' + (remove.length - 12) + ' more')

if (!apply) {
  console.log('\nreport only - re-run with --apply to make these changes')
  process.exit(0)
}

// A manifest of what was changed, so the operation can be reviewed afterwards.
const manifestPath = join(dshHome, 'profile-links-repair.json')
writeFileSync(
  manifestPath,
  JSON.stringify({ at: new Date().toISOString(), dshRoot, repointed: repoint, removed: remove.map((r) => ({ path: r.path, target: r.target })) }, null, 2) + '\n',
)

let failed = 0
for (const row of repoint) {
  try {
    // rmdirSync removes the reparse point itself and never the target.
    rmdirSync(row.path)
    symlinkSync(row.candidate, row.path, 'junction')
  } catch (error) {
    failed += 1
    console.log('FAILED repoint ' + row.path + ': ' + error.message)
  }
}
for (const row of remove) {
  try {
    rmdirSync(row.path)
  } catch (error) {
    failed += 1
    console.log('FAILED remove ' + row.path + ': ' + error.message)
  }
}

const remaining = linksUnder(dshHome).filter((path) => {
  try {
    return !existsSync(targetOf(path))
  } catch {
    return true
  }
});
console.log('\nrepointed ' + (repoint.length - failed) + '  removed ' + remove.length + '  failures ' + failed)
console.log('dead links remaining: ' + remaining.length)
console.log('manifest: ' + manifestPath)
process.exit(failed === 0 ? 0 : 1)
