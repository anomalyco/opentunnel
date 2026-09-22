import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react"
import type { MotionValue } from "motion/react"
import { pulseGatherMs as GATHER_MS, pulseTiming } from "./pulseTiming"

// Ported from the OpenCode blog's diagram vocabulary (src/experiments/Pulse.tsx), reduced to what this
// page draws: one clocked flight per leg, and clocked blooms inside the cards.
//
// A dot that travels an SVG path and is absorbed at the end:
//   gather  — light condenses at the origin
//   travel  — eased along the path
//   arrive  — shrinks into the endpoint while the landing ring expands and fades

export { GATHER_MS as pulseGatherMs }
const RADIUS = 4
// Heat trail: the path glows where the dot has passed and cools on its own clock, in fixed pieces that keep
// their own last-passage timestamp.
const COOL_MS = 300
const BANDS = 256
const heat = (age: number) => 0.7 * Math.pow(1 - clamp01(age / COOL_MS), 1.7)

const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3)

/** Flight curve: time (0..1) → distance along the path (0..1), and its inverse for the trail's stamps. */
export type PulseEase = { at: (time: number) => number; inverse: (distance: number) => number }
export const pulseEase: PulseEase = {
  at: easeInOutCubic,
  inverse: distance => distance < 0.5 ? Math.cbrt(distance / 4) : 1 - Math.cbrt((1 - distance) / 4),
}

type PulseProps = {
  d: string
  /** The scene clock in milliseconds; owns playback and allows exact scrubbing. */
  clock: MotionValue<number>
  duration: number
  delay: number
  /** Nearby border outlines, in this SVG's coordinates, catch the traveling light. */
  reflection?: { borders: string; radius?: number; strength?: number; width?: number }
  /** Keep trails/reflections off opaque scene details; the bright orb stays above. */
  underlayMask?: string
  /** How the flight spends its time along the path; scenes can slow a stretch of it. */
  ease?: PulseEase
}

export function Pulse({ d, clock, duration, delay, reflection, underlayMask, ease = pulseEase }: PulseProps) {
  const path = useRef<SVGPathElement>(null)
  const dot = useRef<SVGCircleElement>(null)
  const ring = useRef<SVGCircleElement>(null)
  const bands = useRef<(SVGPathElement | null)[]>([])
  const reflectedBorder = useRef<SVGPathElement>(null)
  const reflectedLight = useRef<SVGRadialGradientElement>(null)
  const reflectionStrength = reflection?.strength ?? .6
  const bloom = useId()

  useEffect(() => {
    const p = path.current, c = dot.current, r = ring.current
    if (!p || !c || !r) return
    const pop = LOCKED_POP
    // Path coordinates are local and depend only on d. Measuring a detached copy avoids flushing the live
    // SVG's style/layout after every trail update.
    const geometry = document.createElementNS("http://www.w3.org/2000/svg", "path")
    geometry.setAttribute("d", d)
    const length = geometry.getTotalLength()
    const at = (progress: number) => geometry.getPointAtLength(length * progress)
    const end = at(1)
    const border = reflectedBorder.current, light = reflectedLight.current
    let lastLightPosition = "", lastLightStrength = -1
    // Reuse the dot's sampled point. No second clock, geometry query, or layout read.
    const reflect = (point: { x: number; y: number }, strength: number) => {
      if (!border || !light) return
      const position = `translate(${point.x} ${point.y})`
      if (position !== lastLightPosition && strength > 0) { light.setAttribute("gradientTransform", position); lastLightPosition = position }
      if (strength !== lastLightStrength) { border.setAttribute("opacity", String(strength * reflectionStrength)); lastLightStrength = strength }
    }
    const timing = pulseTiming(duration, pop.duration).moments
    const gathering = timing.gather.end
    const traveling = timing.flight.end - timing.flight.start
    const absorption = timing.absorption.end - timing.absorption.start
    const origin = delay + gathering
    let painted = 0
    let previous = -Infinity
    const heatedAt = new Float64Array(BANDS).fill(-Infinity)
    // Each band is its own short polyline along its stretch of the path, not a dash of the whole path: stroking
    // hundreds of full-length dashed paths a frame is what made Safari crawl.
    const passedAt = Array.from({ length: BANDS }, (_, i) => {
      const from = length * i / BANDS, step = length / BANDS / 3
      const points = Array.from({ length: 4 }, (_, k) => geometry.getPointAtLength(Math.min(length, from + k * step)))
      bands.current[i]?.setAttribute("d", points.map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(""))
      return traveling * ease.inverse((i + 0.5) / BANDS)
    })
    const shown = new Float64Array(BANDS)

    const hide = () => { c.setAttribute("r", "0"); r.setAttribute("r", "0"); r.setAttribute("opacity", "0"); reflect(end, 0) }
    // Stamp a segment only when the dot crosses it. Its geometry never retracts; its heat decays
    // independently of the dot and the landing ring.
    const trail = (now: number, t: number) => {
      while (painted < BANDS && t >= passedAt[painted]!) {
        heatedAt[painted] = origin + passedAt[painted]!
        painted++
      }
      // Only bands whose heat changed are written; cold bands are hidden rather than stroked at zero.
      for (let i = 0; i < BANDS; i++) {
        const value = heat(now - heatedAt[i]!)
        if (value === shown[i]) continue
        shown[i] = value
        const band = bands.current[i]
        if (!band) continue
        if (value === 0) band.setAttribute("visibility", "hidden")
        else { band.removeAttribute("visibility"); band.setAttribute("stroke-opacity", value.toFixed(3)) }
      }
    }
    const tick = (now: number) => {
      // Rewound: the trail starts over.
      if (now < previous) { painted = 0; heatedAt.fill(-Infinity) }
      previous = now
      const t = now - origin
      trail(now, t)
      if (t < -gathering) { hide(); return }
      if (t < 0) {
        // Gather: a faint disc shrinks onto the origin while the dot fades up inside it.
        const g = easeOutCubic((t + gathering) / gathering)
        const start = at(0)
        reflect(start, Math.pow(g, 1.5))
        c.setAttribute("cx", String(start.x)); c.setAttribute("cy", String(start.y))
        c.setAttribute("fill", palette.dot); c.setAttribute("stroke", "none")
        c.setAttribute("r", String(RADIUS * g))
        c.setAttribute("opacity", String(Math.pow(g, 1.5)))
        r.setAttribute("cx", String(start.x)); r.setAttribute("cy", String(start.y))
        r.setAttribute("r", String(RADIUS + 14 * (1 - g)))
        r.setAttribute("opacity", String(0.5 * Math.sin(g * Math.PI)))
        return
      }
      if (t < traveling) {
        const point = at(ease.at(t / traveling))
        reflect(point, 1)
        c.setAttribute("cx", String(point.x)); c.setAttribute("cy", String(point.y))
        c.setAttribute("r", String(RADIUS))
        c.setAttribute("fill", palette.dot); c.setAttribute("stroke", "none")
        c.setAttribute("opacity", "1")
        r.setAttribute("opacity", "0")
      } else if (t < traveling + absorption) {
        const q = (t - traveling) / absorption
        reflect(end, Math.pow(1 - q, 2))
        c.setAttribute("cx", String(end.x)); c.setAttribute("cy", String(end.y))
        // The dot IS the ring. A radius-2 circle with a width-4 stroke starts as the same solid radius-4 dot;
        // its centre opens as the stroke thins.
        const opening = smoothstep(q / 0.24)
        c.setAttribute("fill", "none")
        c.setAttribute("stroke", palette.dot)
        c.setAttribute("stroke-width", String(RADIUS + (1.5 - RADIUS) * opening))
        c.setAttribute("r", String(RADIUS / 2 + RADIUS / 2 * opening + pop.grow * pop.ease(q)))
        c.setAttribute("opacity", String((1 + (pop.peak - 1) * opening) * Math.pow(1 - q, pop.fade)))
        r.setAttribute("opacity", "0")
      } else hide()
    }
    tick(clock.get())
    return clock.on("change", tick)
  }, [d, clock, duration, delay, bloom, ease, reflection?.borders, reflectionStrength])

  return <g className="pulse">
    <defs>
      <radialGradient id={bloom}>
        <stop offset="0" stopColor={palette.pop[0]} stopOpacity="0.55" />
        <stop offset="0.5" stopColor={palette.pop[1]} stopOpacity="0.22" />
        <stop offset="1" stopColor={palette.pop[1]} stopOpacity="0" />
      </radialGradient>
      {reflection && <radialGradient ref={reflectedLight} id={`${bloom}-reflection`} gradientUnits="userSpaceOnUse" cx={0} cy={0} r={reflection.radius ?? 80}>
        <stop offset="0" stopColor={palette.dot} />
        <stop offset=".3" stopColor={palette.dot} stopOpacity=".65" />
        <stop offset=".7" stopColor={palette.dot} stopOpacity=".16" />
        <stop offset="1" stopColor={palette.dot} stopOpacity="0" />
      </radialGradient>}
    </defs>
    <path ref={path} d={d} fill="none" stroke="none" />
    <g mask={underlayMask}>
      {reflection && <path ref={reflectedBorder} d={reflection.borders} fill="none" stroke={`url(#${bloom}-reflection)`} strokeWidth={reflection.width ?? 1} opacity={0} />}
      {Array.from({ length: BANDS }, (_, i) => <path key={i} ref={(el) => { bands.current[i] = el }} className="pulse-trail" fill="none" stroke={palette.dot} strokeWidth={1.6} strokeOpacity={0} strokeLinecap="butt" visibility="hidden" />)}
      <circle ref={ring} className="pulse-ring" fill={`url(#${bloom})`} r={0} opacity={0} />
    </g>
    <circle ref={dot} className="pulse-dot" r={0} fill={palette.dot} />
  </g>
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smoothstep = (p: number) => { const t = clamp01(p); return t * t * (3 - 2 * t) }
const ramp = (t: number, over: number) => Math.min(1, t / over)

/** A wave's light at normalised radius r (0..1 of the bloom size) at normalised time t (0..1). */
type BloomStyle = { duration: number; profile: (r: number, t: number, k: number) => number }
/** Soft bump centred on `at`, `width` wide (in the same units as r). */
const bump = (r: number, at: number, width: number) => Math.exp(-Math.pow((r - at) / width, 2) * 2)
// The blog's selected propagation and fade for landings.
const EASING = 4, FADE = 0.3
const propagation = (t: number) => 1 - Math.pow(1 - clamp01(t), EASING)

const bloomStyles = {
  /** A plugin acts: bright at the contact, lingers, seeps outward. */
  ember: {
    duration: 2200,
    profile: (r, t, k) => {
      const radius = 0.1 + 0.7 * Math.sqrt(t)
      const core = k * 0.26 * ramp(t, 0.04) * Math.pow(1 - t, 0.9)
      return r >= radius ? 0 : core * Math.pow(1 - r / radius, 2.4)
    },
  },
  /** A card was hit: a fine travelling front with a low, lingering afterglow. */
  crack: {
    duration: 2800,
    profile: (r, t, k) => {
      const travel = propagation(t)
      const radius = 0.05 + 0.85 * travel
      const width = 0.035 + 0.07 * travel
      const front = k * 0.38 * smoothstep(t / 0.055) * Math.pow(1 - t, 1.6 * FADE) * bump(r, radius, width)
      const glow = k * 0.025 * smoothstep(t / 0.08) * Math.pow(1 - t, 1.1 * FADE) * bump(r, radius * 0.75, width * 2)
      return front + glow
    },
  },
  /** Light diffuses from the contact, softens, and fades as a whole. */
  flood: {
    duration: 2400,
    profile: (r, t, k) => {
      const travel = propagation(t)
      // A spreading Gaussian stays filled at its centre: no inner front cuts a hole; energy dissipates over
      // the whole field as its width grows.
      const width = 0.07 + 0.6 * Math.sqrt(travel)
      const dispersion = Math.sqrt(0.12 / (0.12 + width))
      const fade = Math.exp(-3 * t * FADE) * (1 - smoothstep((t - 0.65) / 0.35))
      return k * 0.32 * smoothstep(t / 0.07) * dispersion * fade * Math.exp(-r * r / (2 * width * width))
    },
  },
} satisfies Record<string, BloomStyle>
type BloomStyleId = keyof typeof bloomStyles

type RGB = readonly [number, number, number]
const mix = (a: RGB, b: RGB, t: number) => `rgb(${a.map((c, i) => Math.round(c + (b[i]! - c) * t)).join(", ")})`

/** Locked palette: warm gray → white. The wave's colour is a function of heat (0 fringe → 1 crest). */
export const palette = {
  field: (h: number) => mix([140, 136, 130], [236, 233, 228], h),
  pop: ["#e8e4dc", "#9a948c"] as const,
  dot: "#ddd8d0",
}

// The blog's selected landing: fine ring pop (feel A).
const LOCKED_POP = { grow: 14 * 0.65, duration: 720, peak: 0.28 * 0.95, fade: 1.8 * 1.4, ease: (q: number) => 1 - Math.pow(1 - q, 2) }
export const pulseLandingMs = LOCKED_POP.duration

const SAMPLES = 192
// Fixed markup, owned by the field animator: attachment fills the stable wrapper before its first tick.
const fieldStops = Array.from({ length: SAMPLES }, (_, i) => `<stop offset="${i / (SAMPLES - 1)}" stop-color="${palette.field(0)}" stop-opacity="0"></stop>`).join("")
const emptyField = { __html: "" }
const FIELD_SCALE = 2
/** Fade the field to nothing over its outer third so no front ever meets the circle's edge. */
const rim = (r: number) => 1 - smoothstep((r - 0.62) / 0.38)
// Landings are scaled the blog's way: slower, dimmer and tighter than a plugin's own ember.
const landing = { timing: 0.5, brightness: 0.4, radius: 0.5 }

/**
 * Blooms inside a card, expanding from the point where a pulse lands or leaves, at scene times `at`
 * (milliseconds). All live waves are summed into one radial field each frame, so overlapping fronts
 * reinforce like real waves.
 */
type CardGlowProps = {
  id: string; x: number; y: number; width: number; height: number; rx: number; cx: number; cy: number
  clock: MotionValue<number>; at: number | readonly number[]
  /** landing = something hit this card (flood); leaving = this card acted (ember). */
  role?: "landing" | "leaving"
  size?: number; strength?: number; style?: BloomStyleId
}

export function CardGlow({ id, x, y, width, height, rx, cx, cy, clock, at, role = "landing", size: sizeProp, strength: strengthProp, style: styleProp }: CardGlowProps) {
  const style: BloomStyleId = styleProp ?? (role === "landing" ? "flood" : "ember")
  // Landing fields are sized to the card: large enough to cross it, but capped by the short axis so the
  // front stays visibly curved. On a thin card a near-flat band just reads as a sliding rectangle.
  const size = sizeProp ?? (role === "landing" ? Math.min(Math.max(width, height) * 1.15, Math.min(width, height) * 2.6) : 170)
  const strength = strengthProp ?? (role === "landing" ? 0.48 : 0.5)
  const field = useRef<SVGRadialGradientElement>(null)
  const hits = useMemo(() => typeof at === "number" ? [at] : [...at], [at])
  useLayoutEffect(() => {
    const gradient = field.current
    if (gradient && !gradient.hasChildNodes()) gradient.innerHTML = fieldStops
  }, [])

  useEffect(() => {
    const stops = field.current?.querySelectorAll("stop")
    const spec = bloomStyles[style], isLanding = style !== "ember"
    const sum = new Float32Array(SAMPLES)
    const tick = (now: number) => {
      sum.fill(0)
      for (const start of hits) {
        const t = (now - start) / (spec.duration * (isLanding ? landing.timing : 1))
        if (t < 0 || t >= 1) continue
        const k = strength * (isLanding ? landing.brightness : 1)
        for (let i = 0; i < SAMPLES; i++) {
          const r = FIELD_SCALE * i / (SAMPLES - 1) / (isLanding ? landing.radius : 1)
          sum[i] += spec.profile(r, t, k) * rim(r)
        }
      }
      const ceiling = role === "landing" ? 0.18 : 0.3
      for (let i = 0; i < SAMPLES; i++) {
        const stop = stops?.[i]
        if (!stop) continue
        stop.setAttribute("stop-opacity", String(ceiling * (1 - Math.exp(-sum[i]! / ceiling))))
        // Absolute energy, never normalised against the newest crest.
        stop.setAttribute("stop-color", palette.field(clamp01(sum[i]! / 0.22)))
      }
    }
    tick(clock.get())
    return clock.on("change", tick)
  }, [strength, role, clock, hits, style])

  return <>
    <defs>
      <clipPath id={`${id}-clip`}><rect x={x} y={y} width={width} height={height} rx={rx} /></clipPath>
      <radialGradient ref={field} id={`${id}-field`} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={size * FIELD_SCALE} dangerouslySetInnerHTML={emptyField} />
    </defs>
    <g clipPath={`url(#${id}-clip)`}>
      <rect className="pulse-glow" x={x} y={y} width={width} height={height} fill={`url(#${id}-field)`} />
    </g>
    {/* the border catches the light as the front passes it */}
    <rect className="pulse-rim" x={x} y={y} width={width} height={height} rx={rx} fill="none" stroke={`url(#${id}-field)`} strokeWidth={1.5} opacity={0.4} />
  </>
}
