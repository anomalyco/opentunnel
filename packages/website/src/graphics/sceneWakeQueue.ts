import { frame } from "motion"

/** Camera travel holds visibility/hydration work; newest intent wins per owner.
 * Ordinary scrolling stays immediate. Settled work drains once per Motion frame. */
export function createSceneWakeQueue(schedule: (run: () => void) => void) {
  const pending = new Map<object, () => void>()
  let held = false, scheduled = false
  const drain = () => {
    scheduled = false
    if (held) return
    const first = pending.entries().next().value
    if (first) { pending.delete(first[0]); first[1]() }
    request()
  }
  const request = () => {
    if (held || scheduled || !pending.size) return
    scheduled = true
    schedule(drain)
  }
  return {
    hold(value: boolean) { held = value; if (!held) request() },
    defer(key: object, run: () => void) {
      if (!held && !pending.size && !scheduled) { run(); return }
      pending.set(key, run)
      request()
    },
    cancel(key: object) { pending.delete(key) },
  }
}

export const sceneWakeQueue = createSceneWakeQueue(run => { frame.postRender(run) })
