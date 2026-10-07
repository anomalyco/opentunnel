// A small live-tuning store: a flat record of numbers, each with a range, a tasteful random range and a default.
// Development tunes it through TuningPanel (persisted in localStorage); production reads the defaults.

export type TuningParam = {
  key: string; label: string; min: number; max: number; step: number; value: number
  /** Narrower range used by "randomize", so random picks stay sensible. */
  random?: readonly [number, number]
}

export type Tuning<K extends string> = {
  params: readonly TuningParam[]
  get: () => Record<K, number>
  subscribe: (listener: () => void) => () => void
  set: (key: K, value: number) => void
  reset: () => void
  randomize: (locked: ReadonlySet<K>) => void
}

export function createTuning<const P extends readonly TuningParam[]>(storage: string, params: P): Tuning<P[number]["key"]> {
  type K = P[number]["key"]
  const defaults = Object.fromEntries(params.map(p => [p.key, p.value])) as Record<K, number>
  const snap = (param: TuningParam, value: number) => Math.min(param.max, Math.max(param.min, Math.round(value / param.step) * param.step))
  const load = (): Record<K, number> => {
    if (!import.meta.env.DEV || typeof localStorage === "undefined") return { ...defaults }
    try {
      const saved = JSON.parse(localStorage.getItem(storage) ?? "{}") as Record<string, unknown>
      return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => key in defaults && typeof value === "number")) }
    } catch { return { ...defaults } }
  }
  let values = load()
  const listeners = new Set<() => void>()
  const changed = (next: Record<K, number>) => {
    values = next
    if (import.meta.env.DEV) localStorage.setItem(storage, JSON.stringify(values))
    for (const listener of listeners) listener()
  }
  return {
    params,
    get: () => values,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (key, value) => changed({ ...values, [key]: snap(params.find(p => p.key === key)!, value) }),
    reset: () => changed({ ...defaults }),
    randomize: locked => {
      const next = { ...values }
      for (const param of params) {
        if (locked.has(param.key as K)) continue
        const [low, high] = param.random ?? [param.min, param.max]
        next[param.key as K] = snap(param, low + Math.random() * (high - low))
      }
      changed(next)
    },
  }
}
