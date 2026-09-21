import { travelSoundDefaults, type TravelSoundSettings } from "./travelSound"
import type { SoundRecipe, ToneLayer } from "./sounds/recipes"

/** Departure, flight and contact share the sustained voice's pitch and colour. */
export function signalRecipes(settings: TravelSoundSettings = travelSoundDefaults) {
  const pitch = settings.pitch
  const waveform = settings.triangle > .4 ? "triangle" : "sine"
  const harmonic = (offset: number): ToneLayer[] => settings.overtone > 0 ? [
    { kind: "tone", waveform: "sine", frequency: pitch * 2, offset, attack: .008, decay: .12, peak: .025 * settings.overtone },
  ] : []
  return {
    lead: { masterGain: .35, layers: [
      { kind: "tone", waveform, frequency: pitch * .5, attack: .004, decay: .035, peak: .025 },
    ] },
    send: { masterGain: .4, layers: [
      { kind: "tone", waveform, frequency: pitch * .75, glideTo: pitch * 1.3, glideTime: .07, attack: .006, decay: .1, peak: .04 },
      ...harmonic(.025),
    ] },
    contact: { masterGain: .4, layers: [
      { kind: "tone", waveform, frequency: pitch * 1.1, glideTo: pitch, glideTime: .045, attack: .004, decay: .13, peak: .04 },
      { kind: "tone", waveform: "sine", frequency: pitch * .5, attack: .003, decay: .045, peak: .016 },
      ...harmonic(0),
    ] },
    flight: { masterGain: .4, layers: [
      { kind: "noise", filterType: "lowpass", filterFrequency: settings.cutoff, filterQ: .7, attack: settings.fadeIn, decay: settings.fadeOut, peak: .04 * settings.air + .0001 },
      { kind: "tone", waveform, frequency: pitch, attack: settings.fadeIn, decay: settings.fadeOut, peak: .012 * settings.tone + .0001 },
    ] },
  } satisfies Record<string, SoundRecipe>
}
