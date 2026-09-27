/**
 * Platform layout.
 *
 * The bridge was built and proven on Windows; the macOS and Linux paths follow
 * Chromium's documented locations. What these tests can pin without a Mac or a
 * Linux box in the loop is the SHAPE: the state directory honors BRIDGE_HOME
 * everywhere, the socket is never a TCP address, the host manifest is named
 * after the host id, and the restart command names the right supervisor.
 *
 * ISOLATION: paths.mjs computes BASE_DIR at import, so BRIDGE_HOME is set before
 * the dynamic import below and asserted afterwards.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-paths-'))
process.env.BRIDGE_HOME = path.join(TEMP_ROOT, 'state')

const paths = await import('../shared/paths.mjs')
const config = await import('../shared/config.mjs')

const {
  BASE_DIR,
  BROWSERS,
  HOST_MANIFEST_FILE,
  IS_WINDOWS,
  LAUNCHD_PLIST_FILE,
  PIPE_NAME,
  PLATFORM,
  POSIX_HOST_SHIM_FILE,
  RUNTIME_FILE,
  SOCKET_PATH,
  START_BROKER_COMMAND,
  SYSTEMD_UNIT_FILE,
  TASK_NAME,
  hostManifestTargets,
} = paths
const { CONFIG, LAUNCHD_LABEL, SYSTEMD_UNIT } = config

test('BRIDGE_HOME overrides the state directory on every platform', () => {
  assert.equal(BASE_DIR, path.resolve(process.env.BRIDGE_HOME))
  assert.ok(RUNTIME_FILE.startsWith(BASE_DIR))
  assert.ok(HOST_MANIFEST_FILE.startsWith(BASE_DIR))
  assert.equal(path.basename(HOST_MANIFEST_FILE), `${CONFIG.nativeHostId}.json`)
})

test('PLATFORM is one of the three the code branches on', () => {
  assert.ok(['win32', 'darwin', 'linux'].includes(PLATFORM))
  assert.equal(IS_WINDOWS, process.platform === 'win32')
})

test('the broker endpoint is a local socket, never a TCP address', () => {
  assert.equal(PIPE_NAME, SOCKET_PATH)
  if (IS_WINDOWS) {
    assert.equal(PIPE_NAME, `\\\\.\\pipe\\${CONFIG.socketName}`)
  } else {
    assert.equal(PIPE_NAME, path.join(BASE_DIR, `${CONFIG.socketName}.sock`))
    // macOS caps a Unix socket path at 104 bytes. The default location fits
    // comfortably; this guards the test's own override from being the thing
    // that breaks it.
    assert.ok(Buffer.byteLength(PIPE_NAME) < 104, `socket path too long for macOS: ${PIPE_NAME}`)
  }
  assert.ok(!/:\d{2,5}$/.test(PIPE_NAME))
  assert.ok(!/^https?:|^ws:/.test(PIPE_NAME))
})

test('the restart command names the platform supervisor and the configured service', () => {
  assert.equal(TASK_NAME, CONFIG.serviceName)
  if (PLATFORM === 'win32') {
    assert.equal(START_BROKER_COMMAND, `schtasks /Run /TN "${CONFIG.serviceName}"`)
  } else if (PLATFORM === 'darwin') {
    assert.ok(START_BROKER_COMMAND.includes('launchctl kickstart'))
    assert.ok(START_BROKER_COMMAND.endsWith(LAUNCHD_LABEL))
  } else {
    assert.equal(START_BROKER_COMMAND, `systemctl --user restart ${SYSTEMD_UNIT}`)
  }
})

test('supervisor files are named after the config and live where the OS reads them', () => {
  assert.equal(path.basename(LAUNCHD_PLIST_FILE), `${LAUNCHD_LABEL}.plist`)
  assert.ok(LAUNCHD_PLIST_FILE.includes(path.join('Library', 'LaunchAgents')))
  assert.equal(path.basename(SYSTEMD_UNIT_FILE), `${SYSTEMD_UNIT}.service`)
  assert.ok(SYSTEMD_UNIT_FILE.includes(path.join('systemd', 'user')))
  assert.equal(path.basename(POSIX_HOST_SHIM_FILE), 'host-launcher.sh')
  assert.ok(POSIX_HOST_SHIM_FILE.startsWith(BASE_DIR))
})

test('every known browser has a profile directory and, off Windows, a native messaging directory', () => {
  assert.deepEqual(
    BROWSERS.map((b) => b.vendor),
    ['chrome', 'brave', 'edge']
  )
  for (const b of BROWSERS) {
    assert.equal(typeof b.userDataDir, 'string')
    assert.ok(path.isAbsolute(b.userDataDir), b.userDataDir)
    if (IS_WINDOWS) {
      assert.equal(b.nativeMessagingDir, null)
    } else {
      assert.equal(b.nativeMessagingDir, path.join(b.userDataDir, 'NativeMessagingHosts'))
    }
  }
  const chrome = BROWSERS.find((b) => b.vendor === 'chrome')
  const brave = BROWSERS.find((b) => b.vendor === 'brave')
  assert.equal(chrome.registersHost, true)
  // Windows: Brave falls back to Chrome's registry key, so nothing is written
  // for it. Elsewhere there is no fallback, so it gets its own manifest.
  assert.equal(brave.registersHost, !IS_WINDOWS)
})

test('hostManifestTargets names one manifest file per registration, named after the host id', () => {
  const targets = hostManifestTargets({ installedOnly: false })
  assert.ok(targets.length >= 1)
  for (const t of targets) {
    assert.equal(path.basename(t.file), `${CONFIG.nativeHostId}.json`)
    assert.ok(path.isAbsolute(t.file))
  }
  if (IS_WINDOWS) {
    assert.deepEqual(targets.map((t) => t.file), [HOST_MANIFEST_FILE])
  } else {
    // Chrome and Brave both register; Edge is out of scope.
    assert.deepEqual(targets.map((t) => t.vendor).sort(), ['brave', 'chrome'])
    for (const t of targets) assert.ok(t.file.includes('NativeMessagingHosts'))
  }
})
