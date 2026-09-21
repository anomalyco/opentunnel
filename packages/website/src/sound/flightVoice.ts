import type { MotionValue } from "motion/react"
import { createTravelSound, getAudioContext, type LiveGain, type TravelSoundSettings } from "../sfx"

/** One sustained voice follows the dot, retuned every frame from the scene's state; live gain on its entire tail.
 * `voiceAt` returns the voice's settings while something is flying and nothing otherwise. */
export function bindFlightVoice(clock: MotionValue<number>, gain: LiveGain, voiceAt: (elapsed: number) => TravelSoundSettings | undefined, contextFor = getAudioContext) {
  let previous = clock.get()
  let rig: { context: AudioContext; bus: GainNode; voice: ReturnType<typeof createTravelSound> } | undefined
  let last: TravelSoundSettings | undefined
  const silence = () => { last = undefined; rig?.voice.silence() }
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
    const next = voiceAt(now)
    if (!next) {
      if (last) rig?.voice.set(false, last)
      last = undefined
      return
    }
    if (!rig) {
      const context = contextFor()
      // The page's explicit gesture unlocks this same context.
      if (!context || context.state !== "running") return
      const bus = context.createGain()
      bus.gain.value = gain.get()
      bus.connect(context.destination)
      rig = { context, bus, voice: createTravelSound(context, bus) }
    }
    last = next
    rig.voice.set(true, next)
  })
  const stopCancel = clock.on("animationCancel", silence)
  return () => {
    stopClock(); stopCancel(); stopGain()
    rig?.voice.dispose()
    rig?.bus.disconnect()
  }
}
