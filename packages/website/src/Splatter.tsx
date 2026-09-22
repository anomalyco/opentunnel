/** A seeded spray of black droplets over the masthead. Black on black is invisible, so it reads only where it
 *  knocks ink out of the wordmark. */
const SPLAT = { seed: 22, count: 98, size: 7, spread: 150, x: 0.77, y: -0.24, width: 410 }

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

const drops = (() => {
  const r = rng(SPLAT.seed)
  const out: { x: number; y: number; rx: number; ry: number; a: number }[] = []
  for (let i = 0; i < SPLAT.count; i++) {
    const t = Math.pow(r(), 1.5)
    const angle = r() * Math.PI * 2
    const dist = t * SPLAT.spread
    const size = (1 - t) * SPLAT.size + 0.8 + r() * 1.5
    out.push({ x: 180 + Math.cos(angle) * dist, y: 150 + Math.sin(angle) * dist * 0.8, rx: size, ry: size * (0.6 + r() * 0.6), a: (angle * 180) / Math.PI + r() * 40 })
  }
  for (let i = 0; i < SPLAT.count / 4; i++) out.push({ x: r() * 360, y: r() * 300, rx: 0.8 + r() * 2, ry: 0.8 + r() * 2, a: 0 })
  return out
})()

export function Splatter() {
  return <svg className="splatter" viewBox="0 0 360 300" aria-hidden="true" style={{ left: `${SPLAT.x * 100}%`, top: `${SPLAT.y * 100}%`, width: SPLAT.width }}>
    <filter id="splat-edge"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="2" /><feDisplacementMap in="SourceGraphic" scale="3" /></filter>
    <g fill="#000" filter="url(#splat-edge)">
      {drops.map((d, i) => <ellipse key={i} cx={d.x} cy={d.y} rx={d.rx} ry={d.ry} transform={`rotate(${d.a.toFixed(1)} ${d.x.toFixed(1)} ${d.y.toFixed(1)})`} />)}
    </g>
  </svg>
}
