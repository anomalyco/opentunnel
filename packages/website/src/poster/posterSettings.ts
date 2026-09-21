import { useSyncExternalStore } from "react"

// Every knob of the poster's print, as shader uniforms. The overlay edits these;
// the canvas uploads them each frame. Ranges are the knob's travel and what
// Randomize draws from.

export type PosterSettings = {
  /** Vanishing point, in the art's height units (0,0 is the centre). */
  eyeX: number; eyeY: number
  /** Ring depth scale (bigger = rings stretch further out), frequency and roll speed. */
  depth: number; ringFrequency: number; ringSpeed: number
  /** How much noise bends the rings, and the torn-cloud contrast along the walls. */
  warp: number; streak: number
  /** Resting ink on the walls, how much the bands add, darkening with distance. */
  wallInk: number; bandInk: number; distanceInk: number
  /** Radius of the paper eye at the vanishing point. */
  eyeGlow: number
  /** The sphere: 0 radius removes it. */
  sphereX: number; sphereY: number; sphereRadius: number; sphereHalo: number
  /** The sea: where the shore sits (height units) and how heavy its ink is. */
  seaLevel: number; seaInk: number
  /** Playback speed and dither cell size in CSS pixels. */
  speed: number; cell: number
}

type Knob = { label: string; min: number; max: number; step: number; group: string }
export const posterKnobs: Record<keyof PosterSettings, Knob> = {
  eyeX: { label: "Eye x", min: -.6, max: .6, step: .01, group: "Tunnel" },
  eyeY: { label: "Eye y", min: -.6, max: .7, step: .01, group: "Tunnel" },
  depth: { label: "Depth", min: .1, max: .8, step: .01, group: "Tunnel" },
  ringFrequency: { label: "Ring frequency", min: 1, max: 12, step: .1, group: "Tunnel" },
  ringSpeed: { label: "Ring speed", min: 0, max: 14, step: .1, group: "Tunnel" },
  warp: { label: "Warp", min: 0, max: 5, step: .05, group: "Tunnel" },
  streak: { label: "Streak", min: 0, max: 1.6, step: .02, group: "Tunnel" },
  wallInk: { label: "Wall ink", min: 0, max: .8, step: .01, group: "Ink" },
  bandInk: { label: "Band ink", min: 0, max: 1, step: .01, group: "Ink" },
  distanceInk: { label: "Distance ink", min: 0, max: .8, step: .01, group: "Ink" },
  eyeGlow: { label: "Eye glow", min: 0, max: .4, step: .005, group: "Ink" },
  sphereX: { label: "Sphere x", min: -.6, max: .6, step: .01, group: "Sphere" },
  sphereY: { label: "Sphere y", min: -.7, max: .6, step: .01, group: "Sphere" },
  sphereRadius: { label: "Sphere radius", min: 0, max: .5, step: .005, group: "Sphere" },
  sphereHalo: { label: "Sphere halo", min: 0, max: .3, step: .005, group: "Sphere" },
  seaLevel: { label: "Sea level", min: -.9, max: .3, step: .01, group: "Sea" },
  seaInk: { label: "Sea ink", min: 0, max: 1, step: .01, group: "Sea" },
  speed: { label: "Speed", min: 0, max: .5, step: .005, group: "Print" },
  cell: { label: "Dither cell", min: 1, max: 4, step: 1, group: "Print" },
}

export const posterDefaults: PosterSettings = {
  eyeX: -.28, eyeY: .38, depth: .39, ringFrequency: 8.4, ringSpeed: 7.4, warp: 2.35, streak: .72,
  wallInk: .4, bandInk: .96, distanceInk: .72, eyeGlow: .16,
  sphereX: -.31, sphereY: -.33, sphereRadius: 0, sphereHalo: 0,
  seaLevel: -.64, seaInk: .3,
  speed: .12, cell: 1,
}

let settings: PosterSettings = { ...posterDefaults }
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

export const posterSettings = {
  get: () => settings,
  set(patch: Partial<PosterSettings>) { settings = { ...settings, ...patch }; emit() },
  reset() { settings = { ...posterDefaults }; emit() },
  /** A fresh print: every knob somewhere in its travel, the sphere present two times in three. */
  randomize() {
    const draw = (knob: Knob) => { const value = knob.min + Math.random() * (knob.max - knob.min); return Math.round(value / knob.step) * knob.step }
    const next = Object.fromEntries((Object.keys(posterKnobs) as (keyof PosterSettings)[]).map(key => [key, draw(posterKnobs[key])])) as PosterSettings
    next.speed = posterDefaults.speed
    next.cell = Math.random() < .7 ? 1 : 2
    if (Math.random() < .33) next.sphereRadius = 0
    settings = next; emit()
  },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
}

export const usePosterSettings = () => useSyncExternalStore(posterSettings.subscribe, posterSettings.get, posterSettings.get)
