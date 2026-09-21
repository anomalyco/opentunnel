import { useRef } from "react"
import { useAnimationFrame } from "motion/react"
import { ringDefaults, type RingSettings } from "./ringSettings"

// A stack of ellipses travelling along an axis forever: rings appear at one end, run the length of the
// stack and leave at the other. Drawn as SVG strokes and posed every frame straight onto the elements.

const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }

/** Where ring `i` of `count` sits at time `t` (seconds): centre, radii and opacity, in percent of the square. */
export function ringPose(i: number, t: number, s: RingSettings) {
  const u = (((i + .5) / s.count + t * s.speed) % 1 + 1) % 1
  const scale = Math.pow(s.taper, 1 - u)
  // Spacing follows scale, so a receding pipe compresses toward its far end.
  const g = Math.abs(s.taper - 1) < 1e-3 ? u : (scale - s.taper) / (1 - s.taper)
  const bulge = 1 + s.wave * Math.sin(2 * Math.PI * (u / s.waves - t * s.waveSpeed))
  const rx = s.radius * scale * bulge
  const opacity = s.fade > 0 ? smooth(u / s.fade) * smooth((1 - u) / s.fade) : 1
  return { cx: 50 + s.lean * (1 - g), cy: 50 + (g - .5) * s.length * s.near, rx, ry: rx * s.squash, opacity, u }
}

type Props = { size: number; settings?: RingSettings; color?: string; className?: string; paused?: boolean; timeOffset?: number }

export function RingTunnel({ size, settings = ringDefaults, color = "#fff", className, paused = false, timeOffset = 0 }: Props) {
  const rings = useRef<(SVGEllipseElement | null)[]>([])
  const live = useRef(settings); live.current = settings
  const time = useRef(0), last = useRef<number | undefined>(undefined)
  const pose = (t: number) => {
    for (const [i, ring] of rings.current.entries()) {
      if (!ring) continue
      const p = ringPose(i, t + timeOffset, live.current)
      ring.setAttribute("cx", p.cx.toFixed(3)); ring.setAttribute("cy", p.cy.toFixed(3))
      ring.setAttribute("rx", Math.max(0, p.rx).toFixed(3)); ring.setAttribute("ry", Math.max(0, p.ry).toFixed(3))
      ring.setAttribute("opacity", p.opacity.toFixed(3))
    }
  }
  useAnimationFrame(now => {
    if (last.current !== undefined && !paused) time.current += Math.min(.1, (now - last.current) / 1000)
    last.current = now
    pose(time.current)
  })
  const stroke = Math.max(.75, settings.stroke * size / 100)
  return <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" style={{ display: "block" }}>
    {Array.from({ length: settings.count }, (_, i) => {
      const p = ringPose(i, timeOffset, settings)
      return <ellipse key={i} ref={element => { rings.current[i] = element }} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} opacity={p.opacity} fill="none" stroke={color} strokeWidth={stroke} vectorEffect="non-scaling-stroke" />
    })}
  </svg>
}
