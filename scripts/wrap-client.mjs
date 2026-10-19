/**
 * Wrap the built browser half in the harness's client-module shell.
 *
 * `dsh-client-modules` evaluates each `dsh.client` package's `./client` bundle
 * as a script that calls
 * `window.__ModuleLoader__.load({ id, factory: (require) => exports })`.
 * tsdown emits a plain CJS module, so this script composes the two: it reads
 * `lib/client/index.cjs` (or `.js`), wraps the body in the factory, and writes
 * `lib/client/index.js` — the path `package.json`'s `./client` export points at.
 *
 * Run through `npm run bundle`; it is idempotent and exits nonzero on a missing
 * build input so a broken build cannot silently ship a stale bundle.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'lib', 'client')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const candidates = ['index.cjs', 'index.js']
const input = candidates.map(name => join(clientDir, name)).find(existsSync)
if (!input) {
  console.error(`[wrap-client] no client bundle found in ${clientDir} (looked for ${candidates.join(', ')})`)
  process.exit(1)
}

const body = readFileSync(input, 'utf8')
const out = join(clientDir, 'index.js')

// `require` inside the wrapper is the module system's resolver, so the inner CJS
// `require` calls must reach it rather than node's. The 2-arg factory matches
// what the harness's own bundles use.
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(packageJson.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body
  .split('\n')
  .map(line => (line.length === 0 ? '' : `\t\t${line}`))
  .join('\n')}
\t\treturn module.exports;
\t}
});
`

writeFileSync(out, wrapped, 'utf8')
if (input !== out) rmSync(input)

// A leftover .cjs.map or duplicate index would shadow the wrapped bundle.
for (const stale of ['index.cjs.map', 'index.cjs']) {
  const path = join(clientDir, stale)
  if (existsSync(path)) rmSync(path)
}

console.log(`[wrap-client] wrote ${out} (${wrapped.length} bytes)`)
