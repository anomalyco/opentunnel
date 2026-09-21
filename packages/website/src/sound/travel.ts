import { createTravelSound, getAudioContext, type LiveGain, type TravelSoundSettings } from "../sfx"
import type { MotionValue } from "motion/react"

/** One sustained voice follows forward transport, with live gain on its entire tail. */
export function bindSceneTravelSound(clock: MotionValue<number>, gain: LiveGain, travelingAt: (elapsed: number) => boolean,
  contextFor = getAudioContext, settings?: TravelSoundSettings) {
  let previous = clock.get()
  let rig: { context: AudioContext; bus: GainNode; voice: ReturnType<typeof createTravelSound> } | undefined
  let traveling = false
  const silence = () => { traveling = false; rig?.voice.silence() }
  const stopGain = gain.subscribe(value => {
    if (!rig) return
    const now = rig.context.currentTime
    rig.bus.gain.cancelAndHoldAtTime(now)
    if (value <= 0) {
      rig.bus.gain.setValueAtTime(0, now)
      silence()
    } else rig.bus.gain.setTargetAtTime(value, now, .025)
  })
  const stopClock = clock.on("change", now => {
    const delta = now - previous
    previous = now
    if (!clock.isAnimating() || delta <= 0 || delta > .12 || gain.get() <= 0 || document.hidden) { silence(); return }
    const next = travelingAt(now)
    if (next === traveling) return
    if (next && !rig) {
      const context = contextFor()
      // The page's explicit speaker gesture unlocks this same context.
      if (!context || context.state !== "running") return
      const bus = context.createGain()
      bus.gain.value = gain.get()
      bus.connect(context.destination)
      rig = { context, bus, voice: createTravelSound(context, bus) }
    }
    traveling = next
    rig?.voice.set(next, settings)
  })
  const stopCancel = clock.on("animationCancel", silence)
  return () => {
    stopClock(); stopCancel(); stopGain()
    rig?.voice.dispose()
    rig?.bus.disconnect()
  }
}
