import { after, at, compile, hold, parallel } from "./sceneTiming"

export const pulseGatherMs = 340
/** Millisecond boundary for the existing SVG renderer. All dependent moments
 * come from this plan, including callbacks, repeated cadence and cooling tails. */
export function pulseTiming(travel: number, landing: number, cooling = 1100, gap = 1400) {
  const gather = at(0, hold(pulseGatherMs))
  const flight = at(gather.moments.end, hold(travel))
  const absorption = at(flight.moments.end, hold(landing))
  const trail = at(flight.moments.end, hold(cooling))
  const repeat = at(absorption.moments.end, hold(gap))
  const complete = at(after(flight.moments.end, Math.max(landing, cooling)), hold(0))
  return compile(parallel({ gather, flight, absorption, trail, repeat, complete }), { unit: "milliseconds" })
}
