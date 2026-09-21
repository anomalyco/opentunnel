import { useLayoutEffect, useMemo, useSyncExternalStore, type RefObject } from "react"
import { cancelFrame, frame, useMotionValue } from "motion/react"
import { getAudioContext, play, type LiveGain, type SoundName, type SoundRecipe } from "../sfx"
import { dispatch, plunge, strike, strikeRatios } from "./recipes"
import { createSoundPreference, soundPreferenceKey, soundVolumeKey } from "./preference"
import { createSoundActivation } from "./activation"
import { soundProximity } from "./proximity"

// The page's sounds, as the blog does them: scenes choose meaning and timing; this palette owns the
// sound and its level. A saved on/off preference (visitors start muted), an AudioContext unlocked by
// a real gesture, and a gain that follows how much of the scene is in view.

type Layer = { sound: SoundName | SoundRecipe; volume: number }
export const soundPalette = {
  select: [{ sound: "release", volume: 2.3 }],
  dispatch: [{ sound: dispatch, volume: .7 }],
  plunge: [{ sound: plunge, volume: .28 }],
  strike0: [{ sound: strike(strikeRatios[0]), volume: .5 }],
  strike1: [{ sound: strike(strikeRatios[1]), volume: .5 }],
  strike2: [{ sound: strike(strikeRatios[2]), volume: .5 }],
} as const satisfies Record<string, readonly Layer[]>
export type SceneSoundEvent = keyof typeof soundPalette
export type SceneSoundCue = { at: number; event: SceneSoundEvent }

const preference = createSoundPreference()
const activation = createSoundActivation(getAudioContext)
let subscribers = 0
const unlock = () => { if (preference.get()) activation.unlock() }
const storageChanged = (event: StorageEvent) => { if (event.key === soundPreferenceKey || event.key === soundVolumeKey || event.key === null) { preference.refresh(); unlock() } }
const subscribe = (listener: () => void) => {
  const stop = preference.subscribe(listener), stopActivation = activation.subscribe(listener)
  if (subscribers++ === 0) {
    window.addEventListener("pointerdown", unlock, { capture: true, passive: true })
    window.addEventListener("keydown", unlock, true)
    window.addEventListener("storage", storageChanged)
    preference.refresh()
    unlock()
  }
  return () => {
    stop(); stopActivation()
    if (--subscribers === 0) {
      window.removeEventListener("pointerdown", unlock, true)
      window.removeEventListener("keydown", unlock, true)
      window.removeEventListener("storage", storageChanged)
    }
  }
}
export const useSounds = () => useSyncExternalStore(subscribe, preference.get, () => false)
export const useSoundReady = () => useSyncExternalStore(subscribe, activation.get, () => false)

/** The explicit gesture: on (and unlocked, with a confirming click) or off. No earlier scene events are replayed. */
export function toggleSounds() {
  if (preference.get() && activation.needsUnlock()) { activation.unlock(); return }
  const enabled = preference.toggle()
  if (enabled) {
    activation.unlock()
    for (const layer of soundPalette.select) play(layer.sound, { volume: layer.volume * preference.getVolume() })
  }
}

export function playSceneSound(event: SceneSoundEvent, active: boolean, gain: LiveGain) {
  if (!preference.get() || !active || document.hidden || gain.get() <= 0) return
  for (const layer of soundPalette[event]) play(layer.sound, { volume: layer.volume, gain, maxDelay: 0 })
}

/** Cues crossed going forward between two clock readings, within one loop; nothing on seeks, jumps or reverse. */
export function soundsBetween(cues: readonly SceneSoundCue[], duration: number, before: number, now: number): SceneSoundCue[] {
  if (now <= before || now - before > .12) return []
  const result: SceneSoundCue[] = []
  for (let cycle = Math.max(0, Math.floor(before / duration)); cycle <= Math.floor(now / duration); cycle++) {
    for (const cue of cues) {
      const at = cycle * duration + cue.at
      if (before < at && at <= now) result.push({ ...cue, at })
    }
  }
  return result
}

/** Gain from how much of the scene is in view, times the saved volume. */
export function useSoundProximity(host: RefObject<HTMLElement | null>, active: boolean): LiveGain {
  const enabled = useSounds()
  const proximity = useMotionValue(0)
  useLayoutEffect(() => {
    const element = host.current
    if (!element || !enabled || !active) { proximity.set(0); return }
    const measure = () => {
      if (document.hidden) { proximity.set(0); return }
      const view = window.visualViewport
      proximity.set(soundProximity(element.getBoundingClientRect(), {
        left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0,
        width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight,
      }))
    }
    const schedule = () => { frame.read(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", schedule)
    document.addEventListener("visibilitychange", measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      document.removeEventListener("visibilitychange", measure)
      cancelFrame(measure)
      proximity.set(0)
    }
  }, [host, active, enabled, proximity])
  return useMemo(() => {
    const get = () => proximity.get() * preference.getVolume()
    return { get, subscribe: (listener: (value: number) => void) => {
      const changed = () => listener(get())
      const stopSource = proximity.on("change", changed), stopVolume = preference.subscribe(changed)
      return () => { stopSource(); stopVolume() }
    } }
  }, [proximity])
}
