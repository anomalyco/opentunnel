export const soundPreferenceKey = "opentunnel:sfx"
type StoragePort = Pick<Storage, "getItem" | "setItem">

/** Durable on/off preference, with a page-local fallback when storage is unavailable. Visitors start off. */
export function createSoundPreference(storage: () => StoragePort | undefined = () => typeof window === "undefined" ? undefined : window.localStorage) {
  const read = () => {
    try { return storage()?.getItem(soundPreferenceKey) === "on" }
    catch { return false }
  }
  let enabled = read()
  const listeners = new Set<() => void>()
  const publish = (next: boolean) => {
    if (next === enabled) return
    enabled = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => enabled,
    toggle() {
      const next = !enabled
      try { storage()?.setItem(soundPreferenceKey, next ? "on" : "off") } catch { /* Keep this page usable without storage. */ }
      publish(next)
      return next
    },
    /** Another tab changed the stored preference. */
    refresh: () => publish(read()),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
