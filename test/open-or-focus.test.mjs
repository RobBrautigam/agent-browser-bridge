/**
 * openOrFocus: the address rules, the plan, and the handler itself.
 *
 * The handler is exercised against a FAKE chrome, not a browser. That is not a
 * compromise: the rules worth protecting here are "never close a tab the
 * operator opened", "never take the keyboard away unless asked" and "the newest
 * copy is the rightmost copy", and a rule that can only be checked by driving a
 * real browser is a rule that gets checked once and then trusted forever. The
 * fake records every call, so the assertions are about what the extension DID,
 * not about what it returned.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ERR,
  OPEN_OR_FOCUS_MATCH,
  describeOpenOrFocus,
  isLocalPageUrl,
  isOpenOrFocusUrl,
  openOrFocusMatch,
  planOpenOrFocus,
} from '../shared/protocol.mjs'
import { parseArgs, toUrl } from '../scripts/open-or-focus.mjs'

/* -------------------------------------------------------------------------- */
/* The address rule                                                            */
/* -------------------------------------------------------------------------- */

test('a local page is a file URL ending in .html or .htm, and nothing else', () => {
  assert.equal(isLocalPageUrl('file:///C:/dev/report.html'), true)
  assert.equal(isLocalPageUrl('file:///C:/dev/report.HTM'), true)
  assert.equal(isLocalPageUrl('file:///C:/dev/a%20page.html'), true, 'an encoded space is still a page')
  assert.equal(isLocalPageUrl('file:///C:/dev/report%2Ehtml'), true, 'an encoded dot is still a page')
  assert.equal(isLocalPageUrl('file:///C:/dev/report.html?v=2'), true, 'a query does not change the file')

  // The whole point of the rule: everything else keeps its refusal, so the
  // navigate-then-read primitive the file: block exists to prevent stays blocked.
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/.env'), false)
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/id_rsa'), false)
  assert.equal(isLocalPageUrl('file:///C:/dev/notes.html.txt'), false)
  assert.equal(isLocalPageUrl('file:///C:/dev/'), false)
  assert.equal(isLocalPageUrl('https://example.com/page.html'), false, 'not a local file')
  assert.equal(isLocalPageUrl(''), false)
  assert.equal(isLocalPageUrl(null), false)
})

test('the ways a string can end in .html without being a local page are all refused', () => {
  // Every case below came out of the adversarial review of this feature. Each
  // one ends in .html and names something that is not a local HTML file, which
  // is exactly the shape that would widen the only carve-out in this system.

  // A host turns a file URL into a network path: Windows opens an SMB
  // connection to the named server, which is an outbound credential-carrying
  // fetch dressed as a local page.
  assert.equal(isLocalPageUrl('file://attacker.example/share/report.html'), false, 'UNC by host')
  assert.equal(isLocalPageUrl('file:////attacker.example/share/report.html'), false, 'UNC by double slash')

  // A NUL truncates the path at the filesystem: the rule reads .html, the OS
  // opens the dotenv file.
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/.env%00.html'), false, 'NUL truncation')
  assert.equal(isLocalPageUrl('file:///C:/dev/re%0Aport.html'), false, 'a control character')

  // An NTFS alternate data stream names a different file entirely.
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/secrets.env:report.html'), false, 'alternate data stream')

  // Windows drops a trailing dot or space when it opens a path, so a name that
  // does not end in .html here must not be treated as though it does.
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/.env.html.'), false, 'trailing dot')
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/.env.html%20'), false, 'trailing space')

  // The query and the fragment are not part of the file name, in either direction.
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/.env?x=.html'), false, 'a query cannot make it a page')
  assert.equal(isLocalPageUrl('file:///C:/Users/someone/.env#.html'), false, 'a fragment cannot either')

  // The drive letter's colon is the one colon a local path may carry.
  assert.equal(isLocalPageUrl('file:///C:/dev/report.html'), true)
  assert.equal(isLocalPageUrl('file:///home/someone/report.html'), true, 'a POSIX path has no drive letter')
})

test('openOrFocus accepts web addresses and local pages, and refuses the rest', () => {
  assert.equal(isOpenOrFocusUrl('https://example.com/report'), true)
  assert.equal(isOpenOrFocusUrl('file:///C:/dev/report.html'), true)

  assert.equal(isOpenOrFocusUrl('file:///C:/Users/someone/.env'), false)
  assert.equal(isOpenOrFocusUrl('chrome://settings'), false)
  assert.equal(isOpenOrFocusUrl('brave://extensions'), false)
  assert.equal(isOpenOrFocusUrl('chrome-extension://abc/options.html'), false)
  assert.equal(isOpenOrFocusUrl('about:blank'), false)
  assert.equal(isOpenOrFocusUrl('view-source:https://example.com'), false)
  assert.equal(isOpenOrFocusUrl(''), false)
})

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

test('an address matches exactly, then ignoring the query and the fragment', () => {
  const page = 'https://example.com/a/b?x=1#top'
  assert.equal(openOrFocusMatch(page, 'https://example.com/a/b?x=1#top'), OPEN_OR_FOCUS_MATCH.EXACT)
  assert.equal(openOrFocusMatch(page, 'https://example.com/a/b?x=2#other'), OPEN_OR_FOCUS_MATCH.SAME_PAGE)
  assert.equal(openOrFocusMatch(page, 'https://example.com/a/b'), OPEN_OR_FOCUS_MATCH.SAME_PAGE)
  assert.equal(openOrFocusMatch(page, 'https://example.com/a/c'), null)
  assert.equal(openOrFocusMatch(page, 'https://other.example/a/b'), null)
  assert.equal(openOrFocusMatch(page, 'http://example.com/a/b'), null, 'a different scheme is a different page')
})

test('a Windows file path matches whatever spelling it arrives in', () => {
  const target = 'file:///C:/dev/repo/docs/report.html'
  assert.equal(openOrFocusMatch(target, 'file:///c:/dev/repo/docs/report.html'), OPEN_OR_FOCUS_MATCH.EXACT)
  assert.equal(openOrFocusMatch(target, 'file:///C:/dev/repo/docs/report.html#part-2'), OPEN_OR_FOCUS_MATCH.SAME_PAGE)
  assert.equal(openOrFocusMatch(target, 'file:///C:/dev/repo/docs/Report.html'), OPEN_OR_FOCUS_MATCH.EXACT)
})

test('the same file name in another folder matches only when the caller allows it', () => {
  const target = 'file:///C:/dev/repo/docs/report.html'
  const otherWorktree = 'file:///C:/dev/repo-feature/docs/report.html'
  assert.equal(openOrFocusMatch(target, otherWorktree), null, 'off by default: two worktrees, two versions')
  assert.equal(
    openOrFocusMatch(target, otherWorktree, { allowFileName: true }),
    OPEN_OR_FOCUS_MATCH.SAME_FILE_NAME
  )
  assert.equal(
    openOrFocusMatch(target, 'file:///C:/dev/repo-feature/docs/other.html', { allowFileName: true }),
    null
  )
  assert.equal(
    openOrFocusMatch(target, 'https://example.com/docs/report.html', { allowFileName: true }),
    null,
    'the file-name rule is for local files only'
  )
})

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

const tab = (over) => ({ tabId: 1, windowId: 1, index: 0, url: '', active: false, pinned: false, ...over })

test('no tab showing the page means open a new one, in the last focused window', () => {
  const plan = planOpenOrFocus({
    url: 'https://example.com/report',
    tabs: [tab({ tabId: 1, url: 'https://example.com/other' })],
    lastFocusedWindowId: 7,
  })
  assert.deepEqual(plan, { action: 'open', windowId: 7 })
})

test('an exact match outranks a same-page match, and only the best tier is considered', () => {
  const plan = planOpenOrFocus({
    url: 'https://example.com/r?v=2',
    tabs: [
      tab({ tabId: 1, url: 'https://example.com/r?v=1' }),
      tab({ tabId: 2, url: 'https://example.com/r?v=2' }),
    ],
    openedByUs: [1, 2],
  })
  assert.equal(plan.action, 'reuse')
  assert.equal(plan.match, OPEN_OR_FOCUS_MATCH.EXACT)
  assert.equal(plan.keeper.tabId, 2)
  assert.deepEqual(
    plan.close.map((t) => t.tabId),
    [1],
    'the weaker match is still a duplicate of the same page'
  )
})

test('the keeper is in the window the operator used last, and the tab they are looking at', () => {
  const tabs = [
    tab({ tabId: 1, windowId: 1, url: 'https://example.com/r' }),
    tab({ tabId: 2, windowId: 9, url: 'https://example.com/r' }),
    tab({ tabId: 3, windowId: 9, url: 'https://example.com/r', active: true }),
  ]
  const plan = planOpenOrFocus({ url: 'https://example.com/r', tabs, lastFocusedWindowId: 9 })
  assert.equal(plan.keeper.tabId, 3)
})

test('with nothing focused and nothing active, the lowest tab id wins so repeats converge', () => {
  const tabs = [
    tab({ tabId: 8, windowId: 1, url: 'https://example.com/r' }),
    tab({ tabId: 3, windowId: 2, url: 'https://example.com/r' }),
  ]
  const plan = planOpenOrFocus({ url: 'https://example.com/r', tabs, lastFocusedWindowId: null })
  assert.equal(plan.keeper.tabId, 3)
})

test('duplicates are closed only when this capability opened them', () => {
  const tabs = [
    tab({ tabId: 1, windowId: 1, url: 'https://example.com/r', active: true }),
    tab({ tabId: 2, windowId: 1, url: 'https://example.com/r' }),
    tab({ tabId: 3, windowId: 1, url: 'https://example.com/r' }),
  ]
  const plan = planOpenOrFocus({ url: 'https://example.com/r', tabs, lastFocusedWindowId: 1, openedByUs: [2] })
  assert.equal(plan.keeper.tabId, 1)
  assert.deepEqual(plan.close.map((t) => t.tabId), [2])
  assert.deepEqual(plan.kept.map((t) => t.tabId), [3], 'tab 3 is the operator\'s and is left alone')
})

test('a tab with an unparseable address is never a match', () => {
  const plan = planOpenOrFocus({
    url: 'https://example.com/r',
    tabs: [tab({ tabId: 1, url: '' }), tab({ tabId: 2, url: 'not a url' })],
  })
  assert.equal(plan.action, 'open')
})

/* -------------------------------------------------------------------------- */
/* The one-line answer                                                         */
/* -------------------------------------------------------------------------- */

test('the summary says what happened in one line', () => {
  assert.equal(
    describeOpenOrFocus({ action: 'opened', toIndex: 12, windowId: 3 }),
    'Opened a new tab at index 12 of window 3, the far right of that window.'
  )
  assert.equal(
    describeOpenOrFocus({
      action: 'reused',
      match: OPEN_OR_FOCUS_MATCH.EXACT,
      fromIndex: 4,
      toIndex: 11,
      windowId: 3,
      moved: true,
      reloaded: true,
      closed: 1,
      kept: 0,
    }),
    'Reused the tab already showing it, moved from index 4 to 11 of window 3, reloaded, ' +
      'closed 1 duplicate this capability had opened.'
  )
  const pinned = describeOpenOrFocus({
    action: 'reused',
    match: OPEN_OR_FOCUS_MATCH.SAME_PAGE,
    fromIndex: 2,
    toIndex: 2,
    windowId: 1,
    pinned: true,
    reloaded: true,
    closed: 0,
    kept: 2,
  })
  assert.match(pinned, /pinned/)
  assert.match(pinned, /left 2 other matching tabs alone/)
})

/* -------------------------------------------------------------------------- */
/* The handler, against a fake browser                                         */
/* -------------------------------------------------------------------------- */

/**
 * A chrome just real enough for these rules: tabs in windows with indexes that
 * actually shift when a tab is removed or moved, session storage, and a log of
 * every call so a test can assert that something did NOT happen.
 */
function fakeChrome({ tabs = [], lastFocused = { id: 1, type: 'normal' }, session = {}, beforeGet = null, reloadThrows = false } = {}) {
  const state = {
    tabs: tabs.map((t) => ({ pinned: false, active: false, ...t })),
    session: { ...session },
    calls: [],
    nextId: Math.max(0, ...tabs.map((t) => t.id || 0)) + 1,
  }
  const reindex = (windowId) => {
    state.tabs
      .filter((t) => t.windowId === windowId)
      .forEach((t, i) => {
        t.index = i
      })
  }
  const byId = (id) => state.tabs.find((t) => t.id === id)

  const chrome = {
    tabs: {
      async query() {
        state.calls.push(['query'])
        return state.tabs.map((t) => ({ ...t }))
      },
      async get(id) {
        // The hook is how a test reproduces the browser changing underneath the
        // operation: a human navigating a tab between the query and the remove.
        if (beforeGet) beforeGet(id, state)
        const t = byId(id)
        if (!t) throw new Error(`No tab with id ${id}`)
        return { ...t }
      },
      async create({ url, active = false, windowId = null }) {
        state.calls.push(['create', { url, active, windowId }])
        const win = windowId == null ? lastFocused.id : windowId
        const row = {
          id: state.nextId++,
          windowId: win,
          url,
          active,
          pinned: false,
          index: state.tabs.filter((t) => t.windowId === win).length,
        }
        state.tabs.push(row)
        reindex(win)
        return { ...row }
      },
      async remove(id) {
        const t = byId(id)
        if (!t) throw new Error(`No tab with id ${id}`)
        state.calls.push(['remove', id])
        state.tabs = state.tabs.filter((x) => x.id !== id)
        reindex(t.windowId)
      },
      async move(id, { index }) {
        const t = byId(id)
        if (!t) throw new Error(`No tab with id ${id}`)
        state.calls.push(['move', id, index])
        const siblings = state.tabs.filter((x) => x.windowId === t.windowId)
        state.tabs = state.tabs.filter((x) => x.id !== id)
        const at = index === -1 ? siblings.length - 1 : index
        const before = state.tabs.filter((x) => x.windowId === t.windowId).slice(0, at)
        const after = state.tabs.filter((x) => x.windowId === t.windowId).slice(at)
        const others = state.tabs.filter((x) => x.windowId !== t.windowId)
        state.tabs = [...others, ...before, t, ...after]
        reindex(t.windowId)
        return { ...byId(id) }
      },
      async reload(id) {
        if (!byId(id)) throw new Error(`No tab with id ${id}`)
        state.calls.push(['reload', id])
        if (reloadThrows) throw new Error('the tab refused to reload')
      },
      async update(id, props) {
        const t = byId(id)
        if (!t) throw new Error(`No tab with id ${id}`)
        state.calls.push(['update', id, props])
        Object.assign(t, props)
        return { ...t }
      },
    },
    windows: {
      async getLastFocused() {
        return { ...lastFocused }
      },
      async getAll() {
        const ids = [...new Set(state.tabs.map((t) => t.windowId))]
        return ids.map((id) => ({ id, type: 'normal', focused: id === lastFocused.id, state: 'normal' }))
      },
      async update(id, props) {
        state.calls.push(['windowUpdate', id, props])
        return { id, ...props }
      },
    },
    storage: {
      session: {
        async get(key) {
          return key in state.session ? { [key]: state.session[key] } : {}
        },
        async set(obj) {
          Object.assign(state.session, obj)
        },
        async remove(key) {
          delete state.session[key]
        },
      },
    },
    runtime: { lastError: null },
  }
  return { chrome, state }
}

/** Import ops.js against a fake chrome. Fresh module per test, so no state leaks. */
async function withFakeChrome(fixture, fn) {
  const { chrome, state } = fakeChrome(fixture)
  const previous = globalThis.chrome
  globalThis.chrome = chrome
  try {
    const ops = await import(`../extension/lib/ops.js?case=${Math.random()}`)
    return await fn(ops, state)
  } finally {
    globalThis.chrome = previous
  }
}

const LEDGER = 'openOrFocus.opened'
const PAGE = 'file:///C:/dev/repo/docs/report.html'

test('with no tab showing the page, it opens one at the far right and never focuses it', async () => {
  await withFakeChrome(
    {
      tabs: [
        { id: 1, windowId: 1, index: 0, url: 'https://example.com/a' },
        { id: 2, windowId: 1, index: 1, url: 'https://example.com/b', active: true },
      ],
    },
    async (ops, state) => {
      const result = await ops.runOp('openOrFocus', { url: PAGE })
      assert.equal(result.action, 'opened')
      assert.equal(result.toIndex, 2, 'the far right of the window')
      assert.equal(result.windowId, 1)
      assert.equal(result.activated, false)
      assert.match(result.summary, /^Opened a new tab at index 2 of window 1/)

      const created = state.calls.find((c) => c[0] === 'create')
      assert.equal(created[1].active, false, 'a new tab never steals the keyboard by default')
      assert.equal(created[1].windowId, 1, 'it lands in the window the operator used last')
      assert.equal(state.calls.some((c) => c[0] === 'windowUpdate'), false, 'no window is raised')
      assert.deepEqual(Object.keys(state.session[LEDGER]), ['3'], 'the new tab is in the ledger')
    }
  )
})

test('a second call reuses the tab, reloads it, moves it to the far right, and leaves one tab', async () => {
  await withFakeChrome(
    {
      tabs: [
        { id: 1, windowId: 1, index: 0, url: PAGE },
        { id: 2, windowId: 1, index: 1, url: 'https://example.com/b', active: true },
        { id: 3, windowId: 1, index: 2, url: 'https://example.com/c' },
      ],
    },
    async (ops, state) => {
      const result = await ops.runOp('openOrFocus', { url: PAGE })
      assert.equal(result.action, 'reused')
      assert.equal(result.match, 'exact')
      assert.equal(result.fromIndex, 0)
      assert.equal(result.toIndex, 2, 'moved to the far right')
      assert.equal(result.moved, true)
      assert.equal(result.reloaded, true)
      assert.equal(result.closed, 0)
      assert.equal(state.tabs.length, 3, 'no tab was opened and none was closed')
      assert.ok(state.calls.some((c) => c[0] === 'reload' && c[1] === 1))
      assert.ok(state.calls.some((c) => c[0] === 'move' && c[1] === 1 && c[2] === -1))
      assert.equal(state.calls.some((c) => c[0] === 'create'), false)
      assert.equal(
        state.calls.some((c) => c[0] === 'update' && c[2] && c[2].active === true),
        false,
        'the tab is not activated'
      )
    }
  )
})

test('it closes the duplicate it opened itself and leaves the operator\'s copy alone', async () => {
  await withFakeChrome(
    {
      tabs: [
        { id: 1, windowId: 1, index: 0, url: PAGE },
        { id: 2, windowId: 1, index: 1, url: PAGE },
        { id: 3, windowId: 1, index: 2, url: PAGE, active: true },
      ],
      session: { [LEDGER]: { 2: PAGE } },
    },
    async (ops, state) => {
      const result = await ops.runOp('openOrFocus', { url: PAGE })
      assert.equal(result.action, 'reused')
      assert.equal(result.closed, 1, 'only the one in the ledger')
      assert.equal(result.kept, 1, 'the other copy is the operator\'s')
      assert.deepEqual(state.tabs.map((t) => t.id).sort(), [1, 3])
      assert.ok(state.calls.some((c) => c[0] === 'remove' && c[1] === 2))
      assert.equal(state.calls.some((c) => c[0] === 'remove' && c[1] === 1), false)
      assert.deepEqual(state.session[LEDGER], {}, 'the closed tab leaves the ledger')
    }
  )
})

test('a duplicate that stopped showing the page is left alone, ledger or not', async () => {
  // The ledger proves this operation OPENED that tab. It does not prove the tab
  // still holds that page: between reading the tab list and closing the
  // duplicate, the operator can have typed a new address into it. Closing it
  // then would destroy their work under a permission granted for something else.
  await withFakeChrome(
    {
      tabs: [
        { id: 1, windowId: 1, index: 0, url: PAGE, active: true },
        { id: 2, windowId: 1, index: 1, url: PAGE },
      ],
      session: { [LEDGER]: { 2: PAGE } },
      beforeGet(id, state) {
        const t = state.tabs.find((x) => x.id === 2)
        if (t) t.url = 'https://example.com/the-operator-went-somewhere-else'
      },
    },
    async (ops, state) => {
      const result = await ops.runOp('openOrFocus', { url: PAGE })
      assert.equal(result.closed, 0, 'it no longer shows the page, so it is not a duplicate')
      assert.equal(state.calls.some((c) => c[0] === 'remove'), false)
      assert.deepEqual(state.tabs.map((t) => t.id).sort(), [1, 2])
    }
  )
})

test('a reload that fails is reported, not thrown, because the tab is already in place', async () => {
  await withFakeChrome(
    {
      tabs: [
        { id: 1, windowId: 1, index: 0, url: PAGE },
        { id: 2, windowId: 1, index: 1, url: 'https://example.com/b', active: true },
      ],
      reloadThrows: true,
    },
    async (ops) => {
      const result = await ops.runOp('openOrFocus', { url: PAGE })
      assert.equal(result.reloaded, false)
      assert.equal(result.moved, true, 'the move still happened and is still reported')
      assert.match(result.summary, /not reloaded/)
    }
  )
})

test('a pinned tab is reloaded where it is, never dragged out of the pinned strip', async () => {
  await withFakeChrome(
    {
      tabs: [
        { id: 1, windowId: 1, index: 0, url: PAGE, pinned: true },
        { id: 2, windowId: 1, index: 1, url: 'https://example.com/b', active: true },
      ],
    },
    async (ops, state) => {
      const result = await ops.runOp('openOrFocus', { url: PAGE })
      assert.equal(result.pinned, true)
      assert.equal(result.moved, false)
      assert.equal(result.fromIndex, 0)
      assert.equal(result.toIndex, 0)
      assert.equal(result.reloaded, true)
      assert.equal(state.calls.some((c) => c[0] === 'move'), false)
      assert.match(result.summary, /pinned/)
    }
  )
})

test('activate is the only thing that raises a window', async () => {
  await withFakeChrome(
    { tabs: [{ id: 1, windowId: 4, index: 0, url: PAGE }], lastFocused: { id: 4, type: 'normal' } },
    async (ops, state) => {
      const result = await ops.runOp('openOrFocus', { url: PAGE, activate: true })
      assert.equal(result.activated, true)
      assert.ok(state.calls.some((c) => c[0] === 'update' && c[2].active === true))
      assert.ok(state.calls.some((c) => c[0] === 'windowUpdate' && c[2].focused === true))
    }
  )
})

test('a local file that is not a page is refused before any tab is touched', async () => {
  await withFakeChrome({ tabs: [{ id: 1, windowId: 1, index: 0, url: 'https://example.com' }] }, async (ops, state) => {
    await assert.rejects(
      () => ops.runOp('openOrFocus', { url: 'file:///C:/Users/someone/.env' }),
      (err) => err.code === ERR.RESTRICTED_URL
    )
    assert.equal(state.calls.length, 0, 'nothing was queried, created or moved')
  })
})

test('the ledger forgets tab ids that no longer exist', async () => {
  await withFakeChrome(
    {
      tabs: [{ id: 1, windowId: 1, index: 0, url: 'https://example.com/a' }],
      session: { [LEDGER]: { 99: PAGE } },
    },
    async (ops, state) => {
      await ops.runOp('openOrFocus', { url: PAGE })
      assert.equal(state.session[LEDGER]['99'], undefined, 'a dead id can never authorize a close')
    }
  )
})

test('a same-name file in another folder is only reused when the flag says so', async () => {
  const other = 'file:///C:/dev/repo-feature/docs/report.html'
  await withFakeChrome({ tabs: [{ id: 1, windowId: 1, index: 0, url: other }] }, async (ops) => {
    const opened = await ops.runOp('openOrFocus', { url: PAGE })
    assert.equal(opened.action, 'opened', 'two worktrees are two different pages by default')
  })
  await withFakeChrome({ tabs: [{ id: 1, windowId: 1, index: 0, url: other }] }, async (ops) => {
    const reused = await ops.runOp('openOrFocus', { url: PAGE, matchFileName: true })
    assert.equal(reused.action, 'reused')
    assert.equal(reused.match, 'same-file-name')
  })
})

/* -------------------------------------------------------------------------- */
/* The command line                                                            */
/* -------------------------------------------------------------------------- */

test('the command turns whatever it is handed into an address', () => {
  assert.deepEqual(toUrl('https://example.com/a'), { ok: true, url: 'https://example.com/a' })
  assert.equal(toUrl('  ').ok, false)
  // A Windows path is a path, not a URL with scheme "c", and a file that is not
  // there is named in the failure rather than sent as a broken address.
  const missing = toUrl('C:/definitely/not/here/report.html')
  assert.equal(missing.ok, false)
  assert.match(missing.message, /No file at/)
})

test('the command line parses its flags and refuses anything else', () => {
  assert.deepEqual(parseArgs(['brave-x', 'https://example.com']), {
    mode: 'open',
    profile: 'brave-x',
    target: 'https://example.com',
    matchFileName: false,
    activate: false,
    socket: undefined,
  })
  const full = parseArgs(['--activate', 'brave-x', 'https://example.com', '--match-file-name', '--socket', '\\\\.\\pipe\\nope'])
  assert.equal(full.mode, 'open')
  assert.equal(full.activate, true)
  assert.equal(full.matchFileName, true)
  assert.equal(full.socket, '\\\\.\\pipe\\nope')
  assert.equal(parseArgs(['brave-x']).mode, 'usage')
  assert.equal(parseArgs(['brave-x', 'https://example.com', '--nope']).mode, 'usage')
  assert.equal(parseArgs(['brave-x', 'https://example.com', '--socket']).mode, 'usage')
})
