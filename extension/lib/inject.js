/**
 * Functions injected into pages by chrome.scripting.executeScript.
 *
 * HARD CONSTRAINT: every function in this file is serialized with
 * Function.prototype.toString and recompiled inside the target page. It
 * captures NOTHING from this module - no imports, no shared helpers, no closure
 * variables, no constants. That is why the same small helpers are repeated
 * inside each function instead of being hoisted. Resist tidying that up:
 * hoisting a helper produces a ReferenceError in the page at runtime, not a
 * build error here.
 *
 * Each function takes exactly one plain object (passed as `args: [payload]`)
 * and returns a JSON-serializable value. Expected failures return a typed
 * `{ ok: false, reason }` so the caller can map them onto a protocol error
 * code; only genuinely unexpected conditions throw.
 *
 * `behavior: 'instant'` is passed to every scroll on purpose. A page with
 * `scroll-behavior: smooth` in CSS otherwise animates the scroll, and the
 * geometry read immediately afterwards is the geometry from before the scroll -
 * which makes a click land on whatever used to be at those coordinates.
 *
 * This module touches no chrome.* API, which is also what lets it be imported
 * by a plain Node script for the shape check in tmp/.
 */

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Cheap page facts. Used on its own and as the tail of several other ops. */
export function pageInfo() {
  const se = document.scrollingElement || document.documentElement
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    scrollHeight: se ? se.scrollHeight : 0,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
  }
}

/**
 * Rendered text, whitespace-normalized, sliced by a character cursor.
 * innerText (not textContent) so the result reflects what a human sees:
 * it honors display:none and inserts line breaks at block boundaries.
 */
export function pageReadText(payload) {
  const { maxChars = 0, cursor = 0 } = payload || {}
  const body = document.body
  const raw = body ? body.innerText || '' : ''
  const text = raw
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const total = text.length
  const start = Math.max(0, Math.min(Number(cursor) || 0, total))
  const content = maxChars > 0 ? text.slice(start, start + maxChars) : text.slice(start)
  const end = start + content.length
  return {
    ok: true,
    format: 'text',
    total,
    start,
    content,
    next: end < total ? end : null,
    url: location.href,
    title: document.title,
  }
}

/** Serialized DOM, sliced by the same character cursor as pageReadText. */
export function pageReadHtml(payload) {
  const { maxChars = 0, cursor = 0 } = payload || {}
  const html = document.documentElement ? document.documentElement.outerHTML || '' : ''
  const total = html.length
  const start = Math.max(0, Math.min(Number(cursor) || 0, total))
  const content = maxChars > 0 ? html.slice(start, start + maxChars) : html.slice(start)
  const end = start + content.length
  return {
    ok: true,
    format: 'html',
    total,
    start,
    content,
    next: end < total ? end : null,
    url: location.href,
    title: document.title,
  }
}

/**
 * The interactable-element snapshot.
 *
 * Returns elements in document order with a role, an accessible name and a
 * selector. Refs (`e1`, `e2`, ...) are minted by the service worker, not here,
 * because the ref registry has to outlive this injection - see lib/snapshot.js.
 *
 * Main frame only in v1. Cross-frame refs need a frameId in the handle and
 * nothing in the v1 tool surface asks for one.
 */
export function pageSnapshot(payload) {
  const { limit = 300 } = payload || {}

  const SEL = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[onclick]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[tabindex]',
  ].join(',')

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 140)

  const esc = (s) =>
    window.CSS && typeof CSS.escape === 'function'
      ? CSS.escape(String(s))
      : String(s).replace(/[^\w-]/g, (c) => '\\' + c)

  const countOf = (sel) => {
    try {
      return document.querySelectorAll(sel).length
    } catch (_e) {
      return 0
    }
  }

  const visible = (el) => {
    // checkVisibility lands the content-visibility and opacity cases that a
    // hand-rolled check misses. Chrome 105+, and the manifest floor is 116.
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    }
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const cs = window.getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false
    if (cs.display === 'none') return false
    if (parseFloat(cs.opacity || '1') < 0.05) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    if (el.closest('[inert]')) return false
    return true
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit && explicit.trim()) return explicit.trim().split(/\s+/)[0]
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
      if (t === 'range') return 'slider'
      if (t === 'search') return 'searchbox'
      if (t === 'file') return 'fileinput'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return 'generic'
  }

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return clean(aria)

    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const joined = by
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id)
          return n ? n.innerText || n.textContent || '' : ''
        })
        .join(' ')
      if (clean(joined)) return clean(joined)
    }

    if (el.labels && el.labels.length) {
      const t = Array.prototype.map.call(el.labels, (l) => l.innerText || l.textContent || '').join(' ')
      if (clean(t)) return clean(t)
    }

    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase()
      if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) return clean(el.value)
    }

    const inner = clean(el.innerText || el.textContent || '')
    if (inner) return inner

    for (const attr of ['placeholder', 'title', 'alt', 'name', 'value']) {
      const v = el.getAttribute(attr)
      if (v && v.trim()) return clean(v)
    }
    return ''
  }

  const selectorFor = (el) => {
    if (el.id) {
      const s = '#' + esc(el.id)
      if (countOf(s) === 1) return { selector: s, unique: true }
    }
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(attr)
      if (v && v.length < 120) {
        const s = el.tagName.toLowerCase() + '[' + attr + '="' + v.replace(/["\\]/g, '\\$&') + '"]'
        if (countOf(s) === 1) return { selector: s, unique: true }
      }
    }
    // Structural fallback, bounded in depth so a deep SPA tree does not produce
    // a 40-segment selector that is slower to match than it is to read.
    const parts = []
    let node = el
    let depth = 0
    while (node && node.nodeType === 1 && depth < 6) {
      if (node.id) {
        const anchored = '#' + esc(node.id)
        if (countOf(anchored) === 1) {
          parts.unshift(anchored)
          break
        }
      }
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName)
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
      depth += 1
    }
    const selector = parts.join(' > ')
    return { selector, unique: countOf(selector) === 1 }
  }

  let all
  try {
    all = Array.prototype.slice.call(document.querySelectorAll(SEL))
  } catch (_e) {
    all = []
  }

  const elements = []
  let skipped = 0
  for (const el of all) {
    if (elements.length >= limit) {
      skipped += 1
      continue
    }
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'input' && type === 'hidden') continue
    // tabindex="-1" alone means "focusable by script", not "interactive".
    if (el.getAttribute('tabindex') === '-1' && !el.matches('a[href],button,input,select,textarea,summary,[role],[onclick]')) {
      continue
    }
    if (!visible(el)) continue

    const sel = selectorFor(el)
    const rect = el.getBoundingClientRect()
    const masked = tag === 'input' && type === 'password'

    const item = {
      tag,
      role: roleOf(el),
      name: nameOf(el),
      selector: sel.selector,
      unique: sel.unique,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    }
    if (type) item.type = type
    // A password field's contents are never returned. The value of knowing them
    // is zero and the cost of putting them on a wire is not.
    if (masked) item.masked = true
    else if (typeof el.value === 'string' && el.value) item.value = clean(el.value)
    if (el.disabled === true) item.disabled = true
    if (typeof el.checked === 'boolean' && (type === 'checkbox' || type === 'radio')) item.checked = el.checked
    const expanded = el.getAttribute('aria-expanded')
    if (expanded) item.expanded = expanded === 'true'
    if (tag === 'a' && el.getAttribute('href')) item.href = String(el.href).slice(0, 200)
    if (el.isContentEditable) item.editable = true

    elements.push(item)
  }

  return {
    ok: true,
    format: 'snapshot',
    url: location.href,
    title: document.title,
    elements,
    skipped,
    truncated: skipped > 0,
    scrollY: Math.round(window.scrollY),
    scrollHeight: (document.scrollingElement || document.documentElement).scrollHeight,
  }
}

/* -------------------------------------------------------------------------- */
/* Interaction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Tier 1 click: a full synthetic pointer and mouse sequence.
 *
 * Dispatching the whole sequence (not just `click`) is what makes this work on
 * component libraries that open menus on pointerdown and commit on mouseup.
 * `composed: true` lets the events cross shadow-DOM boundaries, which is how a
 * click on a custom element reaches the listener bound on its host.
 *
 * These are untrusted events, so `isTrusted` is false and a page that checks it
 * will refuse. That is what `trusted: true` and the CDP path exist for.
 */
export function pageClick(payload) {
  const { selector, scrollIntoView = true } = payload || {}
  let el = null
  try {
    el = document.querySelector(selector)
  } catch (_e) {
    return { ok: false, reason: 'bad_selector', selector }
  }
  if (!el) return { ok: false, reason: 'not_found', selector }

  if (scrollIntoView) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch (_e) {
      /* older engines reject the options object; the click still works */
    }
  }

  const r = el.getBoundingClientRect()
  if (r.width <= 0 && r.height <= 0) return { ok: false, reason: 'not_visible', selector }

  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const mouse = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    detail: 1,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
  }
  const pointer = Object.assign({}, mouse, {
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5,
  })

  try {
    el.focus({ preventScroll: true })
  } catch (_e) {
    /* not focusable; the click sequence still applies */
  }

  const fired = []
  const send = (Ctor, name, init) => {
    try {
      el.dispatchEvent(new Ctor(name, init))
      fired.push(name)
    } catch (_e) {
      /* one refused event must not abort the sequence */
    }
  }

  send(PointerEvent, 'pointerover', pointer)
  send(MouseEvent, 'mouseover', mouse)
  send(PointerEvent, 'pointermove', Object.assign({}, pointer, { buttons: 0, pressure: 0 }))
  send(MouseEvent, 'mousemove', Object.assign({}, mouse, { buttons: 0 }))
  send(PointerEvent, 'pointerdown', pointer)
  send(MouseEvent, 'mousedown', mouse)
  send(PointerEvent, 'pointerup', Object.assign({}, pointer, { buttons: 0, pressure: 0 }))
  send(MouseEvent, 'mouseup', Object.assign({}, mouse, { buttons: 0 }))
  send(MouseEvent, 'click', Object.assign({}, mouse, { buttons: 0 }))

  return {
    ok: true,
    selector,
    fired,
    tag: el.tagName.toLowerCase(),
    text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    href: el.tagName.toLowerCase() === 'a' ? String(el.href || '').slice(0, 200) : undefined,
  }
}

/**
 * Tier 1 fill.
 *
 * THE WHOLE POINT of this function is the native value setter. React installs
 * its own `value` setter on the element instance and caches the last value in
 * `_valueTracker`. A plain `el.value = v` goes through that instance setter,
 * updates the cache, and React then compares old to new, sees no change, and
 * ignores the event - which is the documented failure where the console updates
 * visually but Save stays disabled. Calling the setter off the PROTOTYPE writes
 * the DOM value without touching the tracker, so the bubbling `input` event
 * that follows reads as a genuine user edit.
 */
export function pageFill(payload) {
  const { selector, value, blurAfter = false } = payload || {}
  let el = null
  try {
    el = document.querySelector(selector)
  } catch (_e) {
    return { ok: false, reason: 'bad_selector', selector }
  }
  if (!el) return { ok: false, reason: 'not_found', selector }
  if (el.disabled === true) return { ok: false, reason: 'disabled', selector }
  if (el.readOnly === true) return { ok: false, reason: 'readonly', selector }

  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
  } catch (_e) {
    /* ignore */
  }
  try {
    el.focus({ preventScroll: true })
  } catch (_e) {
    /* ignore */
  }

  const setNative = (proto, prop, v) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop)
    if (d && typeof d.set === 'function') d.set.call(el, v)
    else el[prop] = v
  }

  const fire = (name) => {
    try {
      el.dispatchEvent(new Event(name, { bubbles: true, composed: true }))
    } catch (_e) {
      /* ignore */
    }
  }

  const finish = (extra) => {
    fire('input')
    fire('change')
    if (blurAfter) {
      try {
        el.blur()
      } catch (_e) {
        /* ignore */
      }
    }
    return Object.assign({ ok: true, selector, tag: el.tagName.toLowerCase() }, extra)
  }

  const tag = el.tagName.toLowerCase()
  const type = (el.getAttribute('type') || '').toLowerCase()

  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    const want = value === true || value === 1 || value === 'true' || value === 'on' || value === '1'
    setNative(HTMLInputElement.prototype, 'checked', want)
    return finish({ checked: el.checked, type })
  }

  if (tag === 'select') {
    const wanted = String(value)
    setNative(HTMLSelectElement.prototype, 'value', wanted)
    if (el.value !== wanted) {
      // Fall back to matching the visible option label, which is what a human
      // reads and therefore what the model most often passes.
      const opts = Array.prototype.slice.call(el.options || [])
      const hit = opts.find((o) => String(o.text || '').trim() === wanted.trim())
      if (hit) el.selectedIndex = hit.index
    }
    const selected = el.options && el.options[el.selectedIndex]
    return finish({ value: el.value, selectedText: selected ? String(selected.text).trim() : null })
  }

  if (tag === 'textarea') {
    setNative(HTMLTextAreaElement.prototype, 'value', String(value))
    return finish({ value: el.value.slice(0, 200) })
  }

  if (tag === 'input') {
    if (type === 'file') return { ok: false, reason: 'file_input_unsupported', selector }
    setNative(HTMLInputElement.prototype, 'value', String(value))
    return finish({ value: type === 'password' ? null : el.value.slice(0, 200), masked: type === 'password', type })
  }

  if (el.isContentEditable) {
    el.textContent = String(value)
    return finish({ value: String(el.textContent).slice(0, 200), editable: true })
  }

  return { ok: false, reason: 'not_fillable', selector, tag }
}

/**
 * Tier 1 key events.
 *
 * HONEST LIMITATION, and the reason mode 'type' exists: these are untrusted
 * events, so they run listeners but perform no default action. An SPA keyboard
 * shortcut fires; a character does not appear in an input, and Enter does not
 * submit a form. For real typing use fill with mode 'type', which goes through
 * CDP.
 */
export function pagePressKeys(payload) {
  const { selector = null, keys = [] } = payload || {}

  const NAMED = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  }

  let target = null
  try {
    target = selector ? document.querySelector(selector) : document.activeElement || document.body
  } catch (_e) {
    return { ok: false, reason: 'bad_selector', selector }
  }
  if (!target) return { ok: false, reason: 'not_found', selector }
  if (selector) {
    try {
      target.focus({ preventScroll: true })
    } catch (_e) {
      /* ignore */
    }
  }

  const parse = (spec) => {
    const parts = String(spec)
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean)
    const mods = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
    let base = ''
    for (const p of parts) {
      const l = p.toLowerCase()
      if (l === 'ctrl' || l === 'control') mods.ctrlKey = true
      else if (l === 'shift') mods.shiftKey = true
      else if (l === 'alt' || l === 'option') mods.altKey = true
      else if (l === 'meta' || l === 'cmd' || l === 'command' || l === 'win') mods.metaKey = true
      else base = p
    }
    const named = NAMED[base.toLowerCase()]
    if (named) return Object.assign({}, named, mods, { printable: named.key.length === 1 })
    const ch = base
    const code =
      ch.length === 1 && /[a-z]/i.test(ch)
        ? 'Key' + ch.toUpperCase()
        : ch.length === 1 && /[0-9]/.test(ch)
          ? 'Digit' + ch
          : ch
    return Object.assign(
      { key: ch, code, keyCode: ch.length === 1 ? ch.toUpperCase().charCodeAt(0) : 0 },
      mods,
      { printable: ch.length === 1 }
    )
  }

  const list = Array.isArray(keys) ? keys : String(keys).trim().split(/\s+/).filter(Boolean)
  const dispatched = []

  for (const spec of list) {
    const k = parse(spec)
    const init = {
      key: k.key,
      code: k.code,
      keyCode: k.keyCode,
      which: k.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: k.ctrlKey,
      shiftKey: k.shiftKey,
      altKey: k.altKey,
      metaKey: k.metaKey,
    }
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', init))
      if (k.printable && !k.ctrlKey && !k.metaKey) {
        target.dispatchEvent(new KeyboardEvent('keypress', init))
      }
      target.dispatchEvent(new KeyboardEvent('keyup', init))
      dispatched.push(spec)
    } catch (_e) {
      /* keep going; a refused key must not abort the sequence */
    }
  }

  return {
    ok: true,
    dispatched,
    target: target.tagName ? target.tagName.toLowerCase() : 'document',
    note: 'Tier 1 key events run listeners but perform no default action. Use fill mode "type" to insert characters.',
  }
}

/**
 * Scroll, then settle, then report whether the document grew.
 *
 * The height comparison is the whole value here: on an infinite-scroll surface
 * it is the difference between "there is more" and "you have reached the end",
 * and without it every such page has to be driven through arbitrary JS.
 */
export async function pageScroll(payload) {
  const { selector = null, direction = 'down', amount = null, settleMs = 350 } = payload || {}
  const se = document.scrollingElement || document.documentElement
  const before = { x: window.scrollX, y: window.scrollY, h: se ? se.scrollHeight : 0 }

  if (selector) {
    let el = null
    try {
      el = document.querySelector(selector)
    } catch (_e) {
      return { ok: false, reason: 'bad_selector', selector }
    }
    if (!el) return { ok: false, reason: 'not_found', selector }
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch (_e) {
      el.scrollIntoView()
    }
  } else {
    const step = typeof amount === 'number' && amount > 0 ? amount : Math.round(window.innerHeight * 0.9)
    const d = String(direction).toLowerCase()
    if (d === 'up') window.scrollBy({ top: -step, behavior: 'instant' })
    else if (d === 'left') window.scrollBy({ left: -step, behavior: 'instant' })
    else if (d === 'right') window.scrollBy({ left: step, behavior: 'instant' })
    else if (d === 'top') window.scrollTo({ top: 0, behavior: 'instant' })
    else if (d === 'bottom') window.scrollTo({ top: se ? se.scrollHeight : 0, behavior: 'instant' })
    else window.scrollBy({ top: step, behavior: 'instant' })
  }

  const wait = Math.max(0, Math.min(2000, Number(settleMs) || 0))
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))

  const after = { x: window.scrollX, y: window.scrollY, h: se ? se.scrollHeight : 0 }
  return {
    ok: true,
    x: Math.round(after.x),
    y: Math.round(after.y),
    scrollHeight: after.h,
    heightBefore: before.h,
    innerHeight: window.innerHeight,
    moved: Math.round(after.y) !== Math.round(before.y) || Math.round(after.x) !== Math.round(before.x),
    loadedMore: after.h > before.h,
    atBottom: Math.ceil(after.y + window.innerHeight) >= after.h - 2,
    atTop: Math.round(after.y) <= 0,
  }
}

/**
 * One cheap poll for waitFor.
 *
 * The polling loop lives in the service worker rather than in an injected
 * promise on purpose: a long-lived injected promise is destroyed by a
 * navigation, which is exactly the event most waits are waiting for. Re-running
 * this tiny check every few hundred milliseconds survives that.
 */
export function pageWaitCheck(payload) {
  const { selector = null, text = null, visible = true } = payload || {}

  const isVisible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const cs = window.getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') >= 0.05
  }

  if (selector) {
    let nodes = []
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(selector))
    } catch (_e) {
      return { found: false, reason: 'bad_selector' }
    }
    for (const el of nodes) {
      if (!visible || isVisible(el)) {
        return {
          found: true,
          matches: nodes.length,
          tag: el.tagName.toLowerCase(),
          text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          readyState: document.readyState,
        }
      }
    }
    return { found: false, matches: nodes.length, readyState: document.readyState }
  }

  if (text) {
    const hay = document.body ? document.body.innerText || '' : ''
    const needle = String(text)
    const i = hay.toLowerCase().indexOf(needle.toLowerCase())
    if (i >= 0) {
      return {
        found: true,
        index: i,
        excerpt: hay.slice(Math.max(0, i - 60), i + needle.length + 60).replace(/\s+/g, ' ').trim(),
        readyState: document.readyState,
      }
    }
    return { found: false, readyState: document.readyState }
  }

  return { found: false, reason: 'no_matcher' }
}

/* -------------------------------------------------------------------------- */
/* Support for the CDP (tier 2) paths                                          */
/* -------------------------------------------------------------------------- */

/**
 * Viewport geometry for an element, in CSS pixels.
 * CDP Input.dispatchMouseEvent takes CSS pixels relative to the viewport, which
 * is exactly what getBoundingClientRect returns, so no scaling is needed.
 */
export function pageRect(payload) {
  const { selector, scrollIntoView = true } = payload || {}
  let el = null
  try {
    el = document.querySelector(selector)
  } catch (_e) {
    return { ok: false, reason: 'bad_selector', selector }
  }
  if (!el) return { ok: false, reason: 'not_found', selector }
  if (scrollIntoView) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch (_e) {
      el.scrollIntoView()
    }
  }
  const r = el.getBoundingClientRect()
  if (r.width <= 0 && r.height <= 0) return { ok: false, reason: 'not_visible', selector }
  return {
    ok: true,
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height,
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
    tag: el.tagName.toLowerCase(),
  }
}

/** Focus and select an element so a CDP keystroke sequence replaces its contents. */
export function pageFocusSelect(payload) {
  const { selector, select = true } = payload || {}
  let el = null
  try {
    el = document.querySelector(selector)
  } catch (_e) {
    return { ok: false, reason: 'bad_selector', selector }
  }
  if (!el) return { ok: false, reason: 'not_found', selector }
  try {
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
  } catch (_e) {
    /* ignore */
  }
  try {
    el.focus({ preventScroll: true })
  } catch (_e) {
    /* ignore */
  }
  if (select) {
    try {
      if (typeof el.select === 'function') el.select()
      else if (el.isContentEditable) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
      }
    } catch (_e) {
      /* selection is best effort; typing still appends */
    }
  }
  return { ok: true, focused: document.activeElement === el, tag: el.tagName.toLowerCase() }
}

/**
 * Evaluate an expression in the page and return a JSON-safe description.
 *
 * This is the MAIN-world path of evalJs. The injected function itself is
 * compiled by the extension and is not subject to the page CSP, but the string
 * it evaluates IS: `new Function(src)` runs in the page realm, so a page
 * serving `script-src` without `unsafe-eval` throws an EvalError here. That is
 * detected and reported as reason 'csp' so ops.js can fall back to CDP
 * Runtime.evaluate, which the page CSP does not govern.
 */
export async function pageEval(payload) {
  const { source } = payload || {}

  const describe = (v, depth) => {
    if (v === null || v === undefined) return null
    const t = typeof v
    if (t === 'string') return v.length > 20000 ? v.slice(0, 20000) + '...[truncated]' : v
    if (t === 'number' || t === 'boolean') return v
    if (t === 'bigint') return String(v)
    if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']'
    if (t === 'symbol') return String(v)
    if (v instanceof Error) return { __error: v.name, message: v.message }
    if (typeof Node !== 'undefined' && v instanceof Node) {
      return {
        __node: v.nodeName,
        id: v.id || null,
        className: typeof v.className === 'string' ? v.className : null,
        text: String(v.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }
    }
    if (depth >= 4) return '[depth limit]'
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => describe(x, depth + 1))
    if (typeof NodeList !== 'undefined' && v instanceof NodeList) {
      return Array.prototype.slice.call(v, 0, 200).map((x) => describe(x, depth + 1))
    }
    if (v instanceof Map) return { __map: Array.from(v.entries()).slice(0, 100).map(([k, val]) => [describe(k, depth + 1), describe(val, depth + 1)]) }
    if (v instanceof Set) return { __set: Array.from(v.values()).slice(0, 100).map((x) => describe(x, depth + 1)) }
    const out = {}
    let n = 0
    for (const k of Object.keys(v)) {
      if (n >= 100) {
        out['...'] = 'truncated'
        break
      }
      n += 1
      try {
        out[k] = describe(v[k], depth + 1)
      } catch (_e) {
        out[k] = '[unreadable]'
      }
    }
    return out
  }

  try {
    let fn
    try {
      // Expression form first, so `document.title` returns rather than being a
      // statement that evaluates to undefined.
      fn = new Function('return (' + source + ');')
    } catch (_e) {
      fn = new Function(source)
    }
    const raw = await fn()
    return { ok: true, value: describe(raw, 0), type: raw === null ? 'null' : typeof raw }
  } catch (err) {
    const message = String((err && err.message) || err)
    const csp = /unsafe-eval|content security policy|EvalError/i.test(message) || (err && err.name === 'EvalError')
    return { ok: false, reason: csp ? 'csp' : 'threw', error: message }
  }
}
