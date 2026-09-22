/**
 * The audio engine — synthesizes each sound live via the Web Audio API
 * on one shared, lazily created `AudioContext`. No audio files, no
 * dependencies. Every sound carries a gentle envelope (and often a soft
 * shimmer tail) instead of a hard transient, so nothing feels harsh.
 */

import type { NoiseLayer, Shimmer, SoundRecipe, ToneLayer } from "../sounds/recipes.js";
import { smoothEnvelope } from "./envelope.js";

const SOURCE_STOP_PADDING = 0.05;
const CLEANUP_MARGIN = 0.05;
const INAUDIBLE_GAIN = 0.001;
const OUTPUT_GAIN = 4;

function renderTone(
  context: BaseAudioContext,
  destination: AudioNode,
  layer: ToneLayer,
  startTime: number,
): void {
  const oscillator = context.createOscillator();
  oscillator.type = layer.waveform;
  oscillator.frequency.setValueAtTime(layer.frequency, startTime);
  if (layer.detune) oscillator.detune.value = layer.detune;

  if (layer.glideTo !== undefined) {
    const glideTime = layer.glideTime ?? layer.attack + layer.decay;
    oscillator.frequency.exponentialRampToValueAtTime(layer.glideTo, startTime + glideTime);
  }

  const gain = context.createGain();
  if (layer.envelope === "smooth") {
    gain.gain.setValueCurveAtTime(smoothEnvelope(layer.attack, layer.decay, layer.peak), startTime, layer.attack + layer.decay);
  } else {
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay);
  }

  oscillator.connect(gain).connect(destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + layer.attack + layer.decay + SOURCE_STOP_PADDING);
}

function renderNoise(
  context: BaseAudioContext,
  destination: AudioNode,
  layer: NoiseLayer,
  startTime: number,
): void {
  const duration = layer.attack + layer.decay + SOURCE_STOP_PADDING;
  const length = Math.max(1, Math.floor(duration * context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = 2 * Math.random() - 1;

  const source = context.createBufferSource();
  source.buffer = buffer;

  const filter = context.createBiquadFilter();
  filter.type = layer.filterType;
  filter.frequency.value = layer.filterFrequency;
  if (layer.filterQ !== undefined) filter.Q.value = layer.filterQ;
  if (layer.filterTo !== undefined) {
    filter.frequency.setValueAtTime(layer.filterFrequency, startTime);
    filter.frequency.exponentialRampToValueAtTime(layer.filterTo, startTime + (layer.filterTime ?? layer.attack));
  }

  const gain = context.createGain();
  if (layer.envelope === "smooth") {
    gain.gain.setValueCurveAtTime(smoothEnvelope(layer.attack, layer.decay, layer.peak), startTime, layer.attack + layer.decay);
  } else {
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(layer.peak, startTime + layer.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + layer.attack + layer.decay);
  }

  source.connect(filter).connect(gain).connect(destination);
  source.start(startTime);
  source.stop(startTime + duration);
}

/** Wires a soft echo/shimmer send off `source`, feeding back into `destination`. */
function attachShimmer(
  context: BaseAudioContext,
  source: AudioNode,
  destination: AudioNode,
  shimmer: Shimmer,
): AudioNode[] {
  const delay = context.createDelay(1);
  delay.delayTime.value = shimmer.delay;

  const feedbackFilter = context.createBiquadFilter();
  feedbackFilter.type = "lowpass";
  feedbackFilter.frequency.value = shimmer.lowpass;

  const feedbackGain = context.createGain();
  feedbackGain.gain.value = shimmer.feedback;

  const wetGain = context.createGain();
  wetGain.gain.value = shimmer.wet;

  source.connect(delay);
  delay.connect(feedbackFilter);
  feedbackFilter.connect(feedbackGain);
  feedbackGain.connect(delay);
  feedbackFilter.connect(wetGain);
  wetGain.connect(destination);

  return [delay, feedbackFilter, feedbackGain, wetGain];
}

function sourceEnd(recipe: SoundRecipe): number {
  return Math.max(
    ...recipe.layers.map(
      (layer) => (layer.offset ?? 0) + layer.attack + layer.decay + SOURCE_STOP_PADDING,
    ),
  );
}

function shimmerTail(shimmer?: Shimmer): number {
  if (!shimmer || shimmer.feedback <= 0) return 0;
  if (shimmer.feedback >= 1) return shimmer.delay;

  return shimmer.delay * (1 + Math.ceil(Math.log(INAUDIBLE_GAIN) / Math.log(shimmer.feedback)));
}

// One output/limiter chain per context: the shared page context, or a caller-owned render context.
const outputs = new WeakMap<BaseAudioContext, GainNode>();

function getOutput(context: BaseAudioContext): GainNode {
  const existing = outputs.get(context);
  if (existing) return existing;

  const output = context.createGain();
  output.gain.value = OUTPUT_GAIN;

  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;

  output.connect(limiter).connect(context.destination);
  outputs.set(context, output);
  return output;
}

export type LiveGain = {
  get(): number;
  subscribe(listener: (value: number) => void): () => void;
};

export type PlayOptions = {
  /** Linear gain on the recipe; may exceed 1 for quiet recipes. Live gain stays within 0–1. */
  volume?: number;
  gain?: LiveGain;
  /** Maximum unlock delay in milliseconds. Zero drops suspended scene cues. */
  maxDelay?: number;
};

function renderRecipe(context: BaseAudioContext, recipe: SoundRecipe, volume: number, gainControl?: LiveGain): void {
  const level = normalizeVolume(gainControl?.get(), 1);
  if (level === 0 || recipe.layers.length === 0) return;
  const now = context.currentTime;
  const output = getOutput(context);
  // The dry sound and its echo tail share this per-play live level.
  const bus = gainControl ? context.createGain() : output;
  let unsubscribe: (() => void) | undefined;
  if (gainControl) {
    bus.gain.value = level;
    bus.connect(output);
    unsubscribe = followLiveGain(bus, gainControl);
  }
  const master = context.createGain();
  master.gain.value = recipe.masterGain * volume;
  master.connect(bus);

  const shimmerNodes = recipe.shimmer
    ? attachShimmer(context, master, bus, recipe.shimmer)
    : [];

  for (const layer of recipe.layers) {
    const startTime = now + (layer.offset ?? 0);
    if (layer.kind === "tone") renderTone(context, master, layer, startTime);
    else renderNoise(context, master, layer, startTime);
  }

  const cleanupAfterMs = (sourceEnd(recipe) + shimmerTail(recipe.shimmer) + CLEANUP_MARGIN) * 1000;
  setTimeout(() => {
    unsubscribe?.();
    master.disconnect();
    for (const node of shimmerNodes) node.disconnect();
    if (gainControl) bus.disconnect();
  }, cleanupAfterMs);
}

/** A gain node's level follows a live gain: smoothly, except straight to silence. */
export function followLiveGain(node: GainNode, gain: LiveGain, onSilent?: () => void): () => void {
  return gain.subscribe(value => {
    const next = normalizeVolume(value, 0);
    const time = node.context.currentTime;
    node.gain.cancelAndHoldAtTime(time);
    if (next === 0) {
      node.gain.setValueAtTime(0, time);
      onSilent?.();
    } else node.gain.setTargetAtTime(next, time, 0.025);
  });
}

/**
 * Synthesizes a sound on a caller-owned context through the same output and
 * limiter chain `play` uses, starting at the context's current time. Offline
 * rendering and measurement use this.
 */
export function renderSound(context: BaseAudioContext, recipe: SoundRecipe, options?: Pick<PlayOptions, "volume" | "gain">): void {
  renderRecipe(context, recipe, normalizeLevel(options?.volume, 1), options?.gain);
}

let sharedContext: AudioContext | null = null;

function normalizeVolume(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

/** Per-play level: a linear gain on the recipe. Above 1 lifts quiet recipes; the output limiter still bounds peaks. */
function normalizeLevel(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/** Shared one-shot context; callers still own gesture unlock and sustained voices. */
export function getAudioContext(): AudioContext | null {
  if (sharedContext) return sharedContext;
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
  } catch {
    return null;
  }
  return sharedContext;
}

/**
 * Plays a sound immediately. Safe to call from anywhere — lazily creates
 * the shared `AudioContext` on first use, resumes it if the browser
 * started it suspended (e.g. before any user gesture), and is a no-op
 * when Web Audio is unavailable (SSR, old browsers).
 */
export function play(recipe: SoundRecipe, options?: PlayOptions): void {
  const playVolume = normalizeLevel(options?.volume, 1);
  if (playVolume === 0) return;

  const context = getAudioContext();
  if (!context) return;

  if (context.state === "running") {
    renderRecipe(context, recipe, playVolume, options?.gain);
  } else {
    // A browser may permit a running context before this visit's first gesture.
    // Only blocked contexts need the activation guard; scene callers drop backlog.
    if (typeof navigator !== "undefined" && navigator.userActivation?.hasBeenActive === false) return;
    const requestedAt = performance.now();
    const maxDelay = options?.maxDelay ?? 120;
    try {
      void context.resume().then(
        () => {
          if (maxDelay <= 0 || performance.now() - requestedAt > maxDelay) return;
          if (context.state === "running") renderRecipe(context, recipe, playVolume, options?.gain);
        },
        () => {},
      );
    } catch {
      // Some browsers throw synchronously when audio is blocked.
    }
  }
}
