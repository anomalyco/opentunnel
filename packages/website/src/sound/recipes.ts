import { travelSoundDefaults, type SoundRecipe, type TravelSoundSettings } from "../sfx"

// The tunnel's own sounds. One pitch centre (the flight voice's 330 Hz) ties them together: the dispatch
// and the strikes are built on it, and the three routes strike a rising triad across the loop.

export const centre = travelSoundDefaults.pitch
const sine = "sine" as const

/** The switch: a key released, confirming sound just turned on. */
export const release: SoundRecipe = { masterGain: .4, layers: [
  { kind: "noise", filterType: "bandpass", filterFrequency: 4600, filterQ: 1.8, attack: .001, decay: .016, peak: .12 },
  { kind: "tone", waveform: sine, frequency: 3200, offset: .006, attack: .001, decay: .05, peak: .02 },
] }

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
type FlightState = { speed: number; depth: number }
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

/** The reel's ratchet: a tiny dry click each time a shape passes the centre. */
export const tick: SoundRecipe = { masterGain: .35, layers: [
  { kind: "noise", filterType: "highpass", filterFrequency: 3200, attack: .001, decay: .01, peak: .07 },
  { kind: "tone", waveform: sine, frequency: 2350, attack: .001, decay: .016, peak: .01 },
] }

/** The reel settles: a firmer click and a small bright note, the destination chosen. */
export const pick: SoundRecipe = { masterGain: .4, layers: [
  { kind: "noise", filterType: "bandpass", filterFrequency: 2600, filterQ: 2, attack: .001, decay: .02, peak: .07 },
  { kind: "tone", waveform: sine, frequency: centre * 3, attack: .002, decay: .14, peak: .018 },
  { kind: "tone", waveform: sine, frequency: centre * 1.5, offset: .012, attack: .004, decay: .2, peak: .014 },
] }

// Crackle: a run of short filtered grains, the sound of a signal breaking up. Fixed values, so it is the same every time.
const grains = (count: number, span: number, from: number, to: number, peak: number) => Array.from({ length: count }, (_, i) => {
  const jitter = [.3, -.2, .45, -.4, .1, .35, -.3, .2, -.1, .4, -.35, .15][i % 12]!
  const along = i / Math.max(1, count - 1)
  return { kind: "noise" as const, filterType: "bandpass" as const, filterFrequency: 1700 + 2800 * ((i * .618) % 1), filterQ: 3,
    offset: Math.max(0, along * span + jitter * span / count), attack: .001, decay: .018 + .02 * ((i * .37) % 1), peak: peak * (from + (to - from) * along) }
})

/** Sealed, leaving the browser: the shape breaks into static, a crackle thinning out over the crawl, under a low note sinking away. */
export const seal: SoundRecipe = { masterGain: .4, layers: [
  ...grains(11, .8, 1, .25, .05),
  { kind: "tone", waveform: sine, frequency: centre * .5, glideTo: centre * .36, glideTime: .6, attack: .06, decay: .7, peak: .012 },
] }

/** Opened, entering your machine: static thickening into a crackle that resolves into a clear note. */
export const open: SoundRecipe = { masterGain: .4, layers: [
  ...grains(9, .55, .3, 1, .045),
  { kind: "tone", waveform: sine, frequency: centre * 2, offset: .58, attack: .02, decay: .7, peak: .03, envelope: "smooth" },
  { kind: "tone", waveform: sine, frequency: centre * 3, offset: .6, attack: .03, decay: .45, peak: .008 },
], shimmer: { delay: .11, feedback: .2, wet: .12, lowpass: 3800 } }
