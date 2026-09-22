import { at, compile, hold, parallel } from "./sceneTiming"

export const pulseGatherMs = 340
/** One pulse's moments, in milliseconds: gather at the origin, the flight, the landing's absorption. */
export function pulseTiming(travel: number, landing: number) {
  const gather = at(0, hold(pulseGatherMs))
  const flight = at(gather.moments.end, hold(travel))
  const absorption = at(flight.moments.end, hold(landing))
  return compile(parallel({ gather, flight, absorption }))
}
