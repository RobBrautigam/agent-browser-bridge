/**
 * Iconography.
 *
 * Every glyph is inline SVG geometry drawn here by hand. Nothing is fetched:
 * MV3's content security policy forbids remote script, and a CDN stylesheet or
 * sprite sheet would be a silent runtime dependency on a machine that is
 * sometimes offline. Geometry follows Lucide's conventions (24-unit grid,
 * 2-unit stroke, round caps and joins) so the set reads as one family.
 *
 * Icons are DATA, not markup strings: they are materialized with
 * createElementNS rather than innerHTML, so nothing here can ever become an
 * HTML injection path if a label or profile name is one day drawn as an icon
 * title.
 *
 * The `jack` glyph is the product mark: a faceplate, a lit port, and a patch
 * cord running to the corner. scripts/gen-icons.mjs redraws the same
 * composition procedurally for the raster app icons, so the two stay in sync
 * by construction of shape rather than by a shared file.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Each icon is a list of [tagName, attributes] pairs applied verbatim.
 * Attributes not given inherit the stroke defaults set on the <svg> root.
 */
export const ICONS = Object.freeze({
  /* The mark. Faceplate, port ring, live center, patch cord to the corner. */
  jack: [
    ['rect', { x: 2.5, y: 2.5, width: 19, height: 19, rx: 5.5 }],
    ['circle', { cx: 10, cy: 10, r: 3.6 }],
    ['circle', { cx: 10, cy: 10, r: 1.3, fill: 'currentColor', stroke: 'none' }],
    ['path', { d: 'M13.15 13.15 17.9 17.9' }],
  ],

  /* A patch cord on its own, for decorative rules and empty states. */
  cord: [
    ['circle', { cx: 5, cy: 6, r: 2.5 }],
    ['circle', { cx: 19, cy: 18, r: 2.5 }],
    ['path', { d: 'M7.2 7.3c4.3 1 6.4 3.4 9.6 8.9' }],
  ],

  /* Vendor marks. Simplified to read at 14px, not to be brand-accurate art. */
  chrome: [
    ['circle', { cx: 12, cy: 12, r: 9.5 }],
    ['circle', { cx: 12, cy: 12, r: 3.6 }],
    ['path', { d: 'M20.9 8H12' }],
    ['path', { d: 'M3.9 6.3 8.4 14' }],
    ['path', { d: 'M10.8 21.7 15.4 14' }],
  ],
  brave: [
    ['path', { d: 'M12 2.6 5.2 5.4v6.1c0 4.4 2.9 7.4 6.8 8.9 3.9-1.5 6.8-4.5 6.8-8.9V5.4z' }],
    ['path', { d: 'M9.2 9.1 12 12.4l2.8-3.3' }],
    ['path', { d: 'M12 12.4v3.4' }],
  ],
  edge: [
    ['circle', { cx: 12, cy: 12, r: 9.5 }],
    ['path', { d: 'M3.6 14.6c4.4 2.4 10.1 1.6 13.4-2' }],
    ['path', { d: 'M21 10.4C19.3 6 15 3.4 10.6 4.4' }],
  ],
  browser: [
    ['rect', { x: 2.5, y: 4, width: 19, height: 16, rx: 3 }],
    ['path', { d: 'M2.5 9h19' }],
    ['path', { d: 'M6 6.5h.01M9 6.5h.01' }],
  ],

  /* State and action. */
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'M6 6l12 12' }]],
  alert: [
    ['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  info: [
    ['circle', { cx: 12, cy: 12, r: 9.5 }],
    ['path', { d: 'M12 16.5v-5' }],
    ['path', { d: 'M12 7.8h.01' }],
  ],
  shield: [
    ['path', { d: 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z' }],
  ],
  zap: [
    ['path', { d: 'M13.4 2.5 4.6 13.1a.6.6 0 0 0 .5 1h5.3l-.8 7.4 8.8-10.6a.6.6 0 0 0-.5-1h-5.3z' }],
  ],
  power: [
    ['path', { d: 'M12 2.8v9.4' }],
    ['path', { d: 'M18.4 6.6a9 9 0 1 1-12.8 0' }],
  ],
  pencil: [
    ['path', { d: 'M17.3 3.3a2.4 2.4 0 0 1 3.4 3.4L8.4 19H5v-3.4z' }],
    ['path', { d: 'M15.4 5.2 18.8 8.6' }],
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 9.5 }],
    ['path', { d: 'M12 6.6V12l3.6 2.1' }],
  ],
  layers: [
    ['path', { d: 'M12 2.6 2.6 7.3 12 12l9.4-4.7z' }],
    ['path', { d: 'M2.6 16.7 12 21.4l9.4-4.7' }],
    ['path', { d: 'M2.6 12 12 16.7 21.4 12' }],
  ],
  gauge: [
    ['path', { d: 'm12 13.8 3.6-3.6' }],
    ['path', { d: 'M3.3 18.6a10 10 0 1 1 17.4 0' }],
  ],
  refresh: [
    ['path', { d: 'M20.6 11.4a8.6 8.6 0 1 1-2.5-6' }],
    ['path', { d: 'M20.9 3.4v5h-5' }],
  ],
  externalLink: [
    ['path', { d: 'M14.5 3.4h6.1v6.1' }],
    ['path', { d: 'M10.4 13.6 20.6 3.4' }],
    ['path', { d: 'M18.4 13.6v5.1a2 2 0 0 1-2 2H5.3a2 2 0 0 1-2-2V7.6a2 2 0 0 1 2-2h5.1' }],
  ],
  copy: [
    ['rect', { x: 9, y: 9, width: 12.4, height: 12.4, rx: 2.4 }],
    ['path', { d: 'M5.4 15H4.6a2 2 0 0 1-2-2V4.6a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2v.8' }],
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2.4v2M12 19.6v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.4 12h2M19.6 12h2M4.6 19.4 6 18M18 6l1.4-1.4' }],
  ],
  moon: [['path', { d: 'M20.8 14.2A8.6 8.6 0 0 1 9.8 3.2a8.6 8.6 0 1 0 11 11Z' }]],
  monitor: [
    ['rect', { x: 2.6, y: 3.6, width: 18.8, height: 13.4, rx: 2.4 }],
    ['path', { d: 'M8.4 21h7.2' }],
    ['path', { d: 'M12 17v4' }],
  ],
  chevronRight: [['path', { d: 'm9.5 18 6-6-6-6' }]],
  chevronDown: [['path', { d: 'm6 9.5 6 6 6-6' }]],
  slash: [['path', { d: 'M18.4 5.6 5.6 18.4' }], ['circle', { cx: 12, cy: 12, r: 9.5 }]],
  eyeOff: [
    ['path', { d: 'M10.7 5.2A9.6 9.6 0 0 1 12 5.1c5.5 0 9.3 5.1 9.3 6.9 0 .8-.8 2.3-2.2 3.7' }],
    ['path', { d: 'M6.3 7.4C3.9 9 2.7 11.1 2.7 12c0 1.8 3.8 6.9 9.3 6.9 1.6 0 3-.4 4.2-1' }],
    ['path', { d: 'M3.4 3.4 20.6 20.6' }],
  ],
})

/**
 * Build one icon element.
 *
 * @param {keyof ICONS} name
 * @param {{size?:number, title?:string|null, className?:string, strokeWidth?:number}} [opts]
 * @returns {SVGSVGElement}
 */
export function icon(name, opts = {}) {
  const { size = 16, title = null, className = '', strokeWidth = 2 } = opts
  const shapes = ICONS[name]

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(strokeWidth))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  if (className) svg.setAttribute('class', className)

  // An icon that carries meaning gets a title and a role; a decorative one is
  // hidden outright, so a screen reader never announces "image" for a bullet.
  if (title) {
    svg.setAttribute('role', 'img')
    const t = document.createElementNS(SVG_NS, 'title')
    t.textContent = title
    svg.appendChild(t)
  } else {
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
  }

  if (!shapes) {
    // An unknown name must not silently render nothing: a hollow box is an
    // obvious visual defect during development and harmless in production.
    const r = document.createElementNS(SVG_NS, 'rect')
    r.setAttribute('x', '4')
    r.setAttribute('y', '4')
    r.setAttribute('width', '16')
    r.setAttribute('height', '16')
    r.setAttribute('rx', '3')
    svg.appendChild(r)
    return svg
  }

  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
    svg.appendChild(el)
  }
  return svg
}

/** Vendor string from the board to the glyph that represents it. */
export function vendorIconName(vendor) {
  if (vendor === 'chrome' || vendor === 'brave' || vendor === 'edge') return vendor
  return 'browser'
}

/**
 * Replace an element's contents with an icon.
 * Used by hydrateIcons and by any render path that swaps a glyph in place.
 */
export function setIcon(el, name, opts = {}) {
  if (!el) return null
  el.replaceChildren(icon(name, opts))
  return el
}

/**
 * Fill every [data-icon] placeholder under `root`.
 *
 * Lets the static HTML stay declarative without inline SVG blobs cluttering
 * the markup, and without any inline script, which MV3 forbids.
 *
 *   <span data-icon="zap" data-icon-size="14"></span>
 */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.getAttribute('data-icon')
    const size = Number(el.getAttribute('data-icon-size') || 16)
    const stroke = Number(el.getAttribute('data-icon-stroke') || 2)
    const title = el.getAttribute('data-icon-title')
    setIcon(el, name, { size, strokeWidth: stroke, title: title || null })
  }
}
