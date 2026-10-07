import { at, clip, compile, hold, parallel, scenePace, type Moment } from "../graphics/sceneTiming"
import { pulseTiming } from "../graphics/pulseTiming"
import { pulseLandingMs } from "../graphics/Pulse"

// The hero's story, in seconds: a visitor's request leaves the browser, passes
// through the relay (which scans it and sees only its shape) and lands on the
// matching local app, the first thing to open it. Three routes, a shuffled stream of requests, one clock.

export const tunnelRoutes = [
  { id: "opencode", name: "opencode", target: "localhost:47365", icon: "terminal", request: "GET /", shape: 0 },
  { id: "api", name: "api", target: "localhost:3000", icon: "layers", request: "POST /api", shape: 1 },
  { id: "webhooks", name: "webhooks", target: "localhost:8080", icon: "webhook", request: "POST /hook", shape: 2 },
] as const

/** One pulse: gather, flight, landing. `send` is when light leaves the origin socket; `contact` when it lands. */
const signal = (travel: number) => {
  const timing = pulseTiming(travel * 1000, pulseLandingMs)
  return clip({
    duration: timing.moments.absorption.end / 1000,
    moments: { send: timing.moments.flight.start / 1000, contact: timing.moments.flight.end / 1000 },
  })
}

// The original flight (2.6 s of wire and a thick relay), plus the time spent slowing through the browser's border and
// your machine's (tunnelFlight's borderCrawl).
const travel = 2.6 + .5

/** The destinations, in order: shuffled, never the same twice running, including across the loop's wrap. */
export const tunnelSequence = [1, 2, 0, 2, 1, 0, 1, 2, 0] as const

// One request after another with no gap but the read: the landing, then the browser choosing the next destination
// (Cipher's chooseSeconds). The first starts at zero, so its choosing runs across the loop's wrap and the stream is
// seamless.
function leg(start: number | Moment) {
  const pulse = at(start, signal(travel))
  const read = at(pulse.moments.contact, hold(scenePace.read + 1.7))
  return { pulse, read }
}
type Leg = ReturnType<typeof leg>
const legs: Leg[] = []
for (const _ of tunnelSequence) legs.push(leg(legs.length ? legs[legs.length - 1]!.read.moments.end : 0))

export const tunnelScore = compile(parallel(Object.fromEntries(legs.flatMap(({ pulse, read }, index) => [[`pulse${index}`, pulse], [`read${index}`, read]])) as Record<string, Leg["pulse"] | Leg["read"]>))

type LegMoments = { start: number; end: number; send: number; contact: number }
const moments = tunnelScore.moments as unknown as Record<string, LegMoments>
/** Each request's moments and its destination (an index into tunnelRoutes). */
export const tunnelLegs = tunnelSequence.map((route, index) => ({ ...moments[`pulse${index}`]!, route }))
export const tunnelTravel = travel * 1000
