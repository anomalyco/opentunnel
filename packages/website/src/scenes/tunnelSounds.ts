import { useEffect, useMemo, useRef, type RefObject } from "react"
import { useMotionValueEvent, type MotionValue } from "motion/react"
import { forwardWindow, playSceneSound, soundsBetween, useSoundProximity, type SceneSoundCue, type SceneSoundEvent } from "../sound/sounds"
import { createFlightVoice } from "../sound/flightVoice"
import { flightVoice } from "../sound/recipes"
import { tunnelLegs, tunnelScore } from "./tunnelScore"
import type { Crossing } from "./tunnelFlight"

// The tunnel's track, derived from its score and the measured flights. Per leg: the browser dispatches; one
// voice follows the dot, rising with its speed and going low and muffled inside the relay; the plunge into the
// relay; and the strike on the route, a different note for each of the three so the loop climbs a triad.

export const tunnelSoundCues = (crossings: readonly Crossing[]): readonly SceneSoundCue[] => [
  ...tunnelLegs.flatMap((leg, index) => {
    const crossing = crossings[index]
    return [
      { at: leg.send - .045, event: "dispatch" as const },
      ...(crossing && !crossing.stacked ? [{ at: crossing.enter, event: "plunge" as const }] : []),
      { at: leg.contact, event: `strike${index}` as SceneSoundEvent },
    ]
  }),
].sort((a, b) => a.at - b.at)

const smooth = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t) }

/** The voice at a scene time: speed from the leg's flight, depth ramping in over the plunge and out with the
 * exit; nothing when no dot is flying. */
export function tunnelVoiceAt(elapsed: number, crossings: readonly Crossing[]) {
  if (elapsed < 0) return undefined
  const time = elapsed % tunnelScore.duration
  for (const [index, leg] of tunnelLegs.entries()) {
    if (time < leg.send || time >= leg.contact) continue
    const crossing = crossings[index]
    const speed = crossing?.speedAt(time) ?? 1
    const depth = crossing && !crossing.stacked ? smooth((time - crossing.enter) / .12) * (1 - smooth((time - crossing.leave + .08) / .08)) : 0
    return flightVoice({ speed, depth })
  }
  return undefined
}

/** `elapsed` is the scene's animated time (not the looped clock, which is derived and never reports itself
 * animating). Cues and the voice both fire only on continuous forward motion. */
export function useTunnelSounds(elapsed: MotionValue<number>, host: RefObject<HTMLElement | null>, active: boolean, crossings: readonly Crossing[]) {
  const gain = useSoundProximity(host, active)
  const cues = useMemo(() => tunnelSoundCues(crossings), [crossings])
  const voice = useMemo(() => createFlightVoice(gain), [gain])
  useEffect(() => () => voice.dispose(), [voice])
  useEffect(() => elapsed.on("animationCancel", voice.silence), [elapsed, voice])
  const previous = useRef(elapsed.get())
  useMotionValueEvent(elapsed, "change", now => {
    const before = previous.current
    previous.current = now
    if (!active || !elapsed.isAnimating() || now <= before || now - before > forwardWindow) { voice.silence(); return }
    for (const cue of soundsBetween(cues, tunnelScore.duration, before, now)) playSceneSound(cue.event, gain)
    voice.follow(tunnelVoiceAt(now, crossings))
  })
}
