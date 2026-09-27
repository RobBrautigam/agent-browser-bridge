/**
 * Framing codec tests.
 *
 * Framing is the one piece of code all three hops share, so a defect here is a
 * defect everywhere. The tests that earn their keep are the ones that reproduce
 * what a real socket does to a frame: cut it at an arbitrary byte, batch several
 * into one read, or hand over a length prefix that cannot be trusted.
 *
 * A framing bug does not present as an error. It presents as an unparseable
 * stream, which is why these run against raw bytes rather than through a mock.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  encodeFrame,
  FrameDecoder,
  FrameDecodeError,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  MAX_TO_BROWSER_BYTES,
  CHUNK_THRESHOLD_BYTES,
} from '../shared/framing.mjs'

/**
 * Build a frame by hand with a chosen declared length, so a corrupt or
 * dishonest prefix can be fed to the decoder. encodeFrame cannot produce one.
 */
function rawFrame(declaredLength, body) {
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(declaredLength, 0)
  return Buffer.concat([header, body])
}

test('encode then decode returns an equal message', () => {
  const msg = { v: 1, type: 'req', id: 'r-1', op: 'listTabs', args: { deep: true }, n: null }
  const [out] = new FrameDecoder().push(encodeFrame(msg))
  assert.deepEqual(out, msg)
})

test('the header is a 4-byte little-endian byte count, not a character count', () => {
  const msg = { s: 'abc' }
  const json = JSON.stringify(msg)
  const frame = encodeFrame(msg)
  assert.equal(frame.length, 4 + Buffer.byteLength(json, 'utf8'))
  assert.equal(frame.readUInt32LE(0), Buffer.byteLength(json, 'utf8'))
})

test('a frame split one byte at a time still decodes', () => {
  // This is the failure that actually happens on a live socket: the header
  // itself arrives in pieces, so a decoder that peeks at buf[0..3] before
  // checking it has 4 bytes reads garbage.
  const msg = { type: 'res', id: 'r-9', ok: true, result: { tabs: [1, 2, 3] } }
  const frame = encodeFrame(msg)
  const dec = new FrameDecoder()

  for (let i = 0; i < frame.length - 1; i++) {
    const got = dec.push(frame.subarray(i, i + 1))
    assert.deepEqual(got, [], `byte ${i} completed a frame early`)
    assert.equal(dec.pending, i + 1)
  }

  const done = dec.push(frame.subarray(frame.length - 1))
  assert.equal(done.length, 1)
  assert.deepEqual(done[0], msg)
  assert.equal(dec.pending, 0)
})

test('several frames arriving in one chunk all decode, in order', () => {
  const msgs = [
    { seq: 1, type: 'ping' },
    { seq: 2, type: 'pong', extra: 'x' },
    { seq: 3, type: 'event', name: 'route_up', payload: { label: 'chrome-acme-corp' } },
  ]
  const dec = new FrameDecoder()
  const got = dec.push(Buffer.concat(msgs.map(encodeFrame)))

  assert.equal(got.length, 3)
  assert.deepEqual(got, msgs)
  assert.equal(dec.pending, 0)
})

test('a three-frame stream decodes correctly no matter where it is cut', () => {
  // Exhaustive rather than random: every possible single cut point is checked,
  // so this can never fail intermittently on a Tuesday.
  const msgs = [{ a: 1 }, { b: 'two' }, { c: [3, 3, 3] }]
  const stream = Buffer.concat(msgs.map(encodeFrame))

  for (let cut = 0; cut <= stream.length; cut++) {
    const dec = new FrameDecoder()
    const got = [...dec.push(stream.subarray(0, cut)), ...dec.push(stream.subarray(cut))]
    assert.deepEqual(got, msgs, `cut at byte ${cut}`)
    assert.equal(dec.pending, 0, `cut at byte ${cut} left bytes buffered`)
  }
})

test('a declared length over the ceiling throws FrameTooLargeError', () => {
  const dec = new FrameDecoder({ max: 64 })
  assert.throws(
    () => dec.push(rawFrame(1_000_000, Buffer.alloc(0))),
    (err) => {
      assert.ok(err instanceof FrameTooLargeError)
      assert.equal(err.name, 'FrameTooLargeError')
      assert.equal(err.size, 1_000_000)
      assert.equal(err.max, 64)
      return true
    }
  )
})

test('an oversized frame does NOT resynchronize on the next chunk', () => {
  // Guessing where the next good frame starts is how a relay silently corrupts
  // a session. Once the prefix is untrustworthy the decoder must stay poisoned,
  // so the caller is forced to tear the connection down.
  const dec = new FrameDecoder({ max: 64 })
  assert.throws(() => dec.push(rawFrame(1_000_000, Buffer.alloc(0))), FrameTooLargeError)

  const perfectlyGoodFrame = encodeFrame({ ok: true })
  assert.throws(() => dec.push(perfectlyGoodFrame), FrameTooLargeError)
  assert.throws(() => dec.push(perfectlyGoodFrame), FrameTooLargeError)
})

test('a frame at exactly the ceiling is accepted', () => {
  const body = Buffer.from(JSON.stringify('x'.repeat(20)), 'utf8')
  const dec = new FrameDecoder({ max: body.length })
  const got = dec.push(rawFrame(body.length, body))
  assert.equal(got.length, 1)
  assert.equal(got[0], 'x'.repeat(20))
})

test('a body that is not JSON throws FrameDecodeError and keeps the cause', () => {
  const body = Buffer.from('{ this is not json', 'utf8')
  assert.throws(
    () => new FrameDecoder().push(rawFrame(body.length, body)),
    (err) => {
      assert.ok(err instanceof FrameDecodeError)
      assert.equal(err.name, 'FrameDecodeError')
      assert.match(err.message, /not valid JSON/)
      assert.ok(err.cause instanceof SyntaxError, 'the parse error must survive for diagnosis')
      return true
    }
  )
})

test('multibyte payloads survive, including a split mid-character', () => {
  // The trap: JSON.stringify().length is characters, Buffer.byteLength is bytes.
  // Writing the character count into the prefix truncates every frame carrying
  // an emoji or CJK text, which is most of what a real page returns.
  const msg = {
    emoji: 'ship it \u{1F680} - \u{1F469}\u200D\u{1F4BB}',
    cjk: '中文測試 - 日本語',
    accented: 'naïve café',
  }
  const json = JSON.stringify(msg)
  const byteLength = Buffer.byteLength(json, 'utf8')

  assert.ok(byteLength > json.length, 'fixture must actually contain multibyte characters')

  const frame = encodeFrame(msg)
  assert.equal(frame.readUInt32LE(0), byteLength)

  const [whole] = new FrameDecoder().push(frame)
  assert.deepEqual(whole, msg)

  // Now cut every multibyte sequence apart on the way in.
  const dec = new FrameDecoder()
  let out = []
  for (let i = 0; i < frame.length; i++) out = out.concat(dec.push(frame.subarray(i, i + 1)))
  assert.equal(out.length, 1)
  assert.deepEqual(out[0], msg)
})

test('pending reports the bytes buffered but not yet a whole frame', () => {
  const dec = new FrameDecoder()
  const frame = encodeFrame({ hello: 'world' })

  assert.equal(dec.pending, 0)

  assert.deepEqual(dec.push(frame.subarray(0, 2)), [])
  assert.equal(dec.pending, 2, 'a partial header counts')

  assert.deepEqual(dec.push(frame.subarray(2, frame.length - 3)), [])
  assert.equal(dec.pending, frame.length - 3, 'a partial body counts')

  assert.equal(dec.push(frame.subarray(frame.length - 3)).length, 1)
  assert.equal(dec.pending, 0, 'a completed frame is drained')
})

test('pending counts the leftovers when a chunk carries one and a half frames', () => {
  const dec = new FrameDecoder()
  const a = encodeFrame({ a: 1 })
  const b = encodeFrame({ b: 2 })
  const got = dec.push(Buffer.concat([a, b.subarray(0, 5)]))

  assert.equal(got.length, 1)
  assert.deepEqual(got[0], { a: 1 })
  assert.equal(dec.pending, 5)
})

test('the size constants match the asymmetry Chromium actually enforces', () => {
  // browser -> host is 64 MiB (kMaxMessageBytes), host -> browser is 1 MiB
  // (kMaximumNativeMessageSize). A screenshot travels the wide direction, which
  // is why the decode ceiling is the larger of the two.
  assert.equal(MAX_FRAME_BYTES, 64 * 1024 * 1024)
  assert.equal(MAX_TO_BROWSER_BYTES, 1024 * 1024)
  assert.ok(CHUNK_THRESHOLD_BYTES < MAX_TO_BROWSER_BYTES, 'chunking must trigger below the cap')
  assert.ok(MAX_TO_BROWSER_BYTES < MAX_FRAME_BYTES)
})
