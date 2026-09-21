/** Sustained counterpart to the brief whisper recipe. */
export const travelSoundDefaults = { volume: 1.702, fadeIn: .22, fadeOut: .32, pitch: 330, cutoff: 1000, air: .25, tone: .1, triangle: 0, overtone: 0, resonance: 0 }
export type TravelSoundSettings = typeof travelSoundDefaults

type Fade = { from: number; to: number; at: number; duration: number }
export function travelFadeAt(fade: Fade, time: number) {
  const t = Math.max(0, Math.min(1, (time - fade.at) / fade.duration))
  return fade.from + (fade.to - fade.from) * (.5 - .5 * Math.cos(Math.PI * t))
}

/** Audio owns the fade clock. Releasing and re-grabbing retains the audible level. */
export function createTravelSound(context: BaseAudioContext, destination: AudioNode = context.destination) {
  let voice: ReturnType<typeof makeVoice> | undefined
  let cleanup: ReturnType<typeof setTimeout> | undefined
  let fade: Fade = { from: 0, to: 0, at: 0, duration: .01 }
  const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
  const samples = noise.getChannelData(0)
  let seed = 1979
  for (let i = 0; i < samples.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; samples[i] = seed / 2147483648 }
  function makeVoice(settings: TravelSoundSettings) {
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), air = context.createGain()
    source.buffer = noise; source.loop = true
    filter.type = "lowpass"; filter.frequency.value = Math.max(80, Math.min(context.sampleRate / 2, settings.cutoff)); filter.Q.value = .7 + settings.resonance * 4
    air.gain.value = Math.max(0, Math.min(1, settings.air)) * .04
    const tone = context.createOscillator(), body = context.createGain()
    tone.type = "sine"; tone.frequency.value = Math.max(40, Math.min(4000, settings.pitch)); body.gain.value = Math.max(0, Math.min(1, settings.tone)) * .012
    const triangle = context.createOscillator(), harmonic = context.createOscillator()
    triangle.type = "triangle"; triangle.frequency.value = tone.frequency.value
    harmonic.type = "sine"; harmonic.frequency.value = tone.frequency.value * 2
    const round = context.createGain(), edge = context.createGain(), overtone = context.createGain(), toneFilter = context.createBiquadFilter()
    round.gain.value = 1 - settings.triangle; edge.gain.value = settings.triangle * .6; overtone.gain.value = settings.overtone * .5
    toneFilter.type = "lowpass"; toneFilter.frequency.value = Math.min(4800, tone.frequency.value * 3); toneFilter.Q.value = .7
    const envelope = context.createGain(), level = context.createGain()
    envelope.gain.value = 0; level.gain.value = 0
    source.connect(filter).connect(air).connect(envelope)
    tone.connect(round).connect(body)
    triangle.connect(edge).connect(body)
    harmonic.connect(overtone).connect(body)
    body.connect(toneFilter).connect(envelope)
    envelope.connect(level).connect(destination)
    source.start(); tone.start(); triangle.start(); harmonic.start()
    return { source, tone, triangle, harmonic, round, edge, overtone, toneFilter, filter, air, body, envelope, level }
  }
  const silence = () => {
    clearTimeout(cleanup); cleanup = undefined
    if (voice) {
      voice.envelope.gain.cancelScheduledValues(context.currentTime)
      voice.envelope.gain.setValueAtTime(0, context.currentTime)
      voice.source.stop(); voice.tone.stop(); voice.triangle.stop(); voice.harmonic.stop()
      for (const node of Object.values(voice)) node.disconnect()
      voice = undefined
    }
    fade = { from: 0, to: 0, at: context.currentTime, duration: .01 }
  }
  return {
    set(active: boolean, settings: TravelSoundSettings = travelSoundDefaults) {
      if (!voice && !active) return
      voice ??= makeVoice(settings)
      // Retune the retained sources without restarting their phase or envelope.
      const now = context.currentTime
      const pitch = Math.max(40, Math.min(4000, settings.pitch))
      voice.tone.frequency.setTargetAtTime(pitch, now, .04)
      voice.triangle.frequency.setTargetAtTime(pitch, now, .04)
      voice.harmonic.frequency.setTargetAtTime(pitch * 2, now, .04)
      voice.round.gain.setTargetAtTime(1 - settings.triangle, now, .04)
      voice.edge.gain.setTargetAtTime(settings.triangle * .6, now, .04)
      voice.overtone.gain.setTargetAtTime(settings.overtone * .5, now, .04)
      voice.toneFilter.frequency.setTargetAtTime(Math.min(4800, pitch * 3), now, .04)
      voice.filter.frequency.setTargetAtTime(Math.max(80, Math.min(context.sampleRate / 2, settings.cutoff)), now, .04)
      voice.filter.Q.setTargetAtTime(.7 + settings.resonance * 4, now, .04)
      voice.air.gain.setTargetAtTime(Math.max(0, Math.min(1, settings.air)) * .04, now, .025)
      voice.body.gain.setTargetAtTime(Math.max(0, Math.min(1, settings.tone)) * .012, now, .025)
      // Match the quiet whisper recipe's master/output scale, not a full-level tone.
      voice.level.gain.setTargetAtTime(Math.max(0, settings.volume) * 1.92, context.currentTime, .025)
      const to = active ? 1 : 0
      if (fade.to === to) return
      clearTimeout(cleanup)
      const from = travelFadeAt(fade, now)
      fade = { from, to, at: now, duration: Math.max(.01, active ? settings.fadeIn : settings.fadeOut) }
      const curve = Float32Array.from({ length: 65 }, (_, i) => travelFadeAt(fade, now + fade.duration * i / 64))
      voice.envelope.gain.cancelAndHoldAtTime(now)
      voice.envelope.gain.setValueAtTime(from, now)
      voice.envelope.gain.setValueCurveAtTime(curve, now, fade.duration)
      if (!active) cleanup = setTimeout(silence, fade.duration * 1000 + 30)
    },
    silence,
    dispose: silence,
  }
}
