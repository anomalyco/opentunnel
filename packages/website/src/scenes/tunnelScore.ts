import { at, clip, compile, hold, parallel, scenePace, type Moment } from "../graphics/sceneTiming"
import { pulseTiming } from "../graphics/pulseTiming"
import { pulseEase, pulseLandingMs, type PulseEase } from "../graphics/Pulse"

// The hero's story, in seconds: a visitor's request leaves the browser, passes
// through the relay (which scans it and sees only its shape) and lands on the
// matching local app, the first thing to open it. Three routes, one clock.

export const tunnelRoutes = [
  { id: "opencode", name: "opencode", target: "localhost:47365", icon: "terminal" },
  { id: "api", name: "api", target: "localhost:3000", icon: "layers" },
  { id: "webhooks", name: "webhooks", target: "localhost:8080", icon: "webhook" },
] as const

/** One pulse: gather, flight, landing. `send` is when light leaves the origin socket; `contact` when it lands. */
const signal = (travel: number) => {
  const timing = pulseTiming(travel * 1000, pulseLandingMs)
  return clip({
    duration: timing.moments.absorption.end / 1000,
    moments: { send: timing.moments.flight.start / 1000, contact: timing.moments.flight.end / 1000 },
    value: { travel: travel * 1000 },
  })
}

const travel = 2.6

function leg(start: number | Moment) {
  const pulse = at(start, signal(travel))
  const read = at(pulse.moments.contact, hold(scenePace.read + .3))
  return { pulse, read }
}

const first = leg(.4)
const second = leg(first.read.moments.end)
const third = leg(second.read.moments.end)
const rest = at(third.read.moments.end, hold(.6))

export const tunnelScore = compile(parallel({
  pulse0: first.pulse, read0: first.read,
  pulse1: second.pulse, read1: second.read,
  pulse2: third.pulse, read2: third.read,
  rest,
}))

const m = tunnelScore.moments
export const tunnelLegs = [m.pulse0, m.pulse1, m.pulse2] as const
export const tunnelTravel = travel * 1000

/** A flight that hits something thick in one stretch of its path, like a round entering water: it arrives at
 * speed, slows smoothly over the first stretch inside, crawls, then builds speed hard through the back half and
 * leaves faster than it came, bleeding the excess off along the next run of wire. Speed is a smooth profile over
 * path distance, integrated into a table; no kinks. */
export function viscousFlight(from: number, to: number, drag: number): PulseEase {
  const N = 1024
  const span = to - from, crawl = 1 / drag
  const clamp = (x: number) => Math.max(0, Math.min(1, x))
  const speed = (p: number) => {
    const u = (p - from) / span
    const slowing = smooth(u / .3)
    const building = Math.pow(clamp((u - .3) / .7), 3)
    const inside = slowing * (1 - building)
    // Leaves at nearly twice wire speed; the surplus decays over the following stretch of path.
    const surplus = u <= 1 ? .9 * Math.pow(clamp((u - .5) / .5), 2) : .9 * Math.exp(-(p - to) / (span * .6))
    return 1 - (1 - crawl) * inside + surplus
  }
  // Cumulative time over distance, normalised to 1.
  const times = new Float64Array(N + 1)
  for (let i = 1; i <= N; i++) times[i] = times[i - 1]! + 1 / speed((i - .5) / N) / N
  const total = times[N]!
  for (let i = 0; i <= N; i++) times[i]! /= total
  const timeAt = (p: number) => { const x = Math.max(0, Math.min(1, p)) * N, i = Math.floor(x), f = x - i; return i >= N ? 1 : times[i]! + (times[i + 1]! - times[i]!) * f }
  const distanceAt = (u: number) => {
    let low = 0, high = N
    while (high - low > 1) { const mid = (low + high) >> 1; if (times[mid]! < u) low = mid; else high = mid }
    const f = (u - times[low]!) / Math.max(1e-9, times[high]! - times[low]!)
    return (low + f) / N
  }
  return { at: time => distanceAt(pulseEase.at(time)), inverse: distance => pulseEase.inverse(timeAt(distance)) }
}
const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }
