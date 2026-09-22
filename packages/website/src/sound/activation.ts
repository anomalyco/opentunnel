type AudioPort = Pick<AudioContext, "state" | "resume" | "addEventListener" | "removeEventListener">

/** Browser permission is transient; the saved preference is deliberately separate. */
export function createSoundActivation(context: () => AudioPort | null) {
  let audio: AudioPort | null = null
  let running = false
  const listeners = new Set<() => void>()
  const changed = () => {
    const next = audio?.state === "running"
    if (next === running) return
    running = next
    for (const listener of listeners) listener()
  }
  const current = () => {
    const next = context()
    if (next !== audio) {
      audio?.removeEventListener("statechange", changed)
      audio = next
      audio?.addEventListener("statechange", changed)
    }
    changed()
    return audio
  }
  return {
    get: () => running,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    unlock: () => {
      const audio = current()
      if (!audio || audio.state === "running" || audio.state === "closed") return
      // A suspended context cannot resume before this visit's first gesture; the
      // browser only logs a warning. The gesture listeners retry when one arrives.
      if (typeof navigator !== "undefined" && navigator.userActivation && !navigator.userActivation.hasBeenActive) { changed(); return }
      try { void audio.resume().then(changed, changed) } catch { changed() }
    },
    needsUnlock: () => current()?.state !== "running",
  }
}
