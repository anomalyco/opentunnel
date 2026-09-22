// The blog's Web Audio engine, insourced (MIT, see LICENSE): every sound is synthesised live on one
// shared AudioContext from a recipe; no audio files.
export { play, renderSound, followLiveGain, getAudioContext, type LiveGain } from "./audio/engine"
export type { SoundRecipe, SoundLayer, ToneLayer, NoiseLayer, Shimmer } from "./sounds/recipes"
export { createTravelSound, travelSoundDefaults, type TravelSoundSettings } from "./travelSound"
