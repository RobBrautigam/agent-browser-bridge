/**
 * renderTabs paging.
 *
 * The regression these lock down: a profile with more tabs than the render
 * default used to end with "... and N more, not listed" and no way to reach
 * them, so the tail of a large browser was invisible to the tool. The default
 * page size must not change (every existing caller depends on it), the tail
 * must name the next call, and the ceiling must hold.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderTabs, MAX_TABS_LISTABLE } from '../mcp-server/shape.mjs'

const DEFAULT_PAGE = 80

function tabs(n, { activeAt = -1 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    handle: `tab_p_1_${i}`,
    title: `Tab ${i}`,
    url: `https://example.test/${i}`,
    windowId: 7,
    active: i === activeAt,
  }))
}

const body = (r) => r.content[0].text

test('a short list renders every tab and says nothing about paging', () => {
  const out = body(renderTabs({ tabs: tabs(3) }, { profile: 'p' }))
  assert.match(out, /^p: 3 open tabs/)
  for (const i of [0, 1, 2]) assert.ok(out.includes(`tab_p_1_${i}`), `tab ${i} missing`)
  assert.ok(!out.includes('not listed'))
  assert.ok(!out.includes('showing'))
})

test('one tab is singular', () => {
  assert.match(body(renderTabs({ tabs: tabs(1) }, { profile: 'p' })), /^p: 1 open tab\n/)
})

test('an empty list and a bad payload keep their existing messages', () => {
  assert.equal(body(renderTabs({ tabs: [] }, { profile: 'p' })), 'p: no open tabs.')
  assert.match(body(renderTabs({ nope: 1 }, { profile: 'p' })), /unexpected listTabs payload/)
})

test('the default page size is unchanged at 80', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p' }))
  assert.ok(out.includes('tab_p_1_79'), 'tab 79 should render')
  assert.ok(!out.includes('tab_p_1_80\n'), 'tab 80 should not render by default')
  assert.ok(out.includes('... and 117 more'), 'the remainder should be counted')
})

test('the truncation notice names the exact next call', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p' }))
  assert.match(out, /offset: 80 for the next page/)
  assert.match(out, /limit: 197 to render all 197 at once/)
})

test('the full count is always reported, even when the page is short', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', limit: 5 }))
  assert.match(out, /^p: 197 open tabs, showing 1 to 5/)
})

test('limit renders every tab when it covers the whole list', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', limit: 197 }))
  assert.ok(out.includes('tab_p_1_196'), 'the last tab should render')
  assert.ok(!out.includes('not listed'), 'nothing should be withheld')
  assert.match(out, /^p: 197 open tabs\n/, 'a complete render reads as a plain count')
})

test('offset pages forward and the window is exactly limit wide', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', offset: 80, limit: DEFAULT_PAGE }))
  assert.match(out, /showing 81 to 160/)
  assert.ok(out.includes('tab_p_1_80'), 'the window should start at 80')
  assert.ok(out.includes('tab_p_1_159'), 'the window should end at 159')
  assert.ok(!out.includes('tab_p_1_79\n'), 'tabs before the offset are not rendered')
  assert.match(out, /offset: 160 for the next page/)
})

test('the last page has no trailing notice', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', offset: 160 }))
  assert.match(out, /showing 161 to 197/)
  assert.ok(!out.includes('not listed'))
})

test('limit is clamped to the ceiling rather than honored unbounded', () => {
  const n = MAX_TABS_LISTABLE + 50
  const out = body(renderTabs({ tabs: tabs(n) }, { profile: 'p', limit: n }))
  assert.match(out, new RegExp(`showing 1 to ${MAX_TABS_LISTABLE}`))
  assert.ok(out.includes('... and 50 more'))
})

test('above the ceiling the tail never advertises a limit that would be clamped', () => {
  // The regression: the tail used to say "limit: 1050 to render all 1050 at
  // once" for a 1050-tab profile, which pageSize clamps straight back to 1000.
  // A remedy the code will not honor costs a round trip to disprove.
  const n = MAX_TABS_LISTABLE + 50
  const out = body(renderTabs({ tabs: tabs(n) }, { profile: 'p', limit: n }))
  assert.ok(!out.includes(`limit: ${n}`), 'must not advertise a limit above the ceiling')
  assert.ok(!out.includes(`all ${n}`), 'must not claim all of them can render at once')
  assert.match(out, new RegExp(`offset: ${MAX_TABS_LISTABLE} for the next page`))
})

test('at exactly the ceiling, a full render is still offered', () => {
  const out = body(renderTabs({ tabs: tabs(MAX_TABS_LISTABLE) }, { profile: 'p' }))
  assert.match(out, new RegExp(`limit: ${MAX_TABS_LISTABLE} to render all ${MAX_TABS_LISTABLE} at once`))
})

test('on the last page above the ceiling there is no remedy clause at all', () => {
  const n = MAX_TABS_LISTABLE + 50
  const out = body(renderTabs({ tabs: tabs(n) }, { profile: 'p', offset: 900, limit: 100 }))
  // 900..999 rendered, 50 left, but a full render cannot reach them either.
  assert.ok(out.includes('... and 50 more'))
  assert.ok(!out.includes('to render'), 'no full-render remedy when one cannot cover the tail')
  assert.match(out, /offset: 1000 for the next page\./)
})

test('unusable limit and offset values fall back instead of throwing', () => {
  const bad = [undefined, null, NaN, Infinity, -Infinity, 'eighty', '80', ' 80 ', '0x50',
               '', '  ', true, false, [], [80], {}, -5, 0, -80.9]
  for (const v of bad) {
    const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', limit: v, offset: v }))
    assert.ok(out.includes('tab_p_1_0'), `limit/offset ${String(v)} should fall back to the start`)
    assert.ok(out.includes('... and 117 more'), `limit/offset ${String(v)} should keep the default size`)
  }
})

test('a numeric string is NOT honored, so "0x50" cannot silently mean 80', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', limit: '5' }))
  assert.ok(out.includes('... and 117 more'), 'a string limit takes the default, not 5')
})

test('a float limit or offset truncates rather than breaking the slice', () => {
  const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', limit: 80.9, offset: 80.9 }))
  assert.match(out, /showing 81 to 160/)
})

test('an enormous offset lands on the last tab, never an empty page', () => {
  for (const huge of [1e21, Number.MAX_SAFE_INTEGER]) {
    const out = body(renderTabs({ tabs: tabs(197) }, { profile: 'p', offset: huge }))
    assert.match(out, /showing 197 to 197/, `offset ${huge}`)
    assert.ok(out.includes('tab_p_1_196'))
  }
})

test('an offset past the end still renders a real page rather than nothing', () => {
  const out = body(renderTabs({ tabs: tabs(10) }, { profile: 'p', offset: 999 }))
  assert.match(out, /showing 10 to 10/)
  assert.ok(out.includes('tab_p_1_9'))
})

test('a bare array payload is accepted, as before', () => {
  assert.match(body(renderTabs(tabs(2), { profile: 'p' })), /^p: 2 open tabs/)
})

test('active and window marks survive paging', () => {
  const out = body(renderTabs({ tabs: tabs(197, { activeAt: 100 }) }, { profile: 'p', offset: 100, limit: 1 }))
  assert.match(out, /\[active, window 7\]/)
})

test('a missing options object does not throw', () => {
  assert.match(body(renderTabs({ tabs: tabs(2) })), /open tabs/)
})
