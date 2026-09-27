#!/usr/bin/env node
/**
 * End-to-end verification for the bridge.
 *
 * Exercises the WHOLE chain the way Claude Code does:
 *
 *   this script --stdio JSON-RPC--> mcp-server --pipe--> broker
 *      --pipe--> host --native messaging--> extension --> a real browser
 *
 * It launches a REAL browser binary against a THROWAWAY --user-data-dir, so
 * none of the operator's actual profiles, sessions or open windows are touched.
 * A separate user-data-dir means a separate SingletonLock, so a browser the
 * operator already has open keeps running undisturbed.
 *
 *   node scripts/e2e.mjs                 headless Brave (default)
 *   node scripts/e2e.mjs --headed        watch it happen
 *   node scripts/e2e.mjs --chrome        use Chrome instead of Brave (see below)
 *   node scripts/e2e.mjs --keep          leave the browser and broker running
 *
 * BRAVE ONLY, AND THAT IS FINE. Google Chrome 152 ignores --load-extension
 * outright: it starts, but loads only its own component extensions. Measured
 * directly, and neither --enable-unsafe-extension-debugging nor
 * --disable-features=DisableLoadExtensionCommandLineSwitch revives it. That is a
 * limit of automated loading, NOT of the bridge: Chrome's own
 * chrome://extensions "Load unpacked" path is unaffected, which is how the
 * extension is actually installed.
 *
 * Brave is also the more valuable target to automate. The one genuinely
 * uncertain claim in the design was that Brave, which has no native-messaging
 * registry key of its own, would fall back to Chrome's. A green run here proves
 * exactly that. Chrome reading its OWN key is the least doubtful link in the
 * chain, and is confirmed by hand once the extension is loaded in a profile.
 *
 * Prerequisites: node scripts/keygen.mjs and node scripts/install-host.mjs.
 * The broker is started by this script; the scheduled task is not needed.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRODUCT_NAME } from '../shared/protocol.mjs'
import { PIPE_NAME } from '../shared/protocol.mjs'
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from '../shared/config.mjs'
import { RUNTIME_FILE, BASE_DIR, IS_MAC, IS_WINDOWS, STATE_FILE, TASK_NAME } from '../shared/paths.mjs'
import net from 'node:net'
import { resolveExtensionId } from './install-host.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const HEADED = argv.includes('--headed')
const KEEP = argv.includes('--keep')
const USE_CHROME = argv.includes('--chrome')

/** `--browser <path>` overrides the lookup below. */
function argValue(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] || null : null
}

/**
 * Where the browser binary usually is. First existing candidate wins; on Linux
 * the candidates are PATH lookups.
 */
function findBrowserExe(vendor) {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const lad = process.env.LOCALAPPDATA || ''
  const candidates = {
    win32: {
      chrome: [
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ],
      brave: [
        path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        path.join(lad, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      ],
    },
    darwin: {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    },
    linux: {
      chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
      brave: ['brave-browser', 'brave'],
    },
  }
  const platform = IS_WINDOWS ? 'win32' : IS_MAC ? 'darwin' : 'linux'
  for (const c of candidates[platform][vendor]) {
    if (platform === 'linux') {
      const r = spawnSync('which', [c], { encoding: 'utf8' })
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
    } else if (fs.existsSync(c)) {
      return c
    }
  }
  return null
}

const BROWSER = {
  name: USE_CHROME ? 'Chrome' : 'Brave',
  exe: argValue('--browser') || findBrowserExe(USE_CHROME ? 'chrome' : 'brave'),
}

const UDD = path.join(os.tmpdir(), `bridge-e2e-${process.pid}`)
const STATE_BACKUP = `${STATE_FILE}.e2e-backup`
const TEST_URL = 'https://example.com/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let broker = null
let browser = null
let mcp = null

function step(name, pass, detail = '') {
  results.push({ name, pass, detail })
  const mark = pass ? '  PASS' : '  FAIL'
  console.log(`${mark}  ${name}${detail ? `\n          ${String(detail).replace(/\n/g, '\n          ')}` : ''}`)
}

function head(t) {
  console.log(`\n${t}\n${'-'.repeat(t.length)}`)
}

/* -------------------------------------------------------------------------- */
/* A minimal MCP client over stdio - exactly the transport Claude Code uses     */
/* -------------------------------------------------------------------------- */

class McpClient {
  #child
  #buf = ''
  #pending = new Map()
  #nextId = 1

  start() {
    this.#child = spawn(process.execPath, [path.join(REPO, 'mcp-server', 'index.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO,
    })
    this.#child.stdout.on('data', (d) => this.#onData(d))
    this.#child.stderr.on('data', (d) => {
      if (process.env.E2E_DEBUG) process.stderr.write(`[mcp] ${d}`)
    })
    return this.#child
  }

  #onData(d) {
    this.#buf += d.toString('utf8')
    let i
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).trim()
      this.#buf = this.#buf.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        // A non-JSON line on stdout means something wrote to the protocol
        // stream. That is the exact class of bug the stdout guard exists to
        // prevent, so surface it loudly rather than skipping it.
        console.log(`  !! non-JSON on MCP stdout: ${line.slice(0, 200)}`)
        continue
      }
      const p = this.#pending.get(msg.id)
      if (p) {
        this.#pending.delete(msg.id)
        p(msg)
      }
    }
  }

  send(method, params) {
    const id = this.#nextId++
    const p = new Promise((res, rej) => {
      this.#pending.set(id, res)
      setTimeout(() => {
        if (this.#pending.delete(id)) rej(new Error(`timeout on ${method}`))
      }, 90_000)
    })
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return p
  }

  notify(method, params) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async call(name, args = {}) {
    const r = await this.send('tools/call', { name, arguments: args })
    const content = r.result?.content ?? []
    const text = content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    const image = content.find((c) => c.type === 'image') || null
    return { isError: !!r.result?.isError, text, image, raw: r }
  }

  stop() {
    this.#child?.kill()
  }
}

/* -------------------------------------------------------------------------- */
/* A minimal CDP client, used ONLY to drive the extension's own options page    */
/* through the one manual step in the product: claiming a line.                 */
/* -------------------------------------------------------------------------- */

class Cdp {
  #ws
  #id = 1
  #pending = new Map()

  async connect(wsUrl) {
    this.#ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      this.#ws.addEventListener('open', res, { once: true })
      this.#ws.addEventListener('error', rej, { once: true })
    })
    this.#ws.addEventListener('message', (ev) => {
      let m
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      const p = this.#pending.get(m.id)
      if (p) {
        this.#pending.delete(m.id)
        p(m)
      }
    })
  }

  send(method, params = {}) {
    const id = this.#id++
    const p = new Promise((res, rej) => {
      this.#pending.set(id, res)
      setTimeout(() => {
        if (this.#pending.delete(id)) rej(new Error(`CDP timeout on ${method}`))
      }, 20_000)
    })
    this.#ws.send(JSON.stringify({ id, method, params }))
    return p
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    return r.result?.result?.value
  }

  close() {
    try {
      this.#ws?.close()
    } catch {}
  }
}

/* -------------------------------------------------------------------------- */
/* The scheduled broker, stood down for the duration of a run                   */
/* -------------------------------------------------------------------------- */

let taskWasRunning = false
let taskWasDisabledByUs = false

function runSchtasks(args) {
  const r = spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

function taskIsRunning() {
  const r = runSchtasks(['/Query', '/TN', TASK_NAME, '/FO', 'LIST'])
  if (r.code !== 0) return false
  return /Status:\s*Running/i.test(r.out)
}

/** Is anything listening on the broker's pipe right now? */
function pipeIsBusy(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ path: PIPE_NAME })
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

/**
 * Take the scheduled broker out of the way and WAIT for it to actually let go.
 *
 * Ending the task stops wscript, not the broker, and the broker only stands
 * down when its parent watch next fires. Stopping it by the pid it publishes is
 * what makes this prompt; the pipe check is what makes that pid safe to use,
 * because a stale runtime.json plus pid reuse would otherwise aim the kill at
 * an unrelated process.
 */
async function standDownScheduledBroker() {
  // Disabling comes first. The watchdog repetition is live now, so an ended
  // task restarts the broker inside a minute, mid-run.
  const disabled = runSchtasks(['/Change', '/TN', TASK_NAME, '/DISABLE'])
  taskWasDisabledByUs = disabled.code === 0
  runSchtasks(['/End', '/TN', TASK_NAME])

  if (await pipeIsBusy()) {
    try {
      const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'))
      if (rt?.pid) process.kill(rt.pid, 'SIGTERM')
    } catch {
      // No runtime file, or it is already gone. The wait below is the check.
    }
  }

  for (let i = 0; i < 40; i++) {
    if (!(await pipeIsBusy())) return true
    await sleep(500)
  }
  return false
}

function restoreScheduledBroker() {
  // Re-enable only what this script disabled. Leaving the task disabled would
  // silently end the always-on guarantee, and enabling one that arrived
  // disabled would override a deliberate choice.
  if (taskWasDisabledByUs) runSchtasks(['/Change', '/TN', TASK_NAME, '/ENABLE'])
  if (!taskWasRunning) return
  runSchtasks(['/Run', '/TN', TASK_NAME])
}

async function devtoolsPort(udd) {
  for (let i = 0; i < 60; i++) {
    const f = path.join(udd, 'DevToolsActivePort')
    if (fs.existsSync(f)) {
      const p = fs.readFileSync(f, 'utf8').split('\n')[0].trim()
      if (p) return p
    }
    await sleep(500)
  }
  return null
}

/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`${PRODUCT_NAME} end-to-end verification`)
  console.log(`  browser      ${BROWSER.name} (${HEADED ? 'headed' : 'headless'})`)
  console.log(`  profile      ${UDD}   (throwaway - your real profiles are untouched)`)
  console.log(`  pipe         ${PIPE_NAME}`)
  console.log(`  state        ${BASE_DIR}`)

  if (!BROWSER.exe || !fs.existsSync(BROWSER.exe)) {
    console.log(`\nCannot find ${BROWSER.name}${BROWSER.exe ? ` at ${BROWSER.exe}` : ''}. Pass --browser <path to the binary>.`)
    process.exit(2)
  }

  head('1. Broker')

  // On macOS and Linux the supervisor restarts a stopped broker at once, so
  // this harness cannot stand it down the way it disables the Windows task.
  // Refuse rather than silently test the long-lived broker.
  if (!IS_WINDOWS && (await pipeIsBusy())) {
    console.log(
      `\n  A broker is already answering on ${PIPE_NAME}. Stop the installed service first:\n` +
        `    ${IS_MAC ? `launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}` : `systemctl --user stop ${SYSTEMD_UNIT}`}\n` +
        '  then re-run this harness, and start the service again afterwards.\n'
    )
    process.exit(2)
  }

  // Stand the scheduled broker down for the duration.
  //
  // Only one process can own the pipe. With the task installed, this script's
  // own broker loses the bind and exits, and the run silently proceeds against
  // the long-lived broker instead - which then accumulates a phantom route from
  // every run, because each throwaway profile mints a fresh installId. Taking
  // the task down gives every run a clean broker and leaves no residue.
  if (taskIsRunning()) {
    taskWasRunning = true
    const freed = await standDownScheduledBroker()
    step(
      'scheduled broker stood down for the run',
      freed,
      freed
        ? `task disabled and pipe released; will restore "${TASK_NAME}" on exit`
        : 'the pipe is still busy, so this run would test the long-lived broker'
    )
  }

  // Each run registers a brand new installId, so without this every run leaves
  // a permanent phantom "configured but not connected" line behind in the real
  // state file. Back it up and put it back on the way out.
  if (fs.existsSync(STATE_FILE)) {
    fs.copyFileSync(STATE_FILE, STATE_BACKUP)
    fs.rmSync(STATE_FILE, { force: true })
  }

  broker = spawn(process.execPath, [path.join(REPO, 'bridged', 'index.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO,
  })
  let brokerErr = ''
  broker.stderr.on('data', (d) => {
    brokerErr += d
    if (process.env.E2E_DEBUG) process.stderr.write(`[broker] ${d}`)
  })

  let up = false
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (fs.existsSync(RUNTIME_FILE)) {
      const rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'))
      if (rt.pid && rt.token) {
        up = true
        step('broker started and published runtime.json', true, `pid ${rt.pid}, token ${rt.token.slice(0, 8)}...`)
        break
      }
    }
  }
  if (!up) {
    step('broker started', false, brokerErr.slice(0, 600))
    return finish()
  }

  head('2. Browser with the extension loaded')
  fs.rmSync(UDD, { recursive: true, force: true })
  fs.mkdirSync(UDD, { recursive: true })
  const bArgs = [
    `--user-data-dir=${UDD}`,
    `--load-extension=${path.join(REPO, 'extension')}`,
    `--disable-extensions-except=${path.join(REPO, 'extension')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-background-networking',
    '--remote-debugging-port=0',
  ]
  if (!HEADED) bArgs.push('--headless=new')
  bArgs.push(TEST_URL)

  browser = spawn(BROWSER.exe, bArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  let bErr = ''
  browser.stderr.on('data', (d) => {
    bErr += d
    if (process.env.E2E_DEBUG) process.stderr.write(`[browser] ${d}`)
  })
  step(`${BROWSER.name} launched`, true, bArgs.filter((a) => a.startsWith('--load')).join(' '))

  head('3. The extension finds the broker')
  mcp = new McpClient()
  mcp.start()
  await mcp.send('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'bridge-e2e', version: '1.0.0' },
  })
  mcp.notify('notifications/initialized')

  const tools = await mcp.send('tools/list', {})
  const toolNames = (tools.result?.tools || []).map((t) => t.name)
  step(`MCP server exposes ${toolNames.length} tools`, toolNames.length >= 16, toolNames.join(', '))

  // Pick a line that is actually CONNECTED. A label shown as "absent" is a
  // leftover registration from an earlier run, and driving one proves nothing.
  const connectedLabel = (text) => {
    for (const line of text.split('\n')) {
      const m = /\b((?:brave|chrome|edge|unknown)-[a-z0-9-]+(?:#\d+)?)\b/.exec(line)
      if (m && !/\babsent\b/i.test(line)) return m[1]
    }
    return null
  }

  let profile = null
  let listText = ''
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const r = await mcp.call('browser_list_profiles')
    listText = r.text
    if (r.isError) continue
    const label = connectedLabel(r.text)
    if (label) {
      profile = label
      break
    }
  }
  if (!profile && USE_CHROME) {
    console.log(
      '\n  Chrome 152 ignores --load-extension, so the extension never loaded and this is\n' +
        '  expected. It is a limitation of automated loading, not of the bridge: the\n' +
        '  chrome://extensions "Load unpacked" path still works and is how the extension\n' +
        '  is really installed. Run without --chrome to exercise the full chain on Brave.\n'
    )
    results.pop()
    return finish()
  }
  step('a profile registered with the broker', !!profile, profile ? `label: ${profile}` : listText.slice(0, 700))
  if (!profile) return finish()

  console.log(`\n${listText.trim().split('\n').slice(0, 14).join('\n')}\n`)

  head('4. Claiming the line, through the real options page')

  // This is the one manual step in the whole product. Rather than reaching
  // around it, the harness drives the actual UI the way a human would: it opens
  // the extension's options page in the browser and clicks a claim button.
  // The same derivation install-host used: the manifest key when there is one,
  // the folder path otherwise. --load-extension hashes the path it is given,
  // so the keyless case is exactly what a fresh clone exercises.
  const resolved = resolveExtensionId({
    manifest: JSON.parse(fs.readFileSync(path.join(REPO, 'extension', 'manifest.json'), 'utf8')),
  })
  const extId = resolved.id || ''
  step(`extension id derived from the ${resolved.source || 'manifest'}`, extId.length === 32, extId)

  const port = await devtoolsPort(UDD)
  let cdp = null
  if (port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()

    const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId))
    step(
      'the extension service worker is running under the pinned id',
      !!sw,
      sw ? sw.url : `no service_worker target for ${extId}`
    )

    // Open the options page in its OWN tab. Navigating the test tab there would
    // leave the profile's active tab on a chrome-extension:// URL, which every
    // page operation then correctly refuses - a self-inflicted failure that
    // says nothing about the product.
    const optionsUrl = `chrome-extension://${extId}/options/index.html`
    let optTarget = null
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(optionsUrl)}`, {
        method: 'PUT',
      })
      optTarget = await res.json()
    } catch {
      optTarget = null
    }

    await sleep(3500)
    const after1 = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = after1.find((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${extId}`))
    if (page) {
      cdp = new Cdp()
      await cdp.connect(page.webSocketDebuggerUrl)
      await cdp.send('Runtime.enable')
      await sleep(1500)

      const rendered = await cdp.evaluate(
        `(() => {
           const t = document.title || ''
           const wordmark = document.body.innerText.slice(0, 400)
           const claims = document.querySelectorAll('.claim-option').length
           const err = document.body.innerText.match(/failed to load|E_NO_WORKER|E_NO_EXTENSION/i)
           return JSON.stringify({ t, claims, err: err ? err[0] : null, wordmark })
         })()`
      )
      const r = JSON.parse(rendered || '{}')
      step(
        'the options page renders (no fatal load error)',
        !r.err && new RegExp(PRODUCT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(String(r.wordmark) + String(r.t)),
        r.err ? `page shows: ${r.err}` : `title "${r.t}", ${r.claims} claim option(s)`
      )

      // A browser writes a stub Local State immediately and only flushes its
      // real profile list seconds later, so claim options legitimately arrive
      // late. The page re-reads them on every poll; wait for that rather than
      // sampling once.
      for (let i = 0; i < 30 && r.claims === 0; i++) {
        await sleep(1000)
        r.claims = Number(await cdp.evaluate("document.querySelectorAll('.claim-option').length")) || 0
      }
      step('claim options appear once the browser writes its profile list', r.claims > 0, `${r.claims} option(s)`)

      if (r.claims > 0) {
        const clicked = await cdp.evaluate(
          `(() => { const b = document.querySelector('.claim-option'); if(!b) return 'none'; b.click(); return b.innerText.replace(/\\s+/g,' ').trim(); })()`
        )
        step('clicked a claim option in the real UI', clicked !== 'none', String(clicked).slice(0, 120))
        await sleep(2500)
      }
    }
  } else {
    step('devtools port available for UI checks', false, 'DevToolsActivePort never appeared')
  }

  // Poll for a line that is BOTH connected and no longer unclaimed.
  //
  // Two things made the naive version wrong. A claim travels UI -> service
  // worker -> host -> broker and only then shows up in a board read, so
  // sampling once races it. And asserting that the word "unclaimed" is absent
  // from the whole board fails whenever a long-lived broker legitimately
  // remembers lines from earlier runs - which is exactly what happens once the
  // scheduled task is installed. Scope the assertion to a single line.
  const claimedLine = (text) => {
    for (const line of text.split('\n')) {
      const m = /\b((?:brave|chrome|edge)-[a-z0-9-]+(?:#\d+)?)\b/.exec(line)
      if (m && !/\babsent\b/i.test(line) && !/\bunclaimed\b/i.test(line)) return m[1]
    }
    return null
  }

  let claimed = null
  for (let i = 0; i < 20 && !claimed; i++) {
    const r = await mcp.call('browser_list_profiles')
    claimed = claimedLine(r.text)
    if (!claimed) await sleep(750)
  }
  if (claimed) profile = claimed
  step('the line is now claimed', !!claimed, `label: ${profile}`)
  cdp?.close()

  head('5. Read operations')

  const tabs = await mcp.call('browser_list_tabs', { profile })
  const handle = (/\b(tab_[A-Za-z0-9#_-]+)\b/.exec(tabs.text) || [])[1] || null
  step('browser_list_tabs returns opaque handles', !tabs.isError && !!handle, handle ? `handle: ${handle}` : tabs.text.slice(0, 500))
  const rawLeak = /"tabId"\s*:/.test(tabs.text)
  step('no raw Chrome tab id leaks to the model', !rawLeak, rawLeak ? 'found a tabId key in the output' : 'handles only')

  if (handle) {
    const wrong = await mcp.call('browser_click', { profile, tab: 'tab_some-other-profile_1_7', ref: 'e1' })
    step(
      'a handle from another profile is refused',
      wrong.isError && /handle/i.test(wrong.text),
      wrong.text.split('\n')[0]?.slice(0, 200)
    )

    const page = await mcp.call('browser_read_page', { profile, tab: handle, format: 'text' })
    step(
      'browser_read_page (text) returns the real page',
      !page.isError && /example/i.test(page.text),
      page.text.slice(0, 260).replace(/\s+/g, ' ')
    )

    const snap = await mcp.call('browser_read_page', { profile, tab: handle, format: 'snapshot' })
    step(
      'browser_read_page (snapshot) lists refs, not raw JSON',
      !snap.isError && !/unexpected readPage payload/i.test(snap.text),
      snap.text.slice(0, 260).replace(/\s+/g, ' ')
    )

    const shot = await mcp.call('browser_screenshot', { profile, tab: handle })
    const kb = shot.image ? Math.round((shot.image.data.length * 3) / 4 / 1024) : 0
    step(
      'browser_screenshot returns an image block',
      !shot.isError && !!shot.image,
      shot.image ? `${shot.image.mimeType}, ~${kb} KB base64, ${shot.text.split('\n')[0]}` : shot.text.slice(0, 300)
    )

    const scroll = await mcp.call('browser_scroll', { profile, tab: handle, direction: 'down', amount: 200 })
    step('browser_scroll works', !scroll.isError, scroll.text.split('\n')[0]?.slice(0, 200))

    head('6. Write operations')

    const nav = await mcp.call('browser_navigate', { profile, url: 'https://example.com/?bridge=1' })
    step('browser_navigate with no tab uses the active tab', !nav.isError, nav.text.split('\n')[0]?.slice(0, 220))

    const bad = await mcp.call('browser_navigate', { profile, url: 'file:///C:/Windows/win.ini' })
    step(
      'file:// is refused (no unarmed local-file read)',
      bad.isError && /refus|restrict/i.test(bad.text),
      bad.text.split('\n')[0]?.slice(0, 220)
    )

    head('7. Arming')

    const unarmed = await mcp.call('browser_eval_js', { profile, tab: handle, expression: '1+1' })
    step(
      'browser_eval_js is refused before arming',
      unarmed.isError && /arm/i.test(unarmed.text),
      unarmed.text.split('\n')[0]?.slice(0, 220)
    )

    const arm = await mcp.call('bridge_arm', { profile, minutes: 2 })
    step('bridge_arm succeeds', !arm.isError, arm.text.split('\n')[0]?.slice(0, 220))

    const armed = await mcp.call('browser_eval_js', {
      profile,
      tab: handle,
      expression: 'document.title + "|" + (1+1)',
    })
    step(
      'browser_eval_js runs once armed',
      !armed.isError && /\|2/.test(armed.text),
      armed.text.slice(0, 220).replace(/\s+/g, ' ')
    )

    // The MCP schema caps this at MAX_ARM_MINUTES, so an over-long request is
    // refused at validation rather than silently clamped. That is the better
    // behavior: the model is told the real ceiling instead of getting a
    // cheerful confirmation for a window it did not actually get.
    const over = await mcp.call('bridge_arm', { profile, minutes: 999 })
    step(
      'an over-long arm is refused, naming the real ceiling',
      over.isError && /60/.test(over.text),
      over.text.split('\n')[0]?.slice(0, 220)
    )
  }

  head('8. Health')
  const status = await mcp.call('bridge_status')
  step('bridge_status reports the board', !status.isError, status.text.split('\n').slice(0, 6).join(' | ').slice(0, 400))

  const unknown = await mcp.call('browser_list_tabs', { profile: 'brave-does-not-exist' })
  step(
    'an unknown profile lists the real ones',
    unknown.isError && /brave|chrome|unknown-/i.test(unknown.text),
    unknown.text.split('\n')[0]?.slice(0, 240)
  )

  return finish()
}

function finish() {
  head('Result')
  const failed = results.filter((r) => !r.pass)
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('\n  failed:')
    for (const f of failed) console.log(`    - ${f.name}`)
  }

  /**
   * Put the operator's real route registry back exactly as it was.
   *
   * ORDER MATTERS, and getting it wrong is silent. This ran before the broker
   * was killed at first, so the broker persisted its own state on the way down
   * and overwrote the restore - every run still leaked a phantom route, while
   * appearing to clean up after itself. The broker must be dead first.
   */
  const restoreState = () => {
    try {
      if (fs.existsSync(STATE_BACKUP)) {
        fs.copyFileSync(STATE_BACKUP, STATE_FILE)
        fs.rmSync(STATE_BACKUP, { force: true })
      } else {
        fs.rmSync(STATE_FILE, { force: true })
      }
    } catch {}
  }

  if (!KEEP) {
    mcp?.stop()
    browser?.kill('SIGKILL')
    broker?.kill('SIGKILL')
    setTimeout(() => {
      restoreState()
      fs.rmSync(UDD, { recursive: true, force: true })
      restoreScheduledBroker()
      process.exit(failed.length ? 1 : 0)
    }, 1500)
  } else {
    console.log(`\n  --keep: broker and ${BROWSER.name} left running. Profile at ${UDD}`)
    console.log(`  state.json is NOT restored while --keep is in effect; backup at ${STATE_BACKUP}`)
    process.exit(failed.length ? 1 : 0)
  }
}

main().catch((e) => {
  console.error('\nharness error:', e)
  finish()
})
