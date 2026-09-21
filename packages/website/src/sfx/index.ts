// The blog's Web Audio engine, insourced (MIT, see LICENSE): every sound is synthesised live on one
// shared AudioContext from a recipe; no audio files.
export { play, renderSound, setEnabled, setVolume, getAudioContext, type LiveGain, type PlayOptions } from "./audio/engine"
export { RECIPES, sounds, type SoundName, type SoundRecipe, type SoundLayer, type ToneLayer, type NoiseLayer, type Shimmer } from "./sounds/recipes"
export { createTravelSound, travelFadeAt, travelSoundDefaults, type TravelSoundSettings } from "./travelSound"
export { signalRecipes } from "./signalRecipes"
