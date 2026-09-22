import { pulseEase, type PulseEase } from "../graphics/Pulse"
import { tunnelLegs, tunnelTravel } from "./tunnelScore"

// One leg's flight as the sound hears it: when the dot enters and leaves the relay, and how fast it is
// moving at any scene time. Pure, so the offline track render can build the same flights from the
// page's measured path fractions.

export type Crossing = {
  enter: number; leave: number
  /** How the flight spends its time along the path. */
  ease: PulseEase
  /** The measured path fractions this crossing was built from, so the offline track render
   * (scripts/render-track.ts) can rebuild it away from the DOM. */
  fractions: LegFractions
  /** Speed at a scene time, in path lengths per flight: 1 is the mean, the crawl inside the relay ≈ .25, the exit rush > 2. Zero when not flying. */
  speedAt: (time: number) => number
}

/** How much of the leg's path the relay occupies, as fractions. */
export type LegFractions = { enter: number; leave: number }

export function legCrossing(index: number, fractions: LegFractions): Crossing {
  const ease = viscousFlight(fractions.enter, fractions.leave, 5)
  const { send } = tunnelLegs[index]!
  const flight = tunnelTravel / 1000
  const enter = send + ease.inverse(fractions.enter) * flight, leave = send + ease.inverse(fractions.leave) * flight
  const h = 1 / 512
  return {
    enter, leave, ease, fractions: { enter: fractions.enter, leave: fractions.leave },
    speedAt: time => {
      const u = (time - send) / flight
      if (u <= 0 || u >= 1) return 0
      return (ease.at(Math.min(1, u + h)) - ease.at(Math.max(0, u - h))) / (Math.min(1, u + h) - Math.max(0, u - h))
    },
  }
}

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
