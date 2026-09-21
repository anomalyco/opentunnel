export const soundPreferenceKey = "opentunnel:sfx"
export const soundVolumeKey = "opentunnel:sfx-volume"
type StoragePort = Pick<Storage, "getItem" | "setItem">

/** Durable preference, with a page-local fallback when storage is unavailable. */
export function createSoundPreference(storage: () => StoragePort | undefined = () => typeof window === "undefined" ? undefined : window.localStorage) {
  const read = (fallback = false) => {
    try { const port = storage(); return port ? port.getItem(soundPreferenceKey) === "on" : fallback }
    catch { return fallback }
  }
  let enabled = read()
  const readVolume = (fallback = 1) => {
    try {
      const port = storage()
      if (!port) return fallback
      const value = port.getItem(soundVolumeKey)
      const number = value === null || !value.trim() ? 1 : Number(value)
      return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1
    } catch { return fallback }
  }
  let volume = readVolume()
  const listeners = new Set<() => void>()
  const publish = (next: boolean, level = volume) => {
    if (next === enabled && level === volume) return
    enabled = next
    volume = level
    for (const listener of listeners) listener()
  }
  const set = (next: boolean) => {
    try { storage()?.setItem(soundPreferenceKey, next ? "on" : "off") } catch { /* Keep this page usable without storage. */ }
    publish(next)
    return next
  }
  return {
    get: () => enabled,
    getVolume: () => volume,
    /** Whether the visitor has ever chosen: an unchosen preference may adopt a default on a gesture. */
    decided: () => {
      try { const value = storage()?.getItem(soundPreferenceKey); return value === "on" || value === "off" }
      catch { return false }
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh: () => publish(read(enabled), readVolume(volume)),
    setVolume: (value: number) => {
      if (!Number.isFinite(value)) return
      const next = Math.max(0, Math.min(1, value))
      try { storage()?.setItem(soundVolumeKey, String(next)) } catch { /* Retain the page-local level. */ }
      publish(enabled, next)
    },
    set,
    toggle: () => set(!enabled),
  }
}
