import { pulseEase, type PulseEase } from "../graphics/Pulse"
import { tunnelLegs, tunnelTravel, viscousFlight } from "./tunnelScore"

// One leg's flight as the sound hears it: when the dot enters and leaves the relay, and how fast it is
// moving at any scene time. Pure, so the offline track render can build the same flights from the
// page's measured path fractions.

export type Crossing = {
  enter: number; leave: number; read: number
  /** The measured path fractions and layout this crossing was built from, so it can be rebuilt away from the DOM. */
  fractions: LegFractions; stacked: boolean
  /** Speed at a scene time, in path lengths per flight: 1 is the mean, the crawl inside the relay ≈ .25, the exit rush > 2. Zero when not flying. */
  speedAt: (time: number) => number
}

/** How much of the leg's path the relay occupies, as fractions; `stacked` legs (phones) have no relay stretch. */
export type LegFractions = { enter: number; leave: number }

export const legEase = (fractions: LegFractions, stacked: boolean): PulseEase => stacked ? pulseEase : viscousFlight(fractions.enter, fractions.leave, 5)

export function legCrossing(index: number, fractions: LegFractions, stacked: boolean): Crossing {
  const ease = legEase(fractions, stacked)
  const { send } = tunnelLegs[index]!
  const flight = tunnelTravel / 1000
  const enter = send + ease.inverse(fractions.enter) * flight, leave = send + ease.inverse(fractions.leave) * flight
  const h = 1 / 512
  return {
    enter, leave, read: (enter + leave) / 2, fractions: { enter: fractions.enter, leave: fractions.leave }, stacked,
    speedAt: time => {
      const u = (time - send) / flight
      if (u <= 0 || u >= 1) return 0
      return (ease.at(Math.min(1, u + h)) - ease.at(Math.max(0, u - h))) / (Math.min(1, u + h) - Math.max(0, u - h))
    },
  }
}
