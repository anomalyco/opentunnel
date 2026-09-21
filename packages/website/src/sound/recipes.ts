import { travelSoundDefaults, type SoundRecipe, type TravelSoundSettings } from "../sfx"

// The tunnel's own sounds. One pitch centre (the flight voice's 330 Hz) ties them together: the dispatch
// and the strikes are built on it, and the three routes strike a rising triad across the loop.

export const centre = travelSoundDefaults.pitch
const sine = "sine" as const

/** The browser lets go: a low knock, then the note released upward as the light leaves the socket. */
export const dispatch: SoundRecipe = { masterGain: .4, layers: [
  { kind: "tone", waveform: sine, frequency: centre * .5, attack: .004, decay: .035, peak: .03 },
  { kind: "tone", waveform: sine, frequency: centre * .75, glideTo: centre * 1.3, glideTime: .07, offset: .045, attack: .006, decay: .1, peak: .04 },
  { kind: "tone", waveform: sine, frequency: centre * 2, offset: .07, attack: .008, decay: .12, peak: .01 },
] }

/** Into the relay, like a round into water: a low thump that sinks, under a burst of air the water closes over. */
export const plunge: SoundRecipe = { masterGain: .5, layers: [
  { kind: "tone", waveform: sine, frequency: 150, glideTo: 68, glideTime: .16, attack: .004, decay: .22, peak: .07 },
  { kind: "noise", filterType: "lowpass", filterFrequency: 1800, filterTo: 240, filterTime: .14, attack: .006, decay: .16, peak: .05 },
] }

/** The bytes land: a crack, the note struck and settling, and a beat later the app opens them and the note blooms an octave up. */
export const strike = (ratio: number): SoundRecipe => {
  const pitch = centre * ratio
  return { masterGain: .45, layers: [
    { kind: "noise", filterType: "highpass", filterFrequency: 2800, attack: .002, decay: .03, peak: .045 },
    { kind: "tone", waveform: sine, frequency: pitch * 1.1, glideTo: pitch, glideTime: .045, attack: .004, decay: .16, peak: .045 },
    { kind: "tone", waveform: sine, frequency: pitch * .5, attack: .003, decay: .05, peak: .02 },
    { kind: "tone", waveform: sine, frequency: pitch * 2, offset: .1, attack: .025, decay: .5, peak: .02, envelope: "smooth" },
    { kind: "tone", waveform: sine, frequency: pitch * 3, offset: .1, attack: .03, decay: .35, peak: .006 },
  ], shimmer: { delay: .12, feedback: .22, wet: .12, lowpass: 3600 } }
}

/** The three routes, in order: root, major third, fifth. */
export const strikeRatios = [1, 1.25, 1.5] as const

/** What the flight voice hears of the dot: how fast it moves (1 is the mean over the flight) and how deep in the relay it is. */
export type FlightState = { speed: number; depth: number }
const clamp = (x: number) => Math.max(0, Math.min(1, x))

/** The voice at one instant: speed lifts pitch, brightness and air (the rush out of the relay); depth muffles it and brings up a low hum.
 * Speeds on the page run from 0 at the sockets, through ≈1 crawling inside the relay and ≈2 arriving at it, to ≈2.8 leaving it. */
export function flightVoice({ speed, depth }: FlightState): TravelSoundSettings {
  const s = clamp((speed - .6) / 2.2), d = clamp(depth)
  return {
    ...travelSoundDefaults,
    fadeIn: .18, fadeOut: .12,
    volume: travelSoundDefaults.volume * .9 * (.7 + .3 * s) * (1 - .5 * d),
    pitch: centre * (.8 + .45 * s) * (1 - .25 * d),
    cutoff: (700 + 2300 * s) * (1 - .72 * d),
    air: .2 + .35 * s,
    tone: .1 + .15 * d,
    resonance: .25 * d,
  }
}
