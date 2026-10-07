import { useEffect, useMemo, useRef, type RefObject } from "react"
import { useMotionValueEvent, type MotionValue } from "motion/react"
import { forwardWindow, playSceneSound, soundsBetween, useSoundProximity, type SceneSoundCue, type SceneSoundEvent } from "../sound/sounds"
import { createFlightVoice } from "../sound/flightVoice"
import { flightVoice } from "../sound/recipes"
import { tunnelLegs, tunnelScore } from "./tunnelScore"
import type { Crossing } from "./tunnelFlight"
import { choosing, reelTicks } from "./Cipher"

// The tunnel's track, derived from its score and the measured flights. Per leg: the browser dispatches; one
// voice follows the dot, rising with its speed and going low and muffled inside the relay; the plunge into the
// relay; and the strike on the route, a different note for each of the three destinations.

export const tunnelSoundCues = (crossings: readonly Crossing[]): readonly SceneSoundCue[] => [
  ...tunnelLegs.flatMap((leg, index) => {
    const crossing = crossings[index]
    return [
      // The browser chooses: the reel ratchets, settles; the chosen shape breaks up as it leaves; it is opened at your machine.
      ...reelTicks(leg.send).map(at => ({ at, event: "tick" as const })),
      { at: leg.send - choosing.slide - choosing.rest, event: "pick" as const },
      { at: leg.send - choosing.slide * .36, event: "seal" as const },
      ...(crossing ? [{ at: crossing.gate.start + (crossing.gate.end - crossing.gate.start) * .15, event: "open" as const }] : []),
      { at: leg.send - .045, event: "dispatch" as const },
      ...(crossing ? [{ at: crossing.enter, event: "plunge" as const }] : []),
      { at: leg.contact, event: `strike${leg.route}` as SceneSoundEvent },
    ]
  }),
// The first request chooses across the loop's wrap: cues before zero belong at the end of the loop.
].map(cue => ({ ...cue, at: ((cue.at % tunnelScore.duration) + tunnelScore.duration) % tunnelScore.duration })).sort((a, b) => a.at - b.at)

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
    const depth = crossing ? smooth((time - crossing.enter) / .12) * (1 - smooth((time - crossing.leave + .08) / .08)) : 0
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
