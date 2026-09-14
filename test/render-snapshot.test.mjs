/**
 * renderPage in snapshot format: local truncation must offer a cursor.
 *
 * The regression this locks down: a snapshot with more elements than the
 * renderer shows per call was cut to the first 400, said "N more, not
 * listed", and then ended with "nothing remains" and no cursor, so the tail
 * was unreachable through the tool. The same failure class as the 80-tab
 * truncation that browser_list_tabs already fixed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderPage } from '../mcp-server/shape.mjs'

function snapshot(n, { start = 0, next = null } = {}) {
  return {
    format: 'snapshot',
    url: 'https://example.test/',
    title: 'Big page',
    elements: Array.from({ length: n }, (_, i) => ({ ref: `e${start + i + 1}`, role: 'link', name: `Link ${i}`, selector: `a:nth-of-type(${i})` })),
    start,
    total: start + n,
    next,
  }
}

const body = (r) => r.content[0].text
const opts = { profile: 'p', tab: 'tab_p_1_1', format: 'snapshot', maxChars: 20000 }

test('a snapshot that fits renders every element and says nothing remains', () => {
  const out = body(renderPage(snapshot(5), opts))
  assert.ok(out.includes('e5 '), out)
  assert.ok(/End of snapshot\. 5 elements shown, nothing remains/.test(out))
  assert.ok(!out.includes('MORE REMAINS'))
})

test('a snapshot cut by the renderer offers a cursor to the first unrendered element', () => {
  const out = body(renderPage(snapshot(600), opts))
  assert.ok(out.includes('e400 '), 'the 400th element is rendered')
  assert.ok(!out.includes('e401 '), 'the 401st is not')
  assert.ok(out.includes('MORE REMAINS'), out.split('\n').slice(-4).join('\n'))
  assert.ok(out.includes('cursor: "400"'), 'the cursor names the first element that was not rendered')
  assert.ok(!/nothing remains/.test(out), 'a truncated result must never claim to be complete')
})

test('the local cursor is measured from where this slice began', () => {
  const out = body(renderPage(snapshot(600, { start: 400 }), opts))
  assert.ok(out.includes('cursor: "800"'), out.split('\n').slice(-4).join('\n'))
})

test('a broker-paginated snapshot keeps the broker cursor when nothing was cut locally', () => {
  const out = body(renderPage(snapshot(50, { next: 50 }), opts))
  assert.ok(out.includes('cursor: "50"'))
})
