/**
 * Print marks for the poster footer: one-ink line drawings and halftone fills.
 * Every mark is inline SVG in `currentColor`; `var(--paper)` cuts windows out of solid ink.
 */

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1, vectorEffect: "non-scaling-stroke" } as const
const paper = { fill: "var(--paper)" } as const

/** Sky halftone: dot rows stacked coarse to fine, over a skyline of racks with a ringed sun. */
export function HalftoneSkyline() {
  // Nine dot rows from y=3 to 60, shrinking from a near-solid top to a fine mist at the horizon.
  const bands = Array.from({ length: 9 }, (_, i) => {
    const top = 3 + i * 6.333
    return [top, top + 6.333, 1.15 - i * .11] as const
  })
  return <svg className="mark-frame" viewBox="0 0 150 84" aria-hidden="true">
    <defs>
      {bands.map(([, , r], i) => <pattern key={i} id={`ht${i}`} width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <circle cx="1.5" cy="1.5" r={r} fill="currentColor" />
      </pattern>)}
      <clipPath id="frameClip"><rect x="3" y="3" width="144" height="78" rx="4" /></clipPath>
    </defs>
    <rect x=".5" y=".5" width="149" height="83" rx="6" {...stroke} />
    <g clipPath="url(#frameClip)">
      {bands.map(([top, bottom], i) => <rect key={i} x="3" y={top} width="144" height={bottom - top} fill={`url(#ht${i})`} />)}
      {/* ringed sun: the tunnel, seen from the street */}
      <circle cx="117" cy="26" r="13" {...paper} />
      <circle cx="117" cy="26" r="11" {...stroke} />
      <circle cx="117" cy="26" r="7.5" {...stroke} />
      <circle cx="117" cy="26" r="4" fill="currentColor" />
      {/* skyline */}
      <g fill="currentColor">
        <rect x="6" y="40" width="11" height="32" />
        <rect x="11" y="27" width="1" height="13" />
        <circle cx="11.5" cy="26" r="1.2" />
        <rect x="19" y="48" width="14" height="24" />
        <rect x="35" y="30" width="8" height="42" />
        <rect x="45" y="52" width="19" height="20" />
        <rect x="66" y="22" width="12" height="50" />
        <rect x="69" y="18" width="6" height="4" />
        <rect x="80" y="44" width="16" height="28" />
        <rect x="98" y="56" width="10" height="16" />
        <rect x="110" y="48" width="14" height="24" />
        <rect x="126" y="38" width="9" height="34" />
        <rect x="137" y="52" width="12" height="20" />
        <rect x="3" y="72" width="144" height="9" />
      </g>
      {/* windows and rack lights, cut from the ink */}
      <g {...paper}>
        {[43, 47, 51, 55, 59, 63].map(y => <rect key={y} x="8" y={y} width="1.5" height="1.5" />)}
        {[43, 47, 51, 55, 59, 63].map(y => <rect key={y} x="13" y={y} width="1.5" height="1.5" />)}
        {[55, 58, 61, 64, 67].map(y => <rect key={y} x="47" y={y} width="15" height="1" />)}
        {[26, 32, 38, 44, 50, 56, 62].map(y => <rect key={y} x="68.5" y={y} width="1.5" height="1.5" />)}
        {[26, 32, 38, 44, 50, 56, 62].map(y => <rect key={y} x="72" y={y} width="1.5" height="1.5" />)}
        {[26, 32, 38, 44, 50, 56, 62].map(y => <rect key={y} x="75.5" y={y} width="1.5" height="1.5" />)}
        {[48, 52, 56, 60, 64].map(y => <rect key={y} x="83" y={y} width="1.5" height="1.5" />)}
        {[48, 52, 56, 60, 64].map(y => <rect key={y} x="90" y={y} width="1.5" height="1.5" />)}
        {[52, 56, 60, 64].map(y => <rect key={y} x="113" y={y} width="8" height="1" />)}
        {[42, 46, 50, 54, 58, 62].map(y => <rect key={y} x="129.5" y={y} width="1.5" height="1.5" />)}
        <rect x="3" y="75.5" width="144" height="1" />
      </g>
    </g>
  </svg>
}

/** The public internet: a globe with meridians and parallels. */
export function Globe() {
  return <svg className="mark-icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="10.5" {...stroke} />
    <ellipse cx="12" cy="12" rx="4.5" ry="10.5" {...stroke} />
    <path d="M1.5 12h21M3.2 7.5h17.6M3.2 16.5h17.6" {...stroke} />
  </svg>
}

/** Your laptop, where TLS terminates: a closed padlock on the screen. */
export function LaptopLock() {
  return <svg className="mark-icon" viewBox="0 0 28 24" aria-hidden="true">
    <rect x="4.5" y="2.5" width="19" height="13" rx="1" {...stroke} />
    <path d="M1 20.5h26" {...stroke} />
    <path d="M3 17.5h22l2 3H1z" fill="currentColor" />
    <path d="M11.5 9V7.5a2.5 2.5 0 0 1 5 0V9" {...stroke} />
    <rect x="10" y="9" width="8" height="5.5" rx=".5" fill="currentColor" />
    <circle cx="14" cy="11.5" r=".9" {...paper} />
  </svg>
}

/** The relay: one line in, routed out by hostname, never opened. */
export function Relay() {
  return <svg className="mark-icon" viewBox="0 0 28 24" aria-hidden="true">
    <circle cx="2.5" cy="12" r="1.5" fill="currentColor" />
    <path d="M4 12h6" {...stroke} />
    <rect x="10.5" y="6.5" width="7" height="11" rx="1.5" {...stroke} />
    <path d="M14 9.5l2.2 2.5-2.2 2.5-2.2-2.5z" fill="currentColor" />
    <path d="M17.5 12h2.5l4.2-5M20 12l4.2 5" {...stroke} />
    <circle cx="25" cy="6" r="1.5" {...stroke} />
    <circle cx="25" cy="18" r="1.5" {...stroke} />
  </svg>
}

/** Four-point sparkle with a registration plus beside it. */
export function SparklePlus() {
  return <svg className="mark-sparkle" viewBox="0 0 18 12" aria-hidden="true">
    <path d="M6 0c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6z" fill="currentColor" />
    <path d="M15.5 1v4M13.5 3h4" {...stroke} />
  </svg>
}

/** A four-point sparkle alone. */
export function Sparkle() {
  return <svg className="mark-sparkle-solo" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 0c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6z" fill="currentColor" />
  </svg>
}

/** Registration target: a circle with a cross through it. */
export function Target() {
  return <svg className="mark-target" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r="5" {...stroke} />
    <circle cx="7" cy="7" r="1.5" fill="currentColor" />
    <path d="M7 0v14M0 7h14" {...stroke} />
  </svg>
}

/** Decorative bar strip in the manner of a print-run code. Not a real barcode. */
export function Bars() {
  const widths = [2, 1, 3, 1, 1, 2, 1, 4, 1, 2, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1]
  let x = 0
  const rects = widths.map((w, i) => {
    const r = <rect key={i} x={x} y="0" width={w} height="10" fill={i % 2 === 0 ? "currentColor" : "none"} />
    x += w
    return r
  })
  return <svg className="mark-bars" viewBox={`0 0 ${x} 10`} aria-hidden="true">{rects}</svg>
}

/** Crop mark for a footer corner; `flip` mirrors it for the right side. */
export function CropMark({ flip = false }: { flip?: boolean }) {
  return <svg className="mark-crop" viewBox="0 0 8 8" aria-hidden="true" style={flip ? { transform: "scaleX(-1)" } : undefined}>
    <path d="M.5 8V.5H8" {...stroke} />
  </svg>
}
