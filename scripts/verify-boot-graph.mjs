/**
 * Boot a dsh web host from a COPY of the web profile and report what a browser
 * would actually receive.
 *
 * Two facts decide whether the cross-transfer plugin can appear in the web UI:
 *   1. the plugin's client bundle is in the host's boot graph (it loads), and
 *   2. the served bundle carries the UI slot registration (it renders something).
 *
 * (2) is the one this script exists for: the bundle is assembled and served by
 * the host, so grepping the source file proves nothing about what the browser
 * gets. The host is started on an OS-assigned port with `--no-open`, and the
 * profile is copied into a temp DSH_HOME first, so a running host that shares
 * the real profile is never disturbed.
 *
 * Usage:
 *   node scripts/verify-boot-graph.mjs [--profile <dir>] [--marker <string>]
 *
 * Prints one JSON object on stdout and exits 0 when both facts hold.
 */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
/** Read one `--flag value` pair, or the fallback. */
function flag(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? '.'
const profileDir = resolve(flag('profile', join(homeDir, '.dsh', 'profiles', 'web')))
const marker = flag('marker', 'sidebar.footer.action')
const pluginId = flag('plugin', 'dsh-cross-transfer')
const dshBin = resolve(flag('dsh', join(homeDir, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))

if (!existsSync(profileDir)) throw new Error(`profile not found: ${profileDir}`)
if (!existsSync(dshBin)) throw new Error(`dsh launcher not found: ${dshBin}`)

const home = await mkdtemp(join(tmpdir(), 'dsh-bootcheck-'))
await cp(profileDir, join(home, 'profiles', 'web'), { recursive: true })

const child = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += String(chunk) })
child.stderr.on('data', (chunk) => { stderr += String(chunk) })

/** Wait for the launcher's `dsh web: <url>` line, or give up. */
async function waitForUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /dsh web:\s*(\S+)/.exec(stdout)
    if (match !== null) return match[1]
    if (child.exitCode !== null) throw new Error(`host exited early (${child.exitCode})\n${stdout}\n${stderr}`)
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`host printed no URL within ${timeoutMs}ms\n${stdout}\n${stderr}`)
}

/** Fetch the authenticated index, then the plugin's served bundle. */
async function inspect(url) {
  const target = new URL(url)
  const first = await fetch(target, { redirect: 'manual' })
  const cookie = first.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  const index = await fetch(new URL('/', target), { headers: cookie === '' ? {} : { cookie } })
  const html = await index.text()

  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const graphRow = new RegExp(`"id":"${escape(pluginId)}"[^}]*`, 'u').exec(html)?.[0] ?? null
  const combo = new RegExp(`plugins/\\?\\?${escape(pluginId)}/client\\.js[^"'&]*&rev=[^"&]*`, 'u').exec(html)?.[0] ?? null

  let bundleHasMarker = false
  let bundleBytes = 0
  let bundleStatus = 0
  if (combo !== null) {
    const bundle = await fetch(new URL(combo, target))
    bundleStatus = bundle.status
    const body = await bundle.text()
    bundleBytes = Buffer.byteLength(body)
    bundleHasMarker = body.includes(marker)
  }

  const restStatus = await fetch(new URL('/api/cross-transfer/rooms', target))
    .then((response) => response.status)
    .catch(() => 0)

  return { graphRow, combo, bundleStatus, bundleBytes, bundleHasMarker, restStatus, indexBytes: Buffer.byteLength(html) }
}

let report
try {
  const url = await waitForUrl(60_000)
  report = { ok: true, url, marker, pluginId, ...(await inspect(url)) }
} catch (error) {
  report = { ok: false, marker, pluginId, error: error instanceof Error ? error.message : String(error) }
} finally {
  child.kill()
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

report.inBootGraph = report.graphRow !== null
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(report.ok === true && report.inBootGraph === true && report.bundleHasMarker === true ? 0 : 1)
