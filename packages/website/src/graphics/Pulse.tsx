import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { MotionValue } from "motion/react"
import { blurRadialField, radialBlurKernel } from "./radialBlur"
import { pulseGatherMs as GATHER_MS, pulseTiming } from "./pulseTiming"

// Ported from the OpenCode blog's diagram vocabulary (src/experiments/Pulse.tsx),
// without the workshop controls. The locked treatment is kept as constants.
//
// A dot that travels an SVG path and is absorbed at the end:
//   gather  — light condenses at the origin
//   travel  — eased along the path
//   arrive  — shrinks into the endpoint while the chosen landing expands and fades

export { GATHER_MS as pulseGatherMs }
const RADIUS = 4
// Heat trail: the path glows where the dot has passed and cools on its own clock.
// Fixed pieces of the path retain their own last-passage timestamp.
const COOL_MS = 1100
const BANDS = 64
const heat = (age: number, cooling: number) => 0.7 * Math.pow(1 - clamp01(age / cooling), 1.7)

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
  /** Optional scene clock in milliseconds; owns playback and allows exact scrubbing. */
  clock?: MotionValue<number>
  /** Travel from the path's end back to its start. */
  reverse?: boolean
  duration?: number
  delay?: number
  /** Tune long routes without changing the shared cooling-trail behavior. */
  trail?: { cooling?: number; segments?: number }
  /** Nearby border outlines, in this SVG's coordinates, catch the traveling light. */
  reflection?: { borders: string; radius?: number; strength?: number }
  /** Orb and trail ink; notifications use a distinct colour so they read apart from ordinary signals. */
  color?: string
  /** Keep trails/reflections off opaque scene details; the bright orb stays above. */
  underlayMask?: string
  /** How the flight spends its time along the path; scenes can slow a stretch of it. */
  ease?: PulseEase
  /** Repeat on a fixed timeline, waiting `gap` ms after the landing between runs. */
  loop?: boolean
  gap?: number
  onArrive?: () => void
  onDepart?: () => void
  onComplete?: () => void
}

export function Pulse({ d, clock, reverse = false, duration = 900, delay = 0, trail: trailOptions, reflection, underlayMask, color = palette.dot, ease = pulseEase, loop = false, gap = 1400, onArrive, onDepart, onComplete }: PulseProps) {
  const cooling = trailOptions?.cooling ?? COOL_MS, segments = trailOptions?.segments ?? BANDS
  const path = useRef<SVGPathElement>(null)
  const dot = useRef<SVGCircleElement>(null)
  const ring = useRef<SVGCircleElement>(null)
  const ring2 = useRef<SVGCircleElement>(null)
  const bands = useRef<(SVGPathElement | null)[]>([])
  const reflectedBorder = useRef<SVGPathElement>(null)
  const reflectedLight = useRef<SVGRadialGradientElement>(null)
  const reflectionStrength = reflection?.strength ?? .6
  const arrive = useRef(onArrive)
  arrive.current = onArrive
  const depart = useRef(onDepart)
  depart.current = onDepart
  const complete = useRef(onComplete)
  complete.current = onComplete
  const bloom = useId()

  useEffect(() => {
    const p = path.current, c = dot.current, r = ring.current, r2 = ring2.current
    if (!p || !c || !r) return
    const pop = LOCKED_POP
    // Path coordinates are local and depend only on d. Measuring a detached
    // copy avoids flushing the live SVG's style/layout after every trail update.
    const geometry = document.createElementNS("http://www.w3.org/2000/svg", "path")
    geometry.setAttribute("d", d)
    const length = geometry.getTotalLength()
    const at = (progress: number) => geometry.getPointAtLength(length * (reverse ? 1 - progress : progress))
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
    let raf = 0
    const timing = pulseTiming(duration, pop.duration, cooling, gap).moments
    const period = timing.repeat.end
    const gathering = timing.gather.end
    const traveling = timing.flight.end - timing.flight.start
    const absorption = timing.absorption.end - timing.absorption.start
    let epoch: number | null = null
    let origin = 0
    let cycle = -1
    let arrived = false
    let departed = false
    let painted = 0
    let previous = -Infinity, completed = false
    const heatedAt = new Float64Array(segments).fill(-Infinity)
    const passedAt = Array.from({ length: segments }, (_, i) => {
      const progress = (i + 0.5) / segments
      const time = ease.inverse(progress)
      const from = length * (reverse ? 1 - (i + 1) / segments : i / segments)
      bands.current[i]?.setAttribute("stroke-dasharray", `${length / segments} ${length + 1}`)
      bands.current[i]?.setAttribute("stroke-dashoffset", String(-from))
      return traveling * time
    })

    const hide = () => { c.setAttribute("r", "0"); r.setAttribute("r", "0"); r.setAttribute("opacity", "0"); r2?.setAttribute("opacity", "0"); reflect(end, 0) }
    // Stamp a segment only when the dot crosses it. Its geometry never retracts;
    // its heat decays independently of the dot, landing ring, or next flight.
    const trail = (now: number, t: number) => {
      while (painted < segments && t >= passedAt[painted]!) {
        heatedAt[painted] = origin + passedAt[painted]!
        painted++
      }
      for (let i = 0; i < segments; i++) {
        const el = bands.current[i]
        if (!el) continue
        el.setAttribute("stroke-opacity", String(heat(now - heatedAt[i]!, cooling)))
      }
    }
    const tick = (now: number) => {
      if (now < previous) { cycle = -1; completed = false }
      previous = now
      // Anchor once. Missed frames must never redefine the next departure time.
      if (epoch === null) epoch = (clock ? 0 : now) + delay + gathering
      const nextCycle = loop ? Math.max(0, Math.floor((now - epoch + gathering) / period)) : 0
      if (nextCycle !== cycle) {
        cycle = nextCycle
        origin = epoch + cycle * period
        arrived = false; departed = false; painted = 0
        // Reconstruct recent heat without replaying callbacks for skipped cycles.
        for (let i = 0; i < segments; i++) heatedAt[i] = cycle > 0 ? origin - period + passedAt[i]! : -Infinity
      }
      const ARRIVE_MS = absorption
      const t = now - origin
      trail(now, t)
      if (!loop && !arrived && t >= traveling) { arrived = true; arrive.current?.() }
      if (t < -gathering) { hide(); schedule(); return }
      if (t < 0) {
        // Gather: a faint disc shrinks onto the origin while the dot fades up inside it.
        if (!departed) { departed = true; depart.current?.() }
        const g = easeOutCubic((t + gathering) / gathering)
        const start = at(0)
        reflect(start, Math.pow(g, 1.5))
        c.setAttribute("cx", String(start.x)); c.setAttribute("cy", String(start.y))
        c.setAttribute("fill", color); c.setAttribute("stroke", "none"); c.removeAttribute("filter")
        c.setAttribute("r", String(RADIUS * g))
        c.setAttribute("opacity", String(Math.pow(g, 1.5)))
        r.setAttribute("cx", String(start.x)); r.setAttribute("cy", String(start.y))
        r.setAttribute("fill", `url(#${bloom})`); r.setAttribute("stroke", "none")
        r.removeAttribute("filter")
        r.setAttribute("r", String(RADIUS + 14 * (1 - g)))
        r.setAttribute("opacity", String(0.5 * Math.sin(g * Math.PI)))
        schedule()
        return
      }

      if (t < traveling) {
        const progress = ease.at(t / traveling)
        const point = at(progress)
        reflect(point, 1)
        c.setAttribute("cx", String(point.x)); c.setAttribute("cy", String(point.y))
        c.setAttribute("r", String(RADIUS))
        c.setAttribute("fill", color); c.setAttribute("stroke", "none"); c.removeAttribute("filter")
        c.setAttribute("opacity", "1")
        r.setAttribute("opacity", "0")
      } else if (t < traveling + ARRIVE_MS) {
        if (!arrived) { arrived = true; arrive.current?.() }
        const q = (t - traveling) / ARRIVE_MS
        reflect(end, Math.pow(1 - q, 2))
        c.setAttribute("cx", String(end.x)); c.setAttribute("cy", String(end.y))
        const spread = clamp01((q - pop.hold) / (1 - pop.hold))
        const release = clamp01((q - pop.fadeHold) / (1 - pop.fadeHold))
        // The dot IS the ring. A radius-2 circle with a width-4 stroke starts as
        // the same solid radius-4 dot; its centre opens as the stroke thins.
        const opening = smoothstep(spread / 0.24)
        c.setAttribute("fill", "none")
        c.setAttribute("stroke", color)
        c.setAttribute("stroke-width", String(RADIUS + (1.5 - RADIUS) * opening))
        c.setAttribute("r", String(RADIUS / 2 + RADIUS / 2 * opening + pop.grow * pop.ease(spread)))
        c.setAttribute("opacity", String((1 + (pop.peak - 1) * opening) * Math.pow(1 - release, pop.fade)))
        r.setAttribute("opacity", "0")
        r2?.setAttribute("opacity", "0")
      } else if (loop) {
        hide()
      } else {
        hide()
        if (t > timing.trail.end - gathering) { if (!completed) { completed = true; complete.current?.() }; return }
      }
      schedule()
    }
    const schedule = () => { if (!clock) raf = requestAnimationFrame(tick) }
    if (clock) {
      tick(clock.get())
      return clock.on("change", tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [d, clock, reverse, duration, delay, cooling, segments, loop, gap, bloom, color, ease, reflection?.borders, reflectionStrength])

  return <g className="pulse">
    <defs>
      <radialGradient id={bloom}>
        <stop offset="0" stopColor={palette.pop[0]} stopOpacity="0.55" />
        <stop offset="0.5" stopColor={palette.pop[1]} stopOpacity="0.22" />
        <stop offset="1" stopColor={palette.pop[1]} stopOpacity="0" />
      </radialGradient>
      {reflection && <radialGradient ref={reflectedLight} id={`${bloom}-reflection`} gradientUnits="userSpaceOnUse" cx={0} cy={0} r={reflection.radius ?? 80}>
        <stop offset="0" stopColor={color} />
        <stop offset=".3" stopColor={color} stopOpacity=".65" />
        <stop offset=".7" stopColor={color} stopOpacity=".16" />
        <stop offset="1" stopColor={color} stopOpacity="0" />
      </radialGradient>}
    </defs>
    <path ref={path} d={d} fill="none" stroke="none" />
    <g mask={underlayMask}>
      {reflection && <path ref={reflectedBorder} data-pulse-reflection="" d={reflection.borders} fill="none" stroke={`url(#${bloom}-reflection)`} strokeWidth={1} opacity={0} />}
      {Array.from({ length: segments }, (_, i) => <path key={i} ref={(el) => { bands.current[i] = el }} className="pulse-trail" d={d} fill="none" stroke={color} strokeWidth={1.6} strokeOpacity={0} strokeLinecap="butt" strokeDasharray="0 99999" />)}
      <circle ref={ring} className="pulse-ring" fill={`url(#${bloom})`} r={0} opacity={0} />
      <circle ref={ring2} className="pulse-ring" fill={`url(#${bloom})`} r={0} opacity={0} />
    </g>
    <circle ref={dot} className="pulse-dot" r={0} fill={color} />
  </g>
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const smoothstep = (p: number) => { const t = clamp01(p); return t * t * (3 - 2 * t) }
const ramp = (t: number, over: number) => Math.min(1, t / over)

/** Per-wave variation. All multipliers hover around 1. */
type Jitter = { speed: number; width: number; radius: number; strength: number }
const stillJitter: Jitter = { speed: 1, width: 1, radius: 1, strength: 1 }
// Sample once per hit: gentle variation, never frame-to-frame noise.
const jitter = (): Jitter => ({
  speed: 1 + (Math.random() * 2 - 1) * 0.04,
  width: 1,
  radius: 1 + (Math.random() * 2 - 1) * 0.1,
  strength: 1 + (Math.random() * 2 - 1) * 0.06,
})

/** A wave's light at normalised radius r (0..1 of the bloom size) at normalised time t (0..1). */
type WaveTuning = { timing: number; easing: number; fade: number; brightness: number; radius: number }
type BloomStyle = { label: string; duration: number; profile: (r: number, t: number, k: number, j: Jitter, tuning: WaveTuning) => number }
/** Soft bump centred on `at`, `width` wide (in the same units as r). */
const bump = (r: number, at: number, width: number) => Math.exp(-Math.pow((r - at) / width, 2) * 2)
const propagation = (t: number, easing: number) => 1 - Math.pow(1 - clamp01(t), easing)
// A patient attack and a continuous release, even at the lowest fade setting.
const glowEnvelope = (t: number, fade: number) => smoothstep(t / 0.2) * Math.exp(-1.8 * t * fade) * (1 - smoothstep((t - 0.5) / 0.5))

export const bloomStyles = {
  ember: {
    label: "Ember: a plugin acts. Bright at the contact, lingers, seeps outward",
    duration: 2200,
    profile: (r, t, k, j) => {
      const radius = (0.1 + 0.7 * Math.sqrt(t)) * j.width
      const core = k * 0.26 * ramp(t, 0.04) * Math.pow(1 - t, 0.9)
      return r >= radius ? 0 : core * Math.pow(1 - r / radius, 2.4)
    },
  },
  // Quiet arrivals: filled fields with no moving crest or hollow centre.
  glow: {
    label: "Glow: a small ember at the contact, gently warming and cooling",
    duration: 5600,
    profile: (r, t, k, j, tuning) => {
      const width = (0.1 + 0.12 * propagation(t, tuning.easing)) * j.width
      return k * 0.18 * glowEnvelope(t, tuning.fade) * Math.exp(-2 * r * r / (width * width))
    },
  },
  breathe: {
    label: "Breathe: a broad, still pool of light that slowly brightens and settles",
    duration: 6400,
    profile: (r, t, k, j, tuning) => {
      const width = 0.42 * j.width
      const attack = smoothstep(propagation(t, tuning.easing) / 0.8)
      return k * 0.1 * attack * glowEnvelope(t, tuning.fade) * Math.exp(-2 * r * r / (width * width))
    },
  },
  seep: {
    label: "Seep: light slowly soaks into the card, spreading and becoming fainter",
    duration: 6800,
    profile: (r, t, k, j, tuning) => {
      const travel = propagation(t, tuning.easing)
      const width = (0.08 + 0.38 * Math.sqrt(travel)) * j.width
      const dispersion = Math.sqrt(0.12 / (0.12 + width))
      return k * 0.2 * dispersion * glowEnvelope(t, tuning.fade) * Math.exp(-2 * r * r / (width * width))
    },
  },
  // ---- travelling fronts: a card was hit ----
  crest: {
    label: "Crest: a quiet travelling ripple, spreading and losing energy as it goes",
    duration: 3600,
    profile: (r, t, k, j, tuning) => {
      // Nearly constant propagation: no initial sprint followed by a stationary halo.
      const radius = 0.02 + 0.96 * propagation(t, tuning.easing)
      const width = (0.045 + 0.055 * t) * j.width
      const dispersion = Math.sqrt(0.045 / width) / Math.sqrt(1 + 2 * radius)
      const envelope = smoothstep(t / 0.065) * Math.pow(1 - smoothstep((t - 0.58) / 0.42), tuning.fade)
      return k * 0.24 * envelope * dispersion * bump(r, radius, width)
    },
  },
  swell: {
    label: "Swell: one wide, soft roller. No hard crest",
    duration: 2600,
    profile: (r, t, k, j, tuning) => {
      const travel = propagation(t, tuning.easing)
      const radius = 0.05 + 0.85 * travel
      const width = (0.26 + 0.22 * travel) * j.width
      return k * 0.24 * ramp(t, 0.06) * Math.pow(1 - t, 1.5 * tuning.fade) * bump(r, radius, width)
    },
  },
  crack: {
    label: "Crack: a fine travelling front with a low, lingering afterglow",
    duration: 2800,
    profile: (r, t, k, j, tuning) => {
      const travel = propagation(t, tuning.easing)
      const radius = 0.05 + 0.85 * travel
      const width = (0.035 + 0.07 * travel) * j.width
      const front = k * 0.38 * smoothstep(t / 0.055) * Math.pow(1 - t, 1.6 * tuning.fade) * bump(r, radius, width)
      const glow = k * 0.025 * smoothstep(t / 0.08) * Math.pow(1 - t, 1.1 * tuning.fade) * bump(r, radius * 0.75, width * 2)
      return front + glow
    },
  },
  train: {
    label: "Train: three crests in a row, each smaller than the last",
    duration: 2400,
    profile: (r, t, k, j, tuning) => {
      const travel = propagation(t, tuning.easing)
      const radius = 0.05 + 0.85 * travel
      const width = (0.05 + 0.08 * travel) * j.width
      const gap = 0.13 * j.width
      let v = 0
      for (let n = 0; n < 3; n++) {
        const rn = radius - n * gap
        if (rn > 0) v += Math.pow(0.62, n) * bump(r, rn, width)
      }
      return k * 0.26 * ramp(t, 0.03) * Math.pow(1 - t, 1.6 * tuning.fade) * v
    },
  },
  flood: {
    label: "Flood: light diffuses from the contact, softens, and fades as a whole",
    duration: 2400,
    profile: (r, t, k, j, tuning) => {
      const travel = propagation(t, tuning.easing)
      // A spreading Gaussian stays filled at its centre. There is no inner front
      // to cut a hole; energy dissipates over the whole field as its width grows.
      const width = (0.07 + 0.6 * Math.sqrt(travel)) * j.width
      const dispersion = Math.sqrt(0.12 / (0.12 + width))
      const fade = Math.exp(-3 * t * tuning.fade) * (1 - smoothstep((t - 0.65) / 0.35))
      return k * 0.32 * smoothstep(t / 0.07) * dispersion * fade * Math.exp(-r * r / (2 * width * width))
    },
  },
} satisfies Record<string, BloomStyle>

export type BloomStyleId = keyof typeof bloomStyles

type RGB = readonly [number, number, number]
const mix = (a: RGB, b: RGB, t: number) => `rgb(${a.map((c, i) => Math.round(c + (b[i]! - c) * t)).join(", ")})`

/** Locked palette: warm gray → white. The wave's colour is a function of heat (0 fringe → 1 crest). */
export const palette = {
  field: (h: number) => mix([140, 136, 130], [236, 233, 228], h),
  pop: ["#e8e4dc", "#9a948c"] as const,
  dot: "#ddd8d0",
  /** Notification signals (something announcing changed data). */
  notify: "#e0b35a",
}

// The blog's selected settings: flood landings, plain propagation, fine ring pop (feel A).
const tuning: WaveTuning = { timing: 0.5, easing: 4, fade: 0.3, brightness: 0.4, radius: 0.5 }
const LOCKED_POP = (() => {
  const ring = { grow: 14, duration: 720, peak: 0.28, fade: 1.8, ease: (q: number) => 1 - Math.pow(1 - q, 2) }
  const popTiming = 1, popSize = 0.65, popFade = 1.4, popBrightness = 0.95
  return { ...ring, hold: 0, fadeHold: 0, duration: ring.duration * popTiming, grow: ring.grow * popSize, fade: ring.fade * popFade, peak: ring.peak * popBrightness }
})()
export const pulseLandingMs = LOCKED_POP.duration

const SAMPLES = 192
// Fixed markup, owned by the field animator. Initial HTML needs no invisible
// samples; attachment fills the opaque, stable wrapper before its first tick.
const fieldStops = { __html: Array.from({ length: SAMPLES }, (_, i) => `<stop offset="${i / (SAMPLES - 1)}" stop-color="${palette.field(0)}" stop-opacity="0"></stop>`).join("") }
const emptyField = { __html: "" }
const FIELD_SCALE = 2
/** One field size per role, so a front travels at the same px speed on every card. */
export const GLOW_SIZE = { leaving: 170 } as const
/** Fade the field to nothing over its outer third so no front ever meets the circle's edge. */
const rim = (r: number) => 1 - smoothstep((r - 0.62) / 0.38)
type Wave = { start: number; style: BloomStyleId; j: Jitter }
type GlassPane = { x: number; y: number; width: number; height: number; rx: number }

/**
 * Blooms inside a card, expanding from the point where a pulse lands or leaves.
 * All live waves are summed into one radial field each frame, so overlapping
 * fronts reinforce like real waves. Each increment of `count` spawns a wave with
 * slight random variation in speed, width and strength.
 */
export type CardGlowProps = {
  id: string; x: number; y: number; width: number; height: number; rx: number; cx: number; cy: number
  count?: number
  /** Clocked scenes sample deterministic hits at `at` (milliseconds). */
  clock?: MotionValue<number>; at?: number | readonly number[]
  /** Count-triggered waves can share a scene's suspended milliseconds. */
  waveClock?: MotionValue<number>
  /** landing = something hit this card (flood); leaving = this card acted (ember). */
  role?: "landing" | "leaving"
  size?: number; strength?: number; style?: BloomStyleId
  /** Frost the same live field behind these panes, without blurring their text. */
  glass?: readonly GlassPane[]
}

export function CardGlow({ id, x, y, width, height, rx, cx, cy, count = 0, clock, waveClock, at = 0, role = "landing", size: sizeProp, strength: strengthProp, style: styleProp, glass }: CardGlowProps) {
  const style: BloomStyleId = styleProp ?? (role === "landing" ? "flood" : "ember")
  // Landing fields are sized to the card: large enough to cross it, but capped by the short axis so the
  // front stays visibly curved. On a thin card a near-flat band just reads as a sliding rectangle.
  const size = sizeProp ?? (role === "landing" ? Math.min(Math.max(width, height) * 1.15, Math.min(width, height) * 2.6) : GLOW_SIZE.leaving)
  const strength = strengthProp ?? (role === "landing" ? 0.48 : 0.5)
  const field = useRef<SVGRadialGradientElement>(null)
  const frostField = useRef<SVGRadialGradientElement>(null)
  const waves = useRef<Wave[]>([])
  const raf = useRef(0)
  const seen = useRef(count)
  const [active, setActive] = useState(false)
  const hits = useMemo(() => typeof at === "number" ? [at] : [...at], [at])
  const kernel = useMemo(() => glass ? radialBlurKernel(SAMPLES, size * FIELD_SCALE, 4) : null, [glass, size])
  useLayoutEffect(() => {
    for (const gradient of [field.current, frostField.current]) {
      if (gradient && !gradient.hasChildNodes()) gradient.innerHTML = fieldStops.__html
    }
  }, [kernel])

  useEffect(() => {
    if (clock) return
    if (count === seen.current) return
    const added = Math.max(0, count - seen.current)
    seen.current = count
    // Append every hit, including batched arrivals. Existing waves keep their own clocks.
    const start = waveClock?.get() ?? performance.now()
    for (let i = 0; i < added; i++) waves.current.push({ start, style, j: jitter() })
    if (added) setActive(true)
  }, [count, style, clock, waveClock])

  useEffect(() => {
    if (!active && !clock) return
    const stops = field.current?.querySelectorAll("stop")
    const frostStops = frostField.current?.querySelectorAll("stop")
    const pixels = new Float32Array(SAMPLES * 4)
    const frosted = new Float32Array(SAMPLES * 4)
    let finished = false
    const tick = (now: number) => {
      const live: Wave[] = []
      const sum = new Float32Array(SAMPLES)
      const current = clock ? hits.map(start => ({ start, style, j: stillJitter })) : waves.current
      for (const wave of current) {
        const spec = bloomStyles[wave.style]
        const landing = wave.style !== "ember"
        const t = (now - wave.start) / (spec.duration * wave.j.speed * (landing ? tuning.timing : 1))
        if (t < 0 || t >= 1) continue
        live.push(wave)
        const k = strength * wave.j.strength * (landing ? tuning.brightness : 1)
        for (let i = 0; i < SAMPLES; i++) {
          const r = FIELD_SCALE * i / (SAMPLES - 1) / (wave.j.radius * (landing ? tuning.radius : 1))
          sum[i] += spec.profile(r, t, k, wave.j, tuning) * rim(r)
        }
      }
      waves.current = live
      for (let i = 0; i < SAMPLES; i++) {
        const stop = stops?.[i]
        if (!stop) continue
        const ceiling = role === "landing" ? 0.18 : 0.3
        const a = ceiling * (1 - Math.exp(-sum[i]! / ceiling))
        stop.setAttribute("stop-opacity", String(a))
        // Absolute energy, never normalised against the newest crest.
        const heatValue = clamp01(sum[i]! / 0.22)
        stop.setAttribute("stop-color", palette.field(heatValue))
        if (kernel) {
          pixels[i * 4] = Math.round(140 + 96 * heatValue) * a
          pixels[i * 4 + 1] = Math.round(136 + 97 * heatValue) * a
          pixels[i * 4 + 2] = Math.round(130 + 98 * heatValue) * a
          pixels[i * 4 + 3] = a
        }
      }
      if (kernel) {
        blurRadialField(pixels, kernel, frosted)
        for (let i = 0; i < SAMPLES; i++) {
          const stop = frostStops?.[i]
          if (!stop) continue
          const alpha = frosted[i * 4 + 3]!
          stop.setAttribute("stop-opacity", String(alpha))
          stop.setAttribute("stop-color", alpha > 0 ? `rgb(${Math.round(frosted[i * 4]! / alpha)}, ${Math.round(frosted[i * 4 + 1]! / alpha)}, ${Math.round(frosted[i * 4 + 2]! / alpha)})` : palette.field(0))
        }
      }
      if (!clock) {
        if (live.length) {
          if (!waveClock) raf.current = requestAnimationFrame(tick)
        } else if (!finished) { finished = true; setActive(false) }
      }
    }
    const driver = clock ?? waveClock
    if (driver) {
      tick(driver.get())
      return driver.on("change", tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [active, strength, role, kernel, clock, waveClock, hits, style])

  return <>
    <defs>
      <clipPath id={`${id}-clip`}><rect x={x} y={y} width={width} height={height} rx={rx} /></clipPath>
      <radialGradient ref={field} id={`${id}-field`} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={size * FIELD_SCALE} dangerouslySetInnerHTML={emptyField} />
      {glass && kernel && <>
        <radialGradient ref={frostField} id={`${id}-frost-field`} gradientUnits="userSpaceOnUse" cx={cx} cy={cy} r={size * FIELD_SCALE} dangerouslySetInnerHTML={emptyField} />
        <clipPath id={`${id}-glass-clip`}>
          {glass.map((pane, i) => <rect key={i} {...pane} />)}
        </clipPath>
        <mask id={`${id}-glass-cutout`} maskUnits="userSpaceOnUse" x={x} y={y} width={width} height={height}>
          <rect x={x} y={y} width={width} height={height} fill="white" />
          {glass.map((pane, i) => <rect key={i} {...pane} fill="black" />)}
        </mask>
      </>}
    </defs>
    {(active || clock) && <>
      <g clipPath={`url(#${id}-clip)`}>
        <g mask={glass ? `url(#${id}-glass-cutout)` : undefined}>
          <rect className="pulse-glow" x={x} y={y} width={width} height={height} fill={`url(#${id}-field)`} />
        </g>
        {glass && kernel && <g clipPath={`url(#${id}-glass-clip)`}>
          <rect className="pulse-glow" x={x} y={y} width={width} height={height} fill={`url(#${id}-frost-field)`} />
        </g>}
      </g>
      {/* the border catches the light as the front passes it */}
      <rect className="pulse-rim" x={x} y={y} width={width} height={height} rx={rx} fill="none" stroke={`url(#${id}-field)`} strokeWidth={1.5} opacity={0.4} />
    </>}
  </>
}
