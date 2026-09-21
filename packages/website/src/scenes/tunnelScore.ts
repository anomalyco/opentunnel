import { after, at, clip, compile, hold, parallel, scenePace } from "../graphics/sceneTiming"
import { pulseTiming } from "../graphics/pulseTiming"
import { pulseLandingMs } from "../graphics/Pulse"

// The hero's story, in seconds: a visitor's request leaves the browser, the relay
// reads only the hostname off the handshake and passes the sealed bytes on, and
// the matching local app is the first thing to open them. Three routes, one clock.

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

const requestTravel = .9, hopTravel = .8

function leg(start: number | ReturnType<typeof after>) {
  const request = at(start, signal(requestTravel))
  // The relay reads the hostname, then the sealed bytes leave its far socket.
  const hop = at(after(request.moments.contact, scenePace.react), signal(hopTravel))
  const read = at(hop.moments.contact, hold(scenePace.read + .2))
  return { request, hop, read }
}

const first = leg(.4)
const second = leg(first.read.moments.end)
const third = leg(second.read.moments.end)
const rest = at(third.read.moments.end, hold(.6))

export const tunnelScore = compile(parallel({
  request0: first.request, hop0: first.hop, read0: first.read,
  request1: second.request, hop1: second.hop, read1: second.read,
  request2: third.request, hop2: third.hop, read2: third.read,
  rest,
}))

const m = tunnelScore.moments
export const tunnelLegs = [
  { request: m.request0, hop: m.hop0 },
  { request: m.request1, hop: m.hop1 },
  { request: m.request2, hop: m.hop2 },
] as const

export const tunnelTravel = { request: requestTravel * 1000, hop: hopTravel * 1000 }
