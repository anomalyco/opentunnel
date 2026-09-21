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
 * speed, decelerates hard on impact, crawls through the middle and gathers speed again toward the far wall.
 * The stretch [from, to] takes `drag` times its share of the eased flight. The inverse is exact by bisection. */
export function viscousFlight(from: number, to: number, drag: number): PulseEase {
  const before = from, inside = (to - from) * drag, after = 1 - to
  const total = before + inside + after
  // Inside: distance over local time, fast at both walls and slowest midway, with a floor so it never stalls.
  const plunge = (tau: number) => {
    const shape = tau < .5 ? .5 * (1 - Math.pow(1 - 2 * tau, 3)) : .5 + .5 * Math.pow(2 * tau - 1, 3)
    return .78 * shape + .22 * tau
  }
  const at = (time: number) => {
    const v = pulseEase.at(time) * total
    if (v <= before) return v
    if (v <= before + inside) return from + (to - from) * plunge((v - before) / inside)
    return to + (v - before - inside)
  }
  const inverse = (distance: number) => {
    let low = 0, high = 1
    for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (at(mid) < distance) low = mid; else high = mid }
    return (low + high) / 2
  }
  return { at, inverse }
}
