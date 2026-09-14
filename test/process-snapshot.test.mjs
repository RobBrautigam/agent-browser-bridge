/**
 * The process-ancestry walk that tells the broker WHICH browser spawned a host.
 *
 * The extension's own vendor claim is corroboration, never the verdict, so
 * this walk is what stands between a Brave profile and a Chrome label. It is
 * exercised here on fixture process tables for all three platforms; the
 * snapshot itself (WMI on Windows, ps elsewhere) is not run.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { findBrowserProcess, parsePsSnapshot } from '../bridged/profiles.mjs'

/* ---- macOS -------------------------------------------------------------- */

const MAC_PS = [
  '    1     0 launchd          /sbin/launchd',
  '  600     1 Brave Browser    /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=/tmp/scratch-ud',
  '  601   600 Brave Browser Helper /Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Helpers/Brave Browser Helper.app/Contents/MacOS/Brave Browser Helper --type=renderer',
  '  700   600 sh               /bin/sh /Users/alice/Library/Application Support/agent-browser-bridge/host-launcher.sh chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
  '  701   700 node             /usr/local/bin/node /Users/alice/dev/agent-browser-bridge/host/index.mjs chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
  '  800     1 Google Chrome    /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '  801   800 sh               /bin/sh /Users/alice/Library/Application Support/agent-browser-bridge/host-launcher.sh chrome-extension://x/',
  '  802   801 node             /usr/local/bin/node /Users/alice/dev/agent-browser-bridge/host/index.mjs chrome-extension://x/',
].join('\n')

test('macOS: a multi-word comm like "Brave Browser" parses, and the walk finds the vendor and user-data-dir', async () => {
  const table = parsePsSnapshot(MAC_PS)
  assert.equal(table.get(600).name, 'brave browser')
  assert.equal(table.get(700).name, 'sh')
  assert.equal(table.get(701).ppid, 700)

  const brave = await findBrowserProcess(701, table)
  assert.equal(brave?.vendor, 'brave')
  assert.equal(brave?.userDataDir, '/tmp/scratch-ud')

  const chrome = await findBrowserProcess(802, table)
  assert.equal(chrome?.vendor, 'chrome')
  assert.equal(chrome?.userDataDir, null, 'no --user-data-dir means the default directory')
})

/* ---- Linux -------------------------------------------------------------- */

const LINUX_PS = [
  '      1       0 systemd          /sbin/init',
  '   2000       1 chrome           /opt/google/chrome/chrome',
  '   2001    2000 sh               /bin/sh /home/alice/.local/state/agent-browser-bridge/host-launcher.sh chrome-extension://x/',
  '   2002    2001 node             /usr/bin/node /home/alice/agent-browser-bridge/host/index.mjs chrome-extension://x/',
  '   3000       1 brave            /opt/brave.com/brave/brave --user-data-dir="/home/alice/scratch ud"',
  '   3001    3000 node             /usr/bin/node /home/alice/agent-browser-bridge/host/index.mjs chrome-extension://y/',
].join('\n')

test('Linux: bare binary names resolve, including a quoted user-data-dir', async () => {
  const table = parsePsSnapshot(LINUX_PS)
  assert.equal((await findBrowserProcess(2002, table))?.vendor, 'chrome')
  const brave = await findBrowserProcess(3001, table)
  assert.equal(brave?.vendor, 'brave')
  assert.equal(brave?.userDataDir, '/home/alice/scratch ud')
})

/* ---- Windows ------------------------------------------------------------ */

function winTable(rows) {
  const table = new Map()
  for (const [pid, ppid, name, cmdline = ''] of rows) {
    table.set(pid, { pid, ppid, name: name.toLowerCase(), exe: `C:\\x\\${name}`, cmdline })
  }
  return table
}

test('Windows: node -> cmd.exe -> chrome.exe resolves through the shim', async () => {
  const table = winTable([
    [4, 0, 'System'],
    [100, 4, 'explorer.exe'],
    [200, 100, 'chrome.exe', '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'],
    [300, 200, 'cmd.exe'],
    [400, 300, 'node.exe'],
  ])
  const found = await findBrowserProcess(400, table)
  assert.deepEqual(found, { vendor: 'chrome', exe: 'C:\\x\\chrome.exe', userDataDir: null })
})

test('Windows: msedge.exe resolves to edge, brave.exe to brave', async () => {
  const table = winTable([
    [10, 0, 'msedge.exe'],
    [11, 10, 'node.exe'],
    [20, 0, 'brave.exe', 'brave.exe --user-data-dir=D:\\profiles\\one\\'],
    [21, 20, 'node.exe'],
  ])
  assert.equal((await findBrowserProcess(11, table))?.vendor, 'edge')
  const brave = await findBrowserProcess(21, table)
  assert.equal(brave?.vendor, 'brave')
  assert.equal(brave?.userDataDir, 'D:\\profiles\\one', 'trailing separators are stripped')
})

/* ---- Guards ------------------------------------------------------------- */

test('no browser in the ancestry means null, never a guessed vendor', async () => {
  const table = winTable([
    [1, 0, 'wininit.exe'],
    [2, 1, 'services.exe'],
    [3, 2, 'node.exe'],
  ])
  assert.equal(await findBrowserProcess(3, table), null)
})

test('a recycled pid that closes a loop terminates the walk', async () => {
  const table = winTable([
    [5, 6, 'node.exe'],
    [6, 5, 'cmd.exe'],
  ])
  assert.equal(await findBrowserProcess(5, table), null)
})

test('an unknown pid, a missing table and a bad pid all answer null', async () => {
  assert.equal(await findBrowserProcess(999, new Map()), null)
  assert.equal(await findBrowserProcess(1, null), null)
  assert.equal(await findBrowserProcess(0, new Map()), null)
  assert.equal(await findBrowserProcess('7', new Map()), null)
})
