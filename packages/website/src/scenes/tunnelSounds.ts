import { useEffect, useRef, type RefObject } from "react"
import { useMotionValueEvent, type MotionValue } from "motion/react"
import { playSceneSound, soundsBetween, useSoundProximity, useSounds, type SceneSoundCue } from "../sound/sounds"
import { bindSceneTravelSound } from "../sound/travel"
import { pulseGatherMs } from "../graphics/pulseTiming"
import { tunnelLegs, tunnelScore } from "./tunnelScore"
import type { Crossing } from "./TunnelScene"

// The tunnel's track: the browser presses and sends, the dot's voice travels, the relay scans as the
// bytes enter it, and the destination sounds the contact. One cue list, derived from the score.

export const tunnelSoundCues = (crossings: readonly Crossing[]): readonly SceneSoundCue[] => [
  ...tunnelLegs.flatMap((leg, index) => [
    { at: leg.send - .045, event: "sendPress" as const },
    { at: leg.send, event: "send" as const },
    ...(crossings[index] ? [{ at: crossings[index]!.enter, event: "scan" as const }] : []),
    { at: leg.contact, event: "contact" as const },
  ]),
].sort((a, b) => a.at - b.at)

export function tunnelTravelingAt(elapsed: number) {
  const time = elapsed % tunnelScore.duration
  return elapsed >= 0 && tunnelLegs.some(leg => time >= leg.start + pulseGatherMs / 1000 && time < leg.contact)
}

export function useTunnelSounds(clock: MotionValue<number>, host: RefObject<HTMLElement | null>, active: boolean, crossings: readonly Crossing[]) {
  const gain = useSoundProximity(host, active)
  const enabled = useSounds()
  useEffect(() => {
    if (!active || !enabled) return
    return bindSceneTravelSound(clock, gain, tunnelTravelingAt)
  }, [clock, gain, active, enabled])
  const previous = useRef(clock.get())
  useMotionValueEvent(clock, "change", now => {
    const before = previous.current
    previous.current = now
    if (!active || !clock.isAnimating()) return
    for (const cue of soundsBetween(tunnelSoundCues(crossings), tunnelScore.duration, before, now)) playSceneSound(cue.event, active, gain)
  })
}
