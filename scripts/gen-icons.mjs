/**
 * Generate the app icons.
 *
 * Zero dependencies, by design and by repo rule. Node ships zlib, which is the
 * only hard part of a PNG, so everything else here is arithmetic:
 *
 *   1. Rasterize the mark into a supersampled RGBA buffer (no canvas exists in
 *      Node, so shapes are signed-distance tests evaluated per sample).
 *   2. Box-downsample to the target size. That is where the antialiasing comes
 *      from: SS x SS binary samples average into one smooth edge pixel.
 *   3. Encode: PNG signature, IHDR, IDAT (zlib-deflated scanlines each prefixed
 *      with a filter byte), IEND, with a CRC32 over every chunk.
 *
 * The mark is the same composition as the `jack` glyph in extension/ui/icons.js,
 * translated from line art to a solid: a brass faceplate, a dark port punched
 * through it so the brass showing inside the ring reads as the lit lamp, and a
 * patch cord running to the corner. Solid rather than stroked because a 16px
 * outline icon disappears against a browser toolbar.
 *
 * Run:  node scripts/gen-icons.mjs        (writes and then verifies)
 *       node scripts/gen-icons.mjs --check (verify only, no writes)
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(HERE, '..', 'extension', 'icons')

/** The sizes Chromium asks for in an MV3 manifest. */
const SIZES = [16, 32, 48, 128]

/* Palette. Deliberately the dark-theme accent from ui/tokens.css, because the
   icon has to sit on a toolbar we do not control and brass reads on both. */
const BRASS = [224, 168, 60]
const INK = [14, 16, 20]

/* -------------------------------------------------------------------------- */
/* CRC32                                                                       */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/* -------------------------------------------------------------------------- */
/* PNG encoding                                                                */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const out = Buffer.allocUnsafe(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length)
  return out
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba width*height*4, straight (non-premultiplied) alpha
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(6, 9) // color type 6 = truecolor with alpha
  ihdr.writeUInt8(0, 10) // compression: deflate
  ihdr.writeUInt8(0, 11) // filter method 0
  ihdr.writeUInt8(0, 12) // no interlace

  // Filter type 0 (None) on every scanline. The mark is tiny and mostly flat,
  // so a smarter filter would save bytes measured in hundreds. Not worth the
  // extra code in a file that has to stay obviously correct.
  const stride = width * 4
  const raw = Buffer.allocUnsafe(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Read a PNG back far enough to prove it is one: signature, every chunk CRC,
 * and the IHDR fields. This is the verification step, not a decoder.
 */
function inspectPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('missing PNG signature')
  }
  let offset = 8
  let ihdr = null
  const types = []

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) throw new Error(`chunk ${type} runs past end of file`)

    const expected = buf.readUInt32BE(dataEnd)
    const actual = crc32(buf.subarray(offset + 4, dataEnd))
    if (expected !== actual) throw new Error(`chunk ${type} CRC mismatch`)

    types.push(type)
    if (type === 'IHDR') {
      ihdr = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
      }
    }
    offset = dataEnd + 4
    if (type === 'IEND') break
  }

  if (!ihdr) throw new Error('no IHDR chunk')
  if (!types.includes('IDAT')) throw new Error('no IDAT chunk')
  if (types[types.length - 1] !== 'IEND') throw new Error('file does not end with IEND')
  return ihdr
}

/* -------------------------------------------------------------------------- */
/* Geometry, in a 24-unit design space to match ui/icons.js                     */
/* -------------------------------------------------------------------------- */

const DESIGN = 24

const PANEL = { x: 1.5, y: 1.5, w: 21, h: 21, r: 5.6 }
const PORT = { cx: 9.8, cy: 9.8, outer: 4.7, inner: 2.85 }
/** Sampled control points of the patch cord, and its stroke half-width. */
const CORD = {
  from: [12.85, 12.85],
  control: [16.2, 14.1],
  to: [18.6, 17.9],
  halfWidth: 1.35,
}

function insideRoundRect(x, y, rect) {
  const { x: rx, y: ry, w, h, r } = rect
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false
  // Only the four corner squares need the radial test.
  const cx = Math.min(Math.max(x, rx + r), rx + w - r)
  const cy = Math.min(Math.max(y, ry + r), ry + h - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function insideAnnulus(x, y, port) {
  const dx = x - port.cx
  const dy = y - port.cy
  const d2 = dx * dx + dy * dy
  return d2 <= port.outer * port.outer && d2 >= port.inner * port.inner
}

/** Flatten the quadratic cord once, so the per-sample test is segment distance. */
const CORD_SEGMENTS = (() => {
  const steps = 24
  const pts = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const mt = 1 - t
    pts.push([
      mt * mt * CORD.from[0] + 2 * mt * t * CORD.control[0] + t * t * CORD.to[0],
      mt * mt * CORD.from[1] + 2 * mt * t * CORD.control[1] + t * t * CORD.to[1],
    ])
  }
  const segs = []
  for (let i = 0; i < pts.length - 1; i += 1) segs.push([pts[i], pts[i + 1]])
  return segs
})()

const CORD_BOUNDS = (() => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [a, b] of CORD_SEGMENTS) {
    for (const p of [a, b]) {
      minX = Math.min(minX, p[0])
      minY = Math.min(minY, p[1])
      maxX = Math.max(maxX, p[0])
      maxY = Math.max(maxY, p[1])
    }
  }
  const pad = CORD.halfWidth + 0.1
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
})()

function insideCord(x, y) {
  if (x < CORD_BOUNDS.minX || x > CORD_BOUNDS.maxX) return false
  if (y < CORD_BOUNDS.minY || y > CORD_BOUNDS.maxY) return false
  const limit = CORD.halfWidth * CORD.halfWidth
  for (const [[ax, ay], [bx, by]] of CORD_SEGMENTS) {
    const vx = bx - ax
    const vy = by - ay
    const wx = x - ax
    const wy = y - ay
    const len2 = vx * vx + vy * vy
    let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const dx = wx - t * vx
    const dy = wy - t * vy
    if (dx * dx + dy * dy <= limit) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Rasterizer                                                                  */
/* -------------------------------------------------------------------------- */

/** Supersampling factor. Small icons need the most; 128 already looks clean. */
function supersampleFor(size) {
  return size <= 48 ? 8 : 4
}

/**
 * Draw the mark at `size` and return straight-alpha RGBA bytes.
 *
 * Composition is painter's order with binary per-sample coverage, accumulated
 * as premultiplied color so the box downsample is a plain average. Dark shapes
 * are clipped to the faceplate so a cord that grazes the rounded corner can
 * never paint outside the icon.
 */
function renderMark(size) {
  const ss = supersampleFor(size)
  const big = size * ss
  const unit = big / DESIGN

  const accR = new Float64Array(size * size)
  const accG = new Float64Array(size * size)
  const accB = new Float64Array(size * size)
  const accA = new Float64Array(size * size)

  for (let sy = 0; sy < big; sy += 1) {
    const dy = (sy + 0.5) / unit
    const outY = (sy / ss) | 0
    for (let sx = 0; sx < big; sx += 1) {
      const dx = (sx + 0.5) / unit

      if (!insideRoundRect(dx, dy, PANEL)) continue

      const dark = insideAnnulus(dx, dy, PORT) || insideCord(dx, dy)
      const color = dark ? INK : BRASS

      const i = outY * size + ((sx / ss) | 0)
      accR[i] += color[0]
      accG[i] += color[1]
      accB[i] += color[2]
      accA[i] += 1
    }
  }

  const samples = ss * ss
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    const cover = accA[i]
    const o = i * 4
    if (cover === 0) continue
    // accR holds sum(color) over COVERED samples only, so dividing by the
    // covered count un-premultiplies; alpha is coverage over all samples.
    rgba[o] = Math.round(accR[i] / cover)
    rgba[o + 1] = Math.round(accG[i] / cover)
    rgba[o + 2] = Math.round(accB[i] / cover)
    rgba[o + 3] = Math.round((cover / samples) * 255)
  }
  return rgba
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

function iconPath(size) {
  return path.join(OUT_DIR, `icon${size}.png`)
}

function main() {
  const checkOnly = process.argv.includes('--check')

  if (!checkOnly) fs.mkdirSync(OUT_DIR, { recursive: true })

  const report = []
  for (const size of SIZES) {
    const file = iconPath(size)

    if (!checkOnly) {
      const png = encodePng(size, size, renderMark(size))
      fs.writeFileSync(file, png)
    }

    if (!fs.existsSync(file)) {
      console.error(`MISSING  ${path.relative(process.cwd(), file)}`)
      process.exitCode = 1
      continue
    }

    const bytes = fs.readFileSync(file)
    let ihdr
    try {
      ihdr = inspectPng(bytes)
    } catch (err) {
      console.error(`INVALID  ${path.relative(process.cwd(), file)}: ${err.message}`)
      process.exitCode = 1
      continue
    }

    if (ihdr.width !== size || ihdr.height !== size) {
      console.error(`WRONG SIZE ${file}: IHDR says ${ihdr.width}x${ihdr.height}, expected ${size}`)
      process.exitCode = 1
      continue
    }

    report.push({
      file: path.relative(path.join(HERE, '..'), file).replace(/\\/g, '/'),
      bytes: bytes.length,
      ihdr: `${ihdr.width}x${ihdr.height}`,
      bitDepth: ihdr.bitDepth,
      colorType: ihdr.colorType,
    })
  }

  const verb = checkOnly ? 'Verified' : 'Wrote and verified'
  console.log(`${verb} ${report.length} icon${report.length === 1 ? '' : 's'}:`)
  for (const r of report) {
    console.log(
      `  ${r.file.padEnd(30)} ${String(r.bytes).padStart(6)} bytes   IHDR ${r.ihdr.padEnd(9)} depth ${r.bitDepth} colorType ${r.colorType} (RGBA)`
    )
  }
}

main()
