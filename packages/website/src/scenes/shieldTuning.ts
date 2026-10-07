// The shield's tunable look: one flat record of numbers the shader reads every frame. Development tunes it live
// through the ShieldTuner panel (persisted in localStorage); the defaults are what ships.

export type ShieldParam = {
  key: string; label: string; min: number; max: number; step: number; value: number
  /** Narrower range used by "randomize", so random picks stay tasteful. */
  random?: readonly [number, number]
  options?: readonly string[]
}

export const shieldParams = [
  { key: "pattern", label: "pattern", min: 0, max: 3, step: 1, value: 1, options: ["none", "hex", "triangles", "grid"] },
  { key: "cell", label: "cell size", min: .08, max: .4, step: .01, value: .16, random: [.11, .26] },
  { key: "lineWidth", label: "line", min: .01, max: .12, step: .005, value: .035, random: [.02, .06] },
  { key: "padX", label: "reach x", min: .1, max: 1.2, step: .01, value: .5, random: [.3, .8] },
  { key: "height", label: "reach y", min: .8, max: 2.2, step: .01, value: 1.35, random: [1.05, 1.7] },
  { key: "depth", label: "depth", min: .3, max: 2, step: .01, value: 1, random: [.6, 1.5] },
  { key: "fresnelPower", label: "fresnel", min: .5, max: 6, step: .1, value: 2.6, random: [1.4, 4] },
  { key: "presence", label: "presence", min: 0, max: 1, step: .01, value: .32, random: [.15, .55] },
  { key: "drift", label: "drift", min: 0, max: 1.5, step: .01, value: .35, random: [.12, .8] },
  { key: "glints", label: "glints", min: 0, max: 1, step: .01, value: .38, random: [.1, .7] },
  { key: "rim", label: "rim", min: 0, max: 1, step: .01, value: .28, random: [.1, .55] },
  { key: "backFace", label: "back face", min: 0, max: 1, step: .01, value: .38, random: [.1, .65] },
  { key: "spin", label: "spin", min: -.4, max: .4, step: .005, value: .035, random: [-.1, .1] },
  { key: "reveal", label: "reveal size", min: .1, max: 1, step: .01, value: .34, random: [.2, .55] },
  { key: "linger", label: "linger", min: .1, max: 2, step: .01, value: .6, random: [.35, 1.1] },
  { key: "dissolve", label: "dissolve", min: 0, max: 1, step: .01, value: .72, random: [.35, .95] },
  { key: "flicker", label: "flicker", min: 0, max: 1, step: .01, value: .45, random: [.15, .8] },
  { key: "lens", label: "refract", min: 0, max: 1, step: .01, value: .45, random: [.15, .8] },
  { key: "debrisRate", label: "debris", min: 0, max: 2.5, step: .05, value: .45, random: [.25, 1.0] },
  { key: "debrisSpeed", label: "debris speed", min: .4, max: 4, step: .05, value: 1.55, random: [.9, 2.5] },
  { key: "trail", label: "trail", min: 0, max: .4, step: .005, value: .15, random: [.06, .24] },
  { key: "impact", label: "impact", min: 0, max: 2, step: .01, value: 1, random: [.6, 1.4] },
  { key: "rippleSpeed", label: "ripple speed", min: .3, max: 4, step: .05, value: 1.4, random: [.8, 2.4] },
  { key: "strike", label: "strike", min: 0, max: 2, step: .01, value: 1, random: [.6, 1.4] },
  { key: "plasma", label: "plasma", min: 0, max: 1.5, step: .01, value: .05, random: [0, .45] },
  { key: "dither", label: "dither", min: 0, max: 1, step: .01, value: .25, random: [0, .65] },
] as const satisfies readonly ShieldParam[]

export type ShieldKey = (typeof shieldParams)[number]["key"]
export type ShieldValues = Record<ShieldKey, number>

const STORAGE = "opentunnel:shield-tuning"
const defaults = Object.fromEntries(shieldParams.map(p => [p.key, p.value])) as ShieldValues
const clamp = (param: ShieldParam, value: number) => Math.min(param.max, Math.max(param.min, Math.round(value / param.step) * param.step))

function load(): ShieldValues {
  if (!import.meta.env.DEV) return { ...defaults }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}") as Partial<ShieldValues>
    return { ...defaults, ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => key in defaults && typeof value === "number")) }
  } catch { return { ...defaults } }
}

let values = load()
const listeners = new Set<() => void>()
const changed = (next: ShieldValues) => {
  values = next
  if (import.meta.env.DEV) localStorage.setItem(STORAGE, JSON.stringify(values))
  for (const listener of listeners) listener()
}

export const shieldTuning = {
  get: () => values,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  set: (key: ShieldKey, value: number) => changed({ ...values, [key]: clamp(shieldParams.find(p => p.key === key)!, value) }),
  assign: (next: Partial<ShieldValues>) => changed({ ...values, ...next }),
  reset: () => changed({ ...defaults }),
  randomize: (locked: ReadonlySet<ShieldKey>) => {
    const next = { ...values }
    for (const param of shieldParams as readonly ShieldParam[]) {
      if (locked.has(param.key as ShieldKey)) continue
      const [low, high] = param.random ?? [param.min, param.max]
      next[param.key as ShieldKey] = param.options ? Math.floor(Math.random() * param.options.length) : clamp(param, low + Math.random() * (high - low))
    }
    changed(next)
  },
}
