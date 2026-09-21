import { useSyncExternalStore } from "react"

// The ring tunnel's settings: a stack of ellipses travelling along an axis forever. One model covers the
// upright wireframe cylinder, a pipe seen end-on (length 0, taper small) and everything leaning between.
// Units are percent of the square the rings are drawn in.

export type RingSettings = {
  /** Rings in view at once. */
  count: number
  /** Horizontal radius of a ring. */
  radius: number
  /** Vertical radius as a share of the horizontal: the tilt of the eye. 1 is a circle seen end-on. */
  squash: number
  /** Distance from the first ring to the last. 0 stacks them concentric. */
  length: number
  /** Scale of the far ring relative to the near one; below 1 the pipe recedes, spacing compresses with it. */
  taper: number
  /** Horizontal drift of the far end. */
  lean: number
  /** Revolutions of the whole stack per second; negative runs the other way. */
  speed: number
  /** Share of the axis over which rings fade in at one end and out at the other. */
  fade: number
  /** A bulge that travels the axis: its depth as a share of the radius, its wavelength in stack lengths, its speed. */
  wave: number
  waves: number
  waveSpeed: number
  /** Line weight, in percent. */
  stroke: number
  /** Which end is near: +1 the bottom, -1 the top (decides which end is bright when tapering). */
  near: number
}

export const ringDefaults: RingSettings = {
  count: 7, radius: 34, squash: .3, length: 56, taper: 1, lean: 0, speed: .12, fade: .22,
  wave: 0, waves: 1, waveSpeed: .4, stroke: .7, near: 1,
}

type Knob = { label: string; min: number; max: number; step: number; group: string }
export const ringKnobs: Record<keyof RingSettings, Knob> = {
  count: { label: "Rings", min: 2, max: 40, step: 1, group: "Stack" },
  radius: { label: "Radius", min: 6, max: 48, step: .5, group: "Stack" },
  squash: { label: "Squash", min: .05, max: 1, step: .01, group: "Stack" },
  length: { label: "Length", min: 0, max: 90, step: .5, group: "Stack" },
  stroke: { label: "Stroke", min: .2, max: 3, step: .05, group: "Stack" },
  taper: { label: "Taper", min: .02, max: 1.6, step: .01, group: "Perspective" },
  lean: { label: "Lean", min: -40, max: 40, step: .5, group: "Perspective" },
  near: { label: "Near end", min: -1, max: 1, step: 2, group: "Perspective" },
  speed: { label: "Speed", min: -1.5, max: 1.5, step: .01, group: "Motion" },
  fade: { label: "Fade", min: 0, max: .5, step: .01, group: "Motion" },
  wave: { label: "Wave", min: 0, max: .6, step: .01, group: "Wave" },
  waves: { label: "Wavelength", min: .25, max: 4, step: .05, group: "Wave" },
  waveSpeed: { label: "Wave speed", min: -2, max: 2, step: .05, group: "Wave" },
}

export const ringPresets: Record<string, RingSettings> = {
  Stack: ringDefaults,
  "Down the pipe": { ...ringDefaults, count: 14, radius: 46, squash: 1, length: 0, taper: .04, speed: -.08, fade: .35, stroke: .6 },
  Leaning: { ...ringDefaults, count: 12, radius: 26, squash: .34, length: 78, taper: .35, lean: 22, speed: .1, fade: .25, stroke: .6 },
  Breathing: { ...ringDefaults, count: 9, squash: .26, wave: .16, waves: 1.2, waveSpeed: .5, speed: .06 },
  Spring: { ...ringDefaults, count: 22, radius: 30, squash: .22, length: 70, fade: .18, stroke: .5, speed: .2 },
  Well: { ...ringDefaults, count: 16, radius: 40, squash: .42, length: 40, taper: .3, near: -1, speed: -.1, fade: .3, stroke: .55 },
}

const storageKey = "opentunnel:rings"
const savedKey = "opentunnel:rings:presets"
const read = <T,>(key: string, fallback: T): T => { try { const raw = localStorage.getItem(key); return raw ? { ...fallback, ...JSON.parse(raw) } : fallback } catch { return fallback } }
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* fine without */ } }

let current: RingSettings = read(storageKey, ringDefaults)
let saved: Record<string, RingSettings> = read(savedKey, {})
const listeners = new Set<() => void>()
const publish = () => { write(storageKey, current); for (const listener of listeners) listener() }
const keys = Object.keys(ringKnobs) as (keyof RingSettings)[]

export const ringSettings = {
  get: () => current,
  set(patch: Partial<RingSettings>) { current = { ...current, ...patch }; publish() },
  reset() { current = ringDefaults; publish() },
  presets: () => ({ ...ringPresets, ...saved }),
  apply(name: string) { const preset = ringSettings.presets()[name]; if (preset) { current = { ...preset }; publish() } },
  save(name: string) { saved = { ...saved, [name]: current }; write(savedKey, saved); publish() },
  forget(name: string) { const { [name]: _, ...rest } = saved; saved = rest; write(savedKey, saved); publish() },
  /** A new stack from the knobs' ranges, kept in the readable region: enough rings, some fade, a modest wave. */
  randomize() {
    const pick = (key: keyof RingSettings, low = ringKnobs[key].min, high = ringKnobs[key].max) => {
      const knob = ringKnobs[key], steps = Math.round((high - low) / knob.step)
      return low + Math.round(Math.random() * steps) * knob.step
    }
    current = {
      count: pick("count", 5, 24), radius: pick("radius", 18, 46), squash: pick("squash", .12, Math.random() < .25 ? 1 : .5),
      length: Math.random() < .2 ? 0 : pick("length", 30, 85), taper: Math.random() < .4 ? 1 : pick("taper", .05, 1.2), lean: Math.random() < .5 ? 0 : pick("lean", -30, 30),
      speed: (Math.random() < .5 ? -1 : 1) * pick("speed", .04, .35), fade: pick("fade", .1, .4),
      wave: Math.random() < .5 ? 0 : pick("wave", .05, .3), waves: pick("waves", .5, 2.5), waveSpeed: pick("waveSpeed", -1, 1),
      stroke: pick("stroke", .4, 1.2), near: Math.random() < .5 ? -1 : 1,
    }
    publish()
  },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  changed: () => keys.filter(key => current[key] !== ringDefaults[key]),
}

export const useRingSettings = () => useSyncExternalStore(ringSettings.subscribe, ringSettings.get, ringSettings.get)
