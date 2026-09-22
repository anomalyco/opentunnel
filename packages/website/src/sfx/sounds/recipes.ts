/**
 * The recipe types. A sound is layers of tones and filtered noise under one master gain, optionally with
 * a soft echo tail; the page's own recipes live in src/sound/recipes.ts.
 */

type BaseLayer = {
  /** Seconds after the trigger that this layer starts. */
  offset?: number;
  /** Fade-in time, in seconds. */
  attack: number;
  /** Fade-out time, in seconds, starting right after the attack. */
  decay: number;
  /** Peak volume reached at the end of the attack. */
  peak: number;
  /** Broad cosine swell instead of the default short exponential attack/decay. */
  envelope?: "smooth";
};

/** A single note — the building block for chimes, arpeggios, and pads. */
export type ToneLayer = BaseLayer & {
  kind: "tone";
  waveform: OscillatorType;
  frequency: number;
  /** Detune in cents, for a gentle chorus/beating effect between layers. */
  detune?: number;
  /** If set, the pitch glides smoothly from `frequency` to this value. */
  glideTo?: number;
  /** How long the glide takes, in seconds. Defaults to attack + decay. */
  glideTime?: number;
};

/** A soft filtered noise bed — used for breathy, textural layers. */
export type NoiseLayer = BaseLayer & {
  kind: "noise";
  filterType: BiquadFilterType;
  filterFrequency: number;
  filterQ?: number;
  /** Optional continuous cutoff sweep, in Hz and seconds. */
  filterTo?: number;
  filterTime?: number;
};

export type SoundLayer = ToneLayer | NoiseLayer;

/** A soft, spacious echo tail applied to the whole sound — the "magic dust". */
export type Shimmer = {
  delay: number;
  feedback: number;
  wet: number;
  lowpass: number;
};

export type SoundRecipe = {
  masterGain: number;
  layers: readonly SoundLayer[];
  shimmer?: Shimmer;
};
