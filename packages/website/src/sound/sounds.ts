import { useLayoutEffect, useMemo, useSyncExternalStore, type RefObject } from "react"
import { cancelFrame, frame, useMotionValue } from "motion/react"
import { getAudioContext, play, type LiveGain, type SoundRecipe } from "../sfx"
import { dispatch, plunge, release, strike, strikeRatios } from "./recipes"
import { createSoundPreference, soundPreferenceKey } from "./preference"
import { createSoundActivation } from "./activation"
import { soundProximity } from "./proximity"

// The page's sounds, as the blog does them: scenes choose meaning and timing; this palette owns the
// sound and its level. A saved on/off preference (visitors start muted), an AudioContext unlocked by
// a real gesture, and a gain that follows how much of the scene is in view.

type Layer = { sound: SoundRecipe; volume: number }
export const soundPalette = {
  select: [{ sound: release, volume: 2.3 }],
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
// For a returning visitor with sound on, the first gesture's pointerdown resumes the context; if that
// gesture is the click on the diagram, the click must count as the unlock and not as a switch off.
let unlocking = false, unlockingUntil: ReturnType<typeof setTimeout> | undefined
const unlock = () => {
  if (!preference.get()) return
  if (activation.needsUnlock()) {
    unlocking = true
    clearTimeout(unlockingUntil)
    unlockingUntil = setTimeout(() => { unlocking = false }, 600)
  }
  activation.unlock()
}
const storageChanged = (event: StorageEvent) => { if (event.key === soundPreferenceKey || event.key === null) { preference.refresh(); unlock() } }
let subscribers = 0
const subscribe = (listener: () => void) => {
  const stop = preference.subscribe(listener), stopActivation = activation.subscribe(listener)
  if (subscribers++ === 0) {
    window.addEventListener("pointerdown", unlock, { capture: true, passive: true })
    window.addEventListener("keydown", unlock, true)
    window.addEventListener("storage", storageChanged)
    // Where the browser allows it, a returning visitor's context runs before any gesture.
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
  if (preference.get() && (unlocking || activation.needsUnlock())) { unlocking = false; activation.unlock(); return }
  if (preference.toggle()) {
    activation.unlock()
    for (const layer of soundPalette.select) play(layer.sound, { volume: layer.volume })
  }
}

export function playSceneSound(event: SceneSoundEvent, gain: LiveGain) {
  if (gain.get() <= 0) return
  for (const layer of soundPalette[event]) play(layer.sound, { volume: layer.volume, gain, maxDelay: 0 })
}

/** The longest gap between two clock readings that still counts as continuous playback, in seconds. */
export const forwardWindow = .12

/** Cues crossed going forward between two clock readings, within one loop; nothing on seeks, jumps or reverse. */
export function soundsBetween(cues: readonly SceneSoundCue[], duration: number, before: number, now: number): SceneSoundCue[] {
  if (now <= before || now - before > forwardWindow) return []
  const result: SceneSoundCue[] = []
  for (let cycle = Math.max(0, Math.floor(before / duration)); cycle <= Math.floor(now / duration); cycle++) {
    for (const cue of cues) {
      const at = cycle * duration + cue.at
      if (before < at && at <= now) result.push({ ...cue, at })
    }
  }
  return result
}

/** Gain from how much of the scene is in view: zero when sound is off, the scene inactive or the tab hidden. */
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
  return useMemo(() => ({ get: () => proximity.get(), subscribe: (listener: (value: number) => void) => proximity.on("change", listener) }), [proximity])
}
