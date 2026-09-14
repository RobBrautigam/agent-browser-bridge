/**
 * The native-messaging link: connect, register, stay connected.
 *
 * This is the module the incumbent got wrong, in three specific ways, and every
 * design decision below is a direct answer to one of them:
 *
 *   1. Its scheduler asked "does a port object exist" instead of "is the link
 *      actually working". A half-open port therefore looked healthy forever,
 *      which is the permanent "Connected, Service Not Started" hang. Here the
 *      only thing that counts as connected is a LIVE PORT IN THIS WORKER plus a
 *      PERSISTED STATE OF READY. Either one alone means reconnect.
 *   2. It treated the Port returned by connectNative as success. It is not:
 *      connectNative returns a Port even when the host cannot be launched, and
 *      the failure arrives later through onDisconnect - or never. So we post
 *      REGISTER immediately and require REGISTER_ACK within 5 s or tear down.
 *   3. It had a cooldown after a run of failed attempts, so one transient blip
 *      left it dead for five minutes. Here: jittered exponential backoff,
 *      capped, unlimited attempts, NO cooldown, ever.
 *
 * Nothing that matters lives in a module global. The service worker can be
 * terminated between any two lines in this file, so state lives in
 * chrome.storage.session (per browser session) and identity in
 * chrome.storage.local (forever). The port and the timers are necessarily
 * worker-local, which is precisely why they never get a vote on scheduling.
 */

import {
  ERR,
  LINK,
  MSG,
  NATIVE_HOST_ID,
  OPS,
  PROTOCOL_VERSION,
  TIMING,
  backoffDelay,
  fail,
  joinChunks,
  pong,
  register,
  req,
} from './protocol.js'

/* Session-scoped keys: meaningless once the browser restarts. */
const K_STATE = 'link.state'
const K_ATTEMPT = 'link.attempt'
const K_SINCE = 'link.since'
const K_ERROR = 'link.lastError'
const K_ACK = 'link.ack'
/* Epoch ms of the last proof the BROKER is alive: a REGISTER_ACK or a PING.
 * See the staleness check in ensureConnected for why a live port is not that
 * proof and never was. */
const K_HEARTBEAT = 'link.heartbeatAt'

/* Local-scoped keys: must survive browser restart and extension reload. */
const K_INSTALL_ID = 'installId'
const K_LABEL = 'label'
/* Vendor and email are detected at REGISTER time and cached so the options page
 * and popup can identify this profile while the link is down. */
const K_VENDOR = 'vendor'
const K_EMAIL = 'email'

/** Worker-local. Never consulted on its own to decide whether to reconnect. */
let port = null
let ackTimer = null
let retryTimer = null
let connectInFlight = null

/** Set by sw.js. Receives a REQ envelope, returns a RES envelope. */
let requestHandler = null

/** Extension-originated requests awaiting a RES (options page asking the broker). */
const pending = new Map()
let requestSeq = 0

/** Partial inbound frames, keyed by chunk id. */
const chunkBuffers = new Map()

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

export function setRequestHandler(fn) {
  requestHandler = fn
}

/**
 * Idempotent. Every wake source calls this and only this: the alarm tick,
 * onStartup, onInstalled, worker cold start, and the backoff timer.
 */
export async function ensureConnected(reason = 'unknown') {
  const state = await getState()

  // The two-sided check. A port with a non-ready state is the half-open case
  // that hung the incumbent. A ready state with no port is a worker that was
  // terminated and revived - storage.session survived, the port did not.
  //
  // The third case is the one that orphaned a profile forever: the BROKER
  // restarts, the host process survives, so this worker keeps a live port and a
  // persisted READY while the new broker has never heard of it. Nothing the
  // extension owns changes, so without a clock this returns early on every
  // alarm tick and the profile never re-REGISTERs. The broker pings every live
  // route on TIMING.HEARTBEAT_INTERVAL, so silence past the same staleness
  // window the broker uses on us means the link is dead however healthy the
  // port looks.
  if (port && state === LINK.READY) {
    if (!(await heartbeatIsStale())) return state
    // Drop the port and fall through to a fresh REGISTER on this same tick.
    // Waiting out a backoff here would leave a profile the broker cannot see
    // for longer than it takes to simply reintroduce ourselves.
    await teardown('no broker heartbeat within the stale window')
  } else if (port && state === LINK.CONNECTING && ackTimer) {
    return state
  }

  if (connectInFlight) return connectInFlight
  connectInFlight = connect(reason).finally(() => {
    connectInFlight = null
  })
  return connectInFlight
}

/** Drop the link and reconnect now. The options page uses this. */
export async function forceReconnect(reason = 'manual') {
  await teardown(`forced: ${reason}`)
  await setAttempt(0)
  return ensureConnected(reason)
}

/** Everything the popup and options page need, with no broker round trip. */
export async function getLinkSnapshot() {
  const bag = await chrome.storage.session.get([K_STATE, K_ATTEMPT, K_SINCE, K_ERROR, K_ACK])
  const local = await chrome.storage.local.get([K_INSTALL_ID, K_LABEL, K_VENDOR, K_EMAIL])
  const state = bag[K_STATE] || LINK.DOWN
  return {
    linkState: port ? state : state === LINK.READY ? LINK.DOWN : state,
    hasPort: !!port,
    attempt: bag[K_ATTEMPT] || 0,
    since: bag[K_SINCE] || null,
    lastError: bag[K_ERROR] || null,
    ack: bag[K_ACK] || null,
    installId: local[K_INSTALL_ID] || null,
    label: local[K_LABEL] || null,
    vendor: local[K_VENDOR] || null,
    email: local[K_EMAIL] || null,
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    nativeHostId: NATIVE_HOST_ID,
    protocolVersion: PROTOCOL_VERSION,
  }
}

/**
 * Who this profile is, flattened for the options page and popup.
 *
 * `claimed` is deliberately NULL rather than false until the broker has
 * actually said. The popup only nags about claiming on an explicit `false`, so
 * a broker outage must not be reported as "this profile needs claiming" - that
 * would send the operator to fix a claim that is not broken.
 */
export async function getSelf() {
  const snap = await getLinkSnapshot()
  const ack = snap.ack || {}
  return {
    installId: snap.installId,
    label: ack.label || snap.label || null,
    // The broker corroborates the vendor by walking the host process's parent
    // to the browser executable, so its verdict outranks our own detection.
    vendor: ack.vendor || snap.vendor,
    email: snap.email,
    claimed: typeof ack.claimed === 'boolean' ? ack.claimed : null,
    candidates: Array.isArray(ack.candidates) ? ack.candidates : [],
    profileDir: ack.profileDir || null,
    profileName: ack.profileName || null,
    generation: ack.generation ?? null,
    warning: ack.warning || null,
    // `link` is the contract's name for this, and it is the same vocabulary a
    // board Line uses, so the UI renders one profile's state with one branch.
    link: snap.linkState,
    lastError: snap.lastError,
    attempt: snap.attempt,
    since: snap.since,
    brokerVersion: ack.brokerVersion || null,
    extensionId: snap.extensionId,
    version: snap.version,
    nativeHostId: snap.nativeHostId,
    protocolVersion: snap.protocolVersion,
  }
}

/**
 * Ask the BROKER something on behalf of the options page or the popup.
 *
 * Normal traffic runs the other way, broker to extension. This is the reverse
 * channel the UI needs for the claim flow, renaming, arming and the panic
 * switch, and the broker permits it for exactly HOST_REQ_ALLOWED_OPS.
 *
 * `profile` is an ENVELOPE field, never an argument. The first build put it in
 * args, where the broker's addressing never looks, so every profile-addressed
 * request from the UI resolved to no route at all. Ops the broker routes from
 * the CONNECTION itself (claimProfile, setLabel) pass null, which is not an
 * omission: an extension may only claim or rename ITSELF.
 */
export async function requestBroker(op, { profile = null, args = {}, timeoutMs = 10_000 } = {}) {
  if (!port) {
    const state = await getState()
    throw new Error(`${ERR.NO_BROKER}: not connected to the broker (link is ${state}).`)
  }
  requestSeq += 1
  const id = `x${Date.now().toString(36)}-${requestSeq}`
  const envelope = req({ id, op, profile, args, timeoutMs })

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      // Code-prefixed so the UI renders a typed outage rather than a bare
      // string. sw.js reads the prefix back off the message.
      reject(new Error(`${ERR.TIMEOUT}: the broker did not answer ${op} within ${timeoutMs}ms.`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      port.postMessage(envelope)
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err)
    }
  })
}

/**
 * The stable identity of this profile's extension instance.
 *
 * Minted once and never regenerated. It lives in storage.LOCAL on purpose:
 * storage.session is in-memory and would mint a phantom profile on the broker's
 * board every time the service worker restarted.
 */
export async function getInstallId() {
  const bag = await chrome.storage.local.get(K_INSTALL_ID)
  if (bag && typeof bag[K_INSTALL_ID] === 'string' && bag[K_INSTALL_ID]) return bag[K_INSTALL_ID]
  const id = crypto.randomUUID()
  await chrome.storage.local.set({ [K_INSTALL_ID]: id })
  return id
}

export async function countTabs() {
  try {
    const tabs = await chrome.tabs.query({})
    return tabs.length
  } catch (_err) {
    return 0
  }
}

/* -------------------------------------------------------------------------- */
/* Connect and register                                                        */
/* -------------------------------------------------------------------------- */

async function connect(reason) {
  await setState(LINK.CONNECTING, { reason })

  let p = null
  try {
    p = chrome.runtime.connectNative(NATIVE_HOST_ID)
  } catch (err) {
    return failConnect(`connectNative threw: ${err && err.message ? err.message : String(err)}`)
  }
  if (!p) return failConnect('connectNative returned no port.')

  port = p
  p.onMessage.addListener(handleMessage)
  p.onDisconnect.addListener(handleDisconnect)

  let identity
  try {
    identity = await collectIdentity()
  } catch (err) {
    return failConnect(`identity collection failed: ${err && err.message ? err.message : String(err)}`)
  }

  try {
    p.postMessage(identity)
  } catch (err) {
    return failConnect(`REGISTER post failed: ${err && err.message ? err.message : String(err)}`)
  }

  // A Port is not a link. Nothing is connected until the broker says so.
  clearTimeout(ackTimer)
  ackTimer = setTimeout(() => {
    ackTimer = null
    void onAckTimeout()
  }, TIMING.HELLO_ACK_TIMEOUT)

  return LINK.CONNECTING
}

async function onAckTimeout() {
  await teardown(`no REGISTER_ACK within ${TIMING.HELLO_ACK_TIMEOUT}ms`)
  await scheduleReconnect()
}

async function failConnect(message) {
  await teardown(message)
  await scheduleReconnect()
  return LINK.DOWN
}

/**
 * The REGISTER envelope: what the broker needs to join this extension instance
 * to a real profile directory.
 *
 * Built through register() from the contract, and that matters. The first build
 * hand-rolled the object with `vendor` and `extensionVersion`, while the broker
 * reads `vendorHint` and `extVersion`, so every Brave profile registered as
 * Chrome and the whole claim flow pointed at the wrong browser's profiles. The
 * builder drops anything not on the pinned field list, so evidence that used to
 * ride along (the brands array, the platform string) is logged here instead of
 * being smuggled onto the wire where nothing reads it.
 *
 * The hint is evidence, never a verdict: the broker corroborates the vendor
 * independently by walking the host process's parent to the browser executable,
 * because Brave documents navigator.brave as suppressible.
 */
async function collectIdentity() {
  const manifest = chrome.runtime.getManifest()
  const local = await chrome.storage.local.get(K_LABEL)
  const vendor = await detectVendor()
  const email = await profileEmail()

  // Cached so the options page and popup can name this profile even while the
  // link is down, which is exactly when the operator is most likely to be looking.
  try {
    await chrome.storage.local.set({ [K_VENDOR]: vendor.vendor, [K_EMAIL]: email })
  } catch (_err) {
    /* the REGISTER below still carries both */
  }

  console.info(
    `[bridge] registering as ${vendor.vendor} (${vendor.evidence.join('; ') || 'no evidence'})`,
    { brands: vendor.brands, platform: vendor.platform, protocolVersion: PROTOCOL_VERSION }
  )

  return register({
    installId: await getInstallId(),
    vendorHint: vendor.vendor,
    email,
    label: local[K_LABEL] || null,
    extVersion: manifest.version,
    tabCount: await countTabs(),
  })
}

/**
 * Brave's User-Agent STRING is byte-identical to Chrome's, so UA sniffing is
 * useless here. navigator.brave.isBrave() is the real signal (available in
 * workers since brave-core PR 17473) with userAgentData.brands as a second
 * opinion.
 */
async function detectVendor() {
  const evidence = []
  let vendor = 'chrome'

  try {
    if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
      const isBrave = await navigator.brave.isBrave()
      evidence.push(`navigator.brave.isBrave=${isBrave}`)
      if (isBrave) vendor = 'brave'
    } else {
      evidence.push('navigator.brave=absent')
    }
  } catch (err) {
    evidence.push(`navigator.brave threw: ${err && err.message ? err.message : String(err)}`)
  }

  let brands = []
  try {
    const uad = navigator.userAgentData
    if (uad && Array.isArray(uad.brands)) {
      brands = uad.brands.map((b) => `${b.brand} ${b.version}`)
      const joined = brands.join(' ').toLowerCase()
      if (joined.includes('brave')) {
        vendor = 'brave'
        evidence.push('brands mention Brave')
      } else if (joined.includes('microsoft edge')) {
        vendor = 'edge'
        evidence.push('brands mention Microsoft Edge')
      }
    }
  } catch (err) {
    evidence.push(`userAgentData threw: ${err && err.message ? err.message : String(err)}`)
  }

  let platform = null
  try {
    platform = navigator.userAgentData ? navigator.userAgentData.platform : null
  } catch (_err) {
    platform = null
  }

  return { vendor, evidence, brands, platform }
}

/**
 * The signed-in account, which is what lets the broker resolve a CHROME profile
 * directory deterministically by matching Local State's info_cache.user_name.
 *
 * On Brave this comes back empty. That is expected and is not an error: Brave's
 * info_cache carries no Google identity at all, which is exactly why Brave
 * profiles need the one-time claim click in the options page.
 */
async function profileEmail() {
  try {
    if (!chrome.identity || typeof chrome.identity.getProfileUserInfo !== 'function') return null
    const info = await new Promise((resolve) => {
      try {
        chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (result) => {
          void chrome.runtime.lastError // reading it marks the error handled
          resolve(result || null)
        })
      } catch (_err) {
        resolve(null)
      }
    })
    const email = info && typeof info.email === 'string' ? info.email.trim() : ''
    return email || null
  } catch (_err) {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Inbound                                                                     */
/* -------------------------------------------------------------------------- */

function handleMessage(raw) {
  void routeMessage(raw).catch((err) => {
    console.error('[bridge] message handling failed:', err)
  })
}

async function routeMessage(raw) {
  if (!raw || typeof raw !== 'object') return

  const msg = raw.type === MSG.CHUNK ? absorbChunk(raw) : raw
  if (!msg) return // a chunk that does not complete a message yet

  switch (msg.type) {
    case MSG.REGISTER_ACK:
      return onRegisterAck(msg)
    case MSG.HELLO_ACK:
      // The host speaks HELLO to the broker on its own hop, so a hello_ack that
      // reaches US is the host relaying its own refusal - which is exactly how
      // a dead broker announces itself. Treating it as a register_ack means an
      // ok:false lands on the refusal path below instead of timing out, and an
      // ok:true degrades a naming mismatch to a working link.
      return onRegisterAck(msg)
    case MSG.PING:
      return onPing(msg)
    case MSG.REQ:
      return onReq(msg)
    case MSG.RES:
      return onRes(msg)
    case MSG.EVENT:
      return onEvent(msg)
    default:
      console.warn('[bridge] ignoring unknown message type:', msg.type)
      return undefined
  }
}

/**
 * The answer to REGISTER, and the one place the extension learns who it is.
 *
 * Every field read here comes off the registerAck() field list in the contract.
 * Reading anything else gets undefined, silently, which is how profileDir,
 * profileName, vendor and warning went missing from the options page in the
 * first build.
 */
async function onRegisterAck(msg) {
  clearTimeout(ackTimer)
  ackTimer = null

  // A typed refusal, which is what a host relays the instant it knows the
  // broker is gone (as a register_ack or a hello_ack, both ok:false). Tearing
  // down here is what makes a broker restart recoverable: the port stays alive
  // through it, so without this the persisted READY would survive and
  // ensureConnected would return early forever, leaving the profile orphaned on
  // a broker that has never heard of it.
  if (msg.ok === false) {
    const code = msg.error && msg.error.code ? msg.error.code : ERR.NO_BROKER
    const detail = msg.error ? msg.error.message || JSON.stringify(msg.error) : 'the broker refused REGISTER'
    await teardown(`${code}: ${detail}`)
    await scheduleReconnect()
    return
  }

  await setAttempt(0)
  await chrome.storage.session.set({
    [K_ACK]: {
      at: Date.now(),
      profileKey: msg.profileKey ?? null,
      label: msg.label ?? null,
      generation: msg.generation ?? null,
      claimed: msg.claimed ?? null,
      candidates: Array.isArray(msg.candidates) ? msg.candidates : [],
      profileDir: msg.profileDir ?? null,
      profileName: msg.profileName ?? null,
      vendor: msg.vendor ?? null,
      warning: msg.warning ?? null,
      brokerVersion: msg.version ?? null,
      heartbeatMs: msg.heartbeatMs ?? TIMING.HEARTBEAT_INTERVAL,
    },
  })

  // The broker arbitrates label collisions across many profiles, so its label
  // wins over whatever this instance last stored. Same for the vendor: it saw
  // the actual browser executable, we only asked navigator.
  const patch = {}
  if (typeof msg.label === 'string' && msg.label) patch[K_LABEL] = msg.label
  if (typeof msg.vendor === 'string' && msg.vendor) patch[K_VENDOR] = msg.vendor
  if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch)

  await noteHeartbeat()
  await setState(LINK.READY, { reason: 'register_ack' })
}

async function onPing(msg) {
  if (!port) return
  // A ping is the only proof this worker gets that the broker on the far side
  // of the host is the one that knows about us. ensureConnected reads it.
  await noteHeartbeat()
  try {
    port.postMessage(
      pong(msg.seq, {
        tabCount: await countTabs(),
        linkState: LINK.READY,
        installId: await getInstallId(),
        at: Date.now(),
      })
    )
  } catch (err) {
    await teardown(`pong failed: ${err && err.message ? err.message : String(err)}`)
    await scheduleReconnect()
  }
}

async function onReq(msg) {
  if (!requestHandler) {
    post(fail(msg.id, ERR.EXT_ERROR, 'The service worker has no request handler installed.'))
    return
  }
  let response
  try {
    response = await requestHandler(msg)
  } catch (err) {
    response = fail(msg.id, ERR.EXT_ERROR, err && err.message ? err.message : String(err))
  }
  if (response) post(response)
}

function onRes(msg) {
  const waiter = pending.get(msg.id)
  if (!waiter) return // a response to a request this worker no longer remembers
  pending.delete(msg.id)
  clearTimeout(waiter.timer)
  if (msg.ok) waiter.resolve(msg.result)
  else waiter.reject(new Error(msg.error ? `${msg.error.code}: ${msg.error.message}` : 'broker error'))
}

async function onEvent(msg) {
  if (msg.name === OPS.PANIC) {
    await chrome.storage.session.set({ [K_ERROR]: 'broker panic' })
  }
}

/**
 * Reassemble a chunked inbound frame.
 *
 * Only the host-to-browser direction needs this: Chromium caps that direction
 * at 1 MiB while browser-to-host allows 64 MiB, so a large command body arrives
 * split and a screenshot goes back whole.
 *
 * The envelope is the contract's chunk(): { type, id, seq, total, data }, with
 * data as a base64 slice cut on a BYTE boundary. The first build invented three
 * different field names for it on each side of the wire, so every chunked
 * message was dropped with "ignoring unknown message type" and the operation
 * that produced it simply hung until something timed out.
 */
function absorbChunk(frame) {
  const id = frame.id
  const seq = Number(frame.seq)
  const total = Number(frame.total)
  const data = typeof frame.data === 'string' ? frame.data : ''

  if (!id || !Number.isInteger(seq) || !Number.isInteger(total) || total < 1) {
    console.warn('[bridge] discarding a malformed chunk')
    return null
  }

  let entry = chunkBuffers.get(id)
  if (!entry) {
    entry = { parts: new Map(), total }
    chunkBuffers.set(id, entry)
  }
  entry.total = total
  entry.parts.set(seq, data)

  if (entry.parts.size < entry.total) return null

  chunkBuffers.delete(id)
  const ordered = Array.from(entry.parts.keys())
    .sort((a, b) => a - b)
    .map((k) => entry.parts.get(k))

  try {
    // joinChunks decodes the base64 to bytes, concatenates, then decodes UTF-8
    // once. Decoding each part to text first would corrupt any character that
    // straddles a slice boundary.
    return joinChunks(ordered)
  } catch (err) {
    console.error('[bridge] reassembled chunk is not valid JSON:', err)
    return null
  }
}

function post(msg) {
  if (!port) return false
  try {
    port.postMessage(msg)
    return true
  } catch (err) {
    console.error('[bridge] post failed:', err)
    void teardown(`post failed: ${err && err.message ? err.message : String(err)}`).then(scheduleReconnect)
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Disconnect and retry                                                        */
/* -------------------------------------------------------------------------- */

function handleDisconnect() {
  const err = chrome.runtime.lastError
  const message = err && err.message ? err.message : 'host disconnected'
  port = null
  clearTimeout(ackTimer)
  ackTimer = null
  rejectPending(message)
  void setState(LINK.DOWN, { error: message }).then(scheduleReconnect)
}

async function teardown(message) {
  clearTimeout(ackTimer)
  ackTimer = null
  if (port) {
    const dying = port
    port = null
    try {
      dying.disconnect()
    } catch (_err) {
      /* already gone */
    }
  }
  rejectPending(message)
  await setState(LINK.DOWN, { error: message })
}

function rejectPending(message) {
  for (const [id, waiter] of pending) {
    clearTimeout(waiter.timer)
    waiter.reject(new Error(`${ERR.NO_BROKER}: ${message}`))
    pending.delete(id)
  }
  chunkBuffers.clear()
}

/**
 * Jittered exponential backoff, capped, unlimited attempts, no cooldown.
 *
 * The setTimeout here is best-effort: a service worker with no open port has no
 * keepalive and can be evicted before it fires. That is exactly what the alarm
 * in sw.js is for - it is the wake source that survives eviction, and it calls
 * the same idempotent ensureConnected().
 */
async function scheduleReconnect() {
  if (retryTimer) return
  const attempt = await bumpAttempt()
  const delay = backoffDelay(attempt, {
    base: TIMING.EXT_RECONNECT_BASE,
    factor: TIMING.EXT_RECONNECT_FACTOR,
    cap: TIMING.EXT_RECONNECT_CAP,
  })
  retryTimer = setTimeout(() => {
    retryTimer = null
    void ensureConnected(`backoff-retry-${attempt}`)
  }, delay)
}

/* -------------------------------------------------------------------------- */
/* Persisted state                                                             */
/* -------------------------------------------------------------------------- */

async function getState() {
  try {
    const bag = await chrome.storage.session.get(K_STATE)
    return (bag && bag[K_STATE]) || LINK.DOWN
  } catch (_err) {
    return LINK.DOWN
  }
}

async function setState(state, { reason = null, error = null } = {}) {
  const patch = { [K_STATE]: state, [K_SINCE]: Date.now() }
  if (error) patch[K_ERROR] = error
  if (state === LINK.READY) patch[K_ERROR] = null
  // A heartbeat stamp from a dead link must never outlive it: the next READY
  // would inherit it and look fresh for up to the whole stale window.
  if (state === LINK.DOWN) patch[K_HEARTBEAT] = 0
  try {
    await chrome.storage.session.set(patch)
  } catch (_err) {
    /* if session storage is unavailable the alarm still drives reconnection */
  }
  if (reason) console.info(`[bridge] link -> ${state} (${reason})`)
  return state
}

/** Remember that the broker just proved it is alive and knows about us. */
async function noteHeartbeat() {
  try {
    await chrome.storage.session.set({ [K_HEARTBEAT]: Date.now() })
  } catch (_err) {
    /* the alarm still drives reconnection; a missing stamp only reads as stale */
  }
}

/**
 * Has the broker gone quiet for longer than it would ever legitimately be?
 *
 * The window is the same one the broker applies to US before it calls a route
 * stale, so neither side declares the other dead first on a healthy link. A
 * missing stamp counts as stale: it means either the broker has never acked, or
 * session storage lost it, and reintroducing ourselves is cheap and idempotent
 * while staying orphaned is neither.
 */
async function heartbeatIsStale() {
  let at = 0
  try {
    const bag = await chrome.storage.session.get(K_HEARTBEAT)
    at = (bag && bag[K_HEARTBEAT]) || 0
  } catch (_err) {
    return true
  }
  if (!at) return true
  return Date.now() - at > TIMING.HEARTBEAT_INTERVAL * TIMING.STALE_AFTER_MISSED
}

async function bumpAttempt() {
  const bag = await chrome.storage.session.get(K_ATTEMPT)
  const next = ((bag && bag[K_ATTEMPT]) || 0) + 1
  await chrome.storage.session.set({ [K_ATTEMPT]: next })
  return next
}

async function setAttempt(n) {
  try {
    await chrome.storage.session.set({ [K_ATTEMPT]: n })
  } catch (_err) {
    /* ignore */
  }
}
