// The print's knobs, as shader uniforms. Tuned by hand to this one setting, "Hole": the eye dead centre,
// the sea low, the walls torn.

export type PosterSettings = {
  /** Vanishing point, in the art's height units (0,0 is the centre). */
  eyeX: number; eyeY: number
  /** Ring depth scale (bigger = rings stretch further out), frequency and roll speed. */
  depth: number; ringFrequency: number; ringSpeed: number
  /** How much noise bends the rings, and the torn-cloud contrast along the walls. */
  warp: number; streak: number
  /** Resting ink on the walls and how much the bands add. */
  wallInk: number; bandInk: number
  /** Radius of the paper eye at the vanishing point. */
  eyeGlow: number
  /** The sea: where the shore sits (height units) and how heavy its ink is. */
  seaLevel: number; seaInk: number
  /** Playback speed and dither cell size in CSS pixels. */
  speed: number; cell: number
}

export const posterSettings: PosterSettings = {
  eyeX: 0, eyeY: 0, depth: .33, ringFrequency: 3.5, ringSpeed: 14, warp: 5, streak: 1.6,
  wallInk: .51, bandInk: .57, eyeGlow: .4,
  seaLevel: -.77, seaInk: .8,
  speed: .12, cell: 1,
}
