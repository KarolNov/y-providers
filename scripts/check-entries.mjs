// Checks the built packages: an entry for one Yjs major never reaches the
// other major's packages, and `core` entries reach neither. Follows relative
// imports through the bundle's chunks. Run after `pnpm build`.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const V13 = ['yjs', 'y-protocols']
const V14 = ['@y/y', '@y/protocols']
const IMPORT =
  /(?:import|export)\s*(?:[^'"]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/** Bare specifiers reachable from `file` through relative imports. */
function reach(file, seen = new Set(), bare = new Set()) {
  if (seen.has(file)) return bare
  seen.add(file)
  for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
    const spec = m[1] ?? m[2]
    if (spec.startsWith('.')) reach(resolve(dirname(file), spec), seen, bare)
    else bare.add(spec)
  }
  return bare
}

const pkgOf = (spec) =>
  (spec.startsWith('@') ? spec.split('/').slice(0, 2) : spec.split('/').slice(0, 1)).join('/')

let failed = false
for (const dir of readdirSync('packages')) {
  const pkg = JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'))
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    const file = join('packages', dir, target.import)
    if (!existsSync(file)) continue
    const used = [...reach(file)].map(pkgOf)
    const v14 = /(^|\/)y14$/.test(sub)
    const core = /(^|\/)core$/.test(sub)
    const banned = core ? [...V13, ...V14] : v14 ? V13 : V14
    // An entry may reach another package's entry for the same major, never the other one's.
    const crossed = used.filter((p) => banned.includes(p))
    const wrongSibling = [...reach(file)].filter((s) =>
      core ? /\/y14$/.test(s) : v14 ? false : /\/y14$/.test(s),
    )
    const bad = [...crossed, ...wrongSibling]
    const label = `${pkg.name}${sub === '.' ? '' : sub.slice(1)}`
    if (bad.length) {
      failed = true
      console.error(`✗ ${label} reaches ${[...new Set(bad)].join(', ')}`)
    } else console.log(`✓ ${label}`)
  }
}
if (failed) process.exit(1)
