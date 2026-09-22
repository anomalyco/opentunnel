import { at, clip, compile, hold, parallel, scenePace, type Moment } from "../graphics/sceneTiming"
import { pulseTiming } from "../graphics/pulseTiming"
import { pulseLandingMs } from "../graphics/Pulse"

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
