import { createTravelSound, followLiveGain, getAudioContext, type LiveGain, type TravelSoundSettings } from "../sfx"

/** One sustained voice that follows the dot: `follow` retunes it each frame (or lets it go when nothing is
 * flying); `silence` cuts it. Live gain on its entire tail. The rig is only built once the page's gesture has
 * the context running. */
export function createFlightVoice(gain: LiveGain) {
  let rig: { bus: GainNode; voice: ReturnType<typeof createTravelSound>; stopGain: () => void } | undefined
  let last: TravelSoundSettings | undefined
  const silence = () => { last = undefined; rig?.voice.silence() }
  return {
    follow(next: TravelSoundSettings | undefined) {
      if (!next) {
        if (last) rig?.voice.set(false, last)
        last = undefined
        return
      }
      if (!rig) {
        const context = getAudioContext()
        if (!context || context.state !== "running" || gain.get() <= 0) return
        const bus = context.createGain()
        bus.gain.value = gain.get()
        bus.connect(context.destination)
        rig = { bus, voice: createTravelSound(context, bus), stopGain: followLiveGain(bus, gain, silence) }
      }
      last = next
      rig.voice.set(true, next)
    },
    silence,
    dispose() { silence(); rig?.stopGain(); rig?.voice.dispose(); rig?.bus.disconnect(); rig = undefined },
  }
}
