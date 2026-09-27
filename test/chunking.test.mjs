/**
 * Chunking tests.
 *
 * Chunking exists because Chromium's two native-messaging limits are
 * asymmetric: 64 MiB browser -> host, but only 1 MiB host -> browser. Anything
 * the broker sends INTO a browser that is bigger than that is refused, so large
 * command bodies are cut into parts and rejoined on the other side.
 *
 * The first build had the host and the extension each define their own chunk
 * envelope, with three different field names between them, and the two sides
 * also disagreed about whether a part was a UTF-8 substring or a byte slice.
 * The result was not an error: chunked messages were simply dropped, silently,
 * and only the large ones, which is the hardest possible failure to notice.
 *
 * So the properties worth locking down are the boring structural ones - the
 * seq numbers are contiguous, the total agrees, every part fits under the cap -
 * plus the one that actually bit: a multi-byte character sitting exactly on a
 * slice boundary must survive.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MSG,
  PROTOCOL_VERSION,
  CHUNK_SLICE_BYTES,
  chunk,
  splitIntoChunks,
  joinChunks,
} from '../shared/protocol.mjs'
import { encodeFrame, MAX_TO_BROWSER_BYTES } from '../shared/framing.mjs'

/** Serialize a message the way the sender does, then split it. */
function split(msg, id = 'req-1') {
  return splitIntoChunks(id, Buffer.from(JSON.stringify(msg), 'utf8'))
}

/**
 * The extension rejoins parts in a service worker, where `Buffer` does not
 * exist. This is that path, written out so the test proves the two
 * implementations agree rather than assuming it. If this ever diverges from
 * joinChunks, chunked messages break in the browser and only in the browser.
 */
function joinAsServiceWorker(parts) {
  const decoded = parts.map((b64) => {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  })
  const all = new Uint8Array(decoded.reduce((n, b) => n + b.length, 0))
  let offset = 0
  for (const bytes of decoded) {
    all.set(bytes, offset)
    offset += bytes.length
  }
  return JSON.parse(new TextDecoder().decode(all))
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                                */
/* -------------------------------------------------------------------------- */

test('chunk() produces the one envelope both sides read', () => {
  // Field names pinned as a literal key list, because this is precisely where
  // the two implementations drifted: one side wrote `i`/`n`/`payload`, the
  // other read `seq`/`total`/`data`, and neither ever threw.
  const part = chunk({ id: 'req-7', seq: 2, total: 5, data: 'ZGF0YQ==' })
  assert.deepEqual(part, {
    v: PROTOCOL_VERSION,
    type: MSG.CHUNK,
    id: 'req-7',
    seq: 2,
    total: 5,
    data: 'ZGF0YQ==',
  })
  assert.equal(MSG.CHUNK, 'chunk')
})

test('every emitted part carries the correlation id, and seq is contiguous from zero', () => {
  // The receiver buffers by id and orders by seq. A gap means it waits forever
  // for a part that is not coming; a duplicate seq means one slice silently
  // overwrites another and the join produces valid-looking garbage.
  const parts = split({ op: 'fill', value: 'x'.repeat(CHUNK_SLICE_BYTES * 2) }, 'req-abc')

  assert.ok(parts.length >= 3, `expected a multi-part split, got ${parts.length}`)
  parts.forEach((p, i) => {
    assert.equal(p.id, 'req-abc', `part ${i} carries the wrong correlation id`)
    assert.equal(p.seq, i, `part ${i} has seq ${p.seq}`)
    assert.equal(p.total, parts.length, `part ${i} disagrees about the total`)
    assert.equal(p.type, MSG.CHUNK)
    assert.equal(p.v, PROTOCOL_VERSION)
  })

  assert.equal(new Set(parts.map((p) => p.seq)).size, parts.length, 'duplicate seq')
})

test('a body that fits in one slice is still emitted as one whole part', () => {
  // The single-part case has to go through the same envelope, or the receiver
  // needs a second code path for small messages and the two paths drift.
  const msg = { op: 'click', args: { ref: 'e7' } }
  const parts = split(msg)

  assert.equal(parts.length, 1)
  assert.equal(parts[0].seq, 0)
  assert.equal(parts[0].total, 1)
  assert.deepEqual(joinChunks(parts.map((p) => p.data)), msg)
})

/* -------------------------------------------------------------------------- */
/* Size: every part has to fit through the 1 MiB door                          */
/* -------------------------------------------------------------------------- */

test('every emitted part fits under the 1 MiB inbound cap, framed', () => {
  // The cap is enforced on the FRAME, not on the slice, so the base64 inflation
  // and the JSON envelope both count. Chromium does not report this failure to
  // the sender in any useful way: the message is simply never delivered.
  const parts = split({ op: 'evalJs', code: 'y'.repeat(CHUNK_SLICE_BYTES * 3) })
  assert.ok(parts.length >= 4)

  for (const part of parts) {
    const framed = encodeFrame(part).length
    assert.ok(
      framed < MAX_TO_BROWSER_BYTES,
      `a part framed to ${framed} bytes, at or over the ${MAX_TO_BROWSER_BYTES}-byte cap`
    )
  }
})

test('the slice size leaves room for base64 inflation, with margin', () => {
  // Stated as arithmetic rather than as a measurement, because this is the
  // constraint that decides the constant. base64 is 4 bytes out for every 3 in,
  // so a slice can be at most three quarters of the cap before the envelope is
  // even counted. 384 KiB against a 1 MiB cap inflates to 512 KiB, which leaves
  // half the budget spare - deliberate, so a future envelope field cannot
  // quietly push a part over the line.
  const inflated = Math.ceil(CHUNK_SLICE_BYTES / 3) * 4
  assert.ok(inflated < MAX_TO_BROWSER_BYTES, 'a full slice does not fit once base64-encoded')
  assert.ok(
    inflated <= MAX_TO_BROWSER_BYTES / 2,
    `a full slice inflates to ${inflated} bytes, leaving no margin under ${MAX_TO_BROWSER_BYTES}`
  )
  assert.equal(CHUNK_SLICE_BYTES, 384 * 1024)
})

/* -------------------------------------------------------------------------- */
/* The bug that mattered: a character sitting on the boundary                  */
/* -------------------------------------------------------------------------- */

test('a multi-byte character straddling a slice boundary survives the round-trip', () => {
  // Built deliberately rather than hoped for. The JSON prefix `{"s":"` is six
  // bytes, so filling with CHUNK_SLICE_BYTES - 8 ASCII characters puts the
  // four-byte rocket at body offset CHUNK_SLICE_BYTES - 2: two of its bytes
  // land at the end of slice 0 and two at the start of slice 1.
  const emoji = '\u{1F680}'
  const before = 'a'.repeat(CHUNK_SLICE_BYTES - 8)
  const after = `tail-${'b'.repeat(CHUNK_SLICE_BYTES)}`
  const msg = { s: `${before}${emoji}${after}` }

  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const emojiAt = body.indexOf(Buffer.from(emoji, 'utf8'))
  assert.equal(
    emojiAt,
    CHUNK_SLICE_BYTES - 2,
    'the fixture failed to place the character on the boundary'
  )
  assert.ok(emojiAt < CHUNK_SLICE_BYTES, 'the character must START in the first slice')
  assert.ok(emojiAt + 4 > CHUNK_SLICE_BYTES, 'and must END in the second')

  const parts = splitIntoChunks('req-straddle', body)
  assert.equal(parts.length, 3)

  // The proof that this is a real hazard: slice 0 on its own is NOT valid
  // UTF-8 at the tail. Anything that decodes a part before concatenating -
  // which is what a naive string-based implementation does - corrupts the
  // character here and cannot get it back.
  const firstSliceAlone = Buffer.from(parts[0].data, 'base64').toString('utf8')
  assert.ok(
    firstSliceAlone.endsWith('�'),
    'the fixture no longer splits a character, so it is not testing anything'
  )

  // Joined as bytes, it is exact.
  assert.deepEqual(joinChunks(parts.map((p) => p.data)), msg)
})

test('the service worker join agrees with the Node join, byte for byte', () => {
  // Buffer does not exist in an MV3 service worker, so the extension rebuilds
  // this with atob and TextDecoder. Two implementations of one algorithm is
  // exactly the shape the original bug had, so they are checked against each
  // other rather than each against its own expectation.
  const msg = {
    s: `${'a'.repeat(CHUNK_SLICE_BYTES - 8)}\u{1F680}${'b'.repeat(CHUNK_SLICE_BYTES)}`,
    cjk: '中文測試',
    accented: 'naïve café',
  }
  const parts = split(msg).map((p) => p.data)

  assert.deepEqual(joinAsServiceWorker(parts), msg)
  assert.deepEqual(joinAsServiceWorker(parts), joinChunks(parts))
})

test('multibyte content anywhere in the payload survives, not only on a boundary', () => {
  const msg = {
    emoji: 'ship it \u{1F680} - \u{1F469}‍\u{1F4BB}',
    cjk: '中文測試 - 日本語',
    filler: 'é'.repeat(CHUNK_SLICE_BYTES), // two bytes each, so this is 768 KiB
  }
  const parts = split(msg)
  assert.ok(parts.length >= 2)
  assert.deepEqual(joinChunks(parts.map((p) => p.data)), msg)
})

/* -------------------------------------------------------------------------- */
/* joinChunks contract                                                         */
/* -------------------------------------------------------------------------- */

test('joinChunks takes the base64 DATA strings, not the chunk objects', () => {
  // Pinned because it is the obvious integration mistake: the receiver holds an
  // array of parts and hands the whole array over. It throws rather than
  // producing nonsense, which is the behavior worth keeping.
  const parts = split({ op: 'listTabs' })
  assert.doesNotThrow(() => joinChunks(parts.map((p) => p.data)))
  assert.throws(() => joinChunks(parts), TypeError)
})

test('parts joined out of order do not silently produce a plausible message', () => {
  // The receiver is responsible for ordering by seq. If it does not, the join
  // must fail loudly - a reordered body is not valid JSON - rather than
  // returning something the model would act on.
  const parts = split({ op: 'fill', value: 'z'.repeat(CHUNK_SLICE_BYTES + 10) })
  assert.equal(parts.length, 2)

  const reversed = [parts[1].data, parts[0].data]
  assert.throws(() => joinChunks(reversed), SyntaxError)
})
