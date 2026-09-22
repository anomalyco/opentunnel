/** Finite authoring-time relationships between the moments of a scene; Motion owns playback. Ported from the
 * OpenCode blog's sceneTiming, reduced to clips, holds, placement and one compile. */
const node = Symbol("scene clip"), reference = Symbol("scene moment")
const momentType = Symbol("moment type")
type Numbers = { readonly [key: string]: number | Numbers }
type Bound<M> = { readonly [K in keyof M]: M[K] extends number ? Moment : Bound<M[K]> }
type ReadonlyMoments<M> = { readonly [K in keyof M]: M[K] extends number ? number : ReadonlyMoments<M[K]> }
export type Moment = { readonly [reference]: { owner: Placement; path: readonly string[]; offset: number } }
type Prepared = { duration: number; moments: Numbers }
type Node = { kind: "clip"; prepared: Prepared } | { kind: "parallel"; entries: readonly (readonly [string, Placement])[] }
type Clip<M extends object> = { readonly [node]: Node; readonly [momentType]?: M }
type Placement = { source: Clip<object>; start: number | Moment }
type Occurrence<M extends object> = { readonly placement: Placement; readonly moments: Bound<M> }
type MarksOf<O> = O extends Occurrence<infer M> ? M : never
const reserved = new Set(["start", "end", "__proto__", "constructor", "prototype"])
function names(keys: string[]) {
  for (const key of keys) if (!key || reserved.has(key)) throw new Error(`Reserved or empty scene name: ${key}`)
}
function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}
function nonnegative(value: number, label: string) {
  if (finite(value, label) < 0) throw new Error(`${label} must be nonnegative`)
  return value
}
const make = <M extends object>(value: Node): Clip<M> => Object.freeze({ [node]: Object.freeze(value) })

export function clip<const M extends Record<string, number>>(input: { duration: number; moments: M }): Clip<Readonly<M> & { start: number; end: number }> {
  const duration = nonnegative(input.duration, "Clip duration")
  names(Object.keys(input.moments))
  for (const [name, time] of Object.entries(input.moments)) if (nonnegative(time, name) > duration) throw new Error(`${name} is outside its clip`)
  return make({ kind: "clip", prepared: Object.freeze({ duration, moments: Object.freeze({ ...input.moments, start: 0, end: duration }) }) })
}
/** A pacing interval with no rig of its own. */
export const hold = (duration: number) => clip({ duration, moments: {} })

/** Shared pauses between steps. */
export const scenePace = {
  /** Hold a finished result to be read before moving on. */
  read: 1,
} as const
/** Moment paths stay symbolic until compilation; only statically known keys are public. */
function moments(owner: Placement, path: readonly string[] = []): object {
  return new Proxy(Object.freeze({ [reference]: Object.freeze({ owner, path, offset: 0 }) }), {
    get(target, key) { return typeof key === "symbol" ? Reflect.get(target, key) : moments(owner, Object.freeze([...path, key])) },
  })
}
export function at<M extends object>(start: number | Moment, source: Clip<M>): Occurrence<M> {
  if (typeof start === "number") nonnegative(start, "Placement start")
  const placement = Object.freeze({ source, start })
  return Object.freeze({ placement, moments: moments(placement) as Bound<M> })
}
export function after(moment: Moment, seconds: number): Moment {
  return Object.freeze({ [reference]: Object.freeze({ ...moment[reference], offset: moment[reference].offset + finite(seconds, "Offset") }) })
}
export function parallel<const O extends Record<string, Occurrence<object>>>(parts: O): Clip<{ readonly [K in keyof O]: MarksOf<O[K]> } & { start: number; end: number }> {
  names(Object.keys(parts))
  const entries = Object.entries(parts).map(([name, part]) => Object.freeze([name, part.placement] as const))
  if (new Set(entries.map(([, owner]) => owner)).size !== entries.length) throw new Error("Use at() twice for two occurrences")
  return make({ kind: "parallel", entries: Object.freeze(entries) })
}

/** Compile a closed composition once. Foreign references, cycles and invalid durations fail here. */
export function compile<M extends object>(source: Clip<M>): { duration: number; moments: ReadonlyMoments<M> } {
  const constructing = new Set<Clip<object>>()
  function build(source: Clip<object>, path: string): Prepared {
    if (constructing.has(source)) throw new Error(`Cyclic clip construction at ${path}`)
    const current = source[node]
    if (current.kind === "clip") return current.prepared
    constructing.add(source)
    try { return group(current.entries, path) } finally { constructing.delete(source) }
  }
  function group(entries: readonly (readonly [string, Placement])[], path: string): Prepared {
    const members = new Map(entries.map(([name, owner]) => [owner, name]))
    const starts = new Map<Placement, number>(), prepared = new Map<Placement, Prepared>()
    const starting = new Set<Placement>(), preparing = new Set<Placement>()
    function member(owner: Placement) {
      const name = members.get(owner)
      if (name === undefined) throw new Error("Foreign moment: occurrence is outside this parallel composition")
      return name
    }
    function prepare(owner: Placement): Prepared {
      const name = member(owner), existing = prepared.get(owner)
      if (existing) return existing
      if (preparing.has(owner)) throw new Error(`Preparation cycle at ${name}`)
      preparing.add(owner)
      const result = build(owner.source, path ? `${path}.${name}` : name)
      prepared.set(owner, result); preparing.delete(owner); return result
    }
    function start(owner: Placement): number {
      const name = member(owner), existing = starts.get(owner)
      if (existing !== undefined) return existing
      if (starting.has(owner)) throw new Error(`Timing cycle at ${name}`)
      starting.add(owner)
      const result = nonnegative(typeof owner.start === "number" ? owner.start : resolve(owner.start), `${name}.start`)
      starts.set(owner, result); starting.delete(owner); return result
    }
    function resolve(moment: Moment): number {
      const ref = moment[reference]
      const at = start(ref.owner)
      let value: number | Numbers = ref.path.length === 1 && ref.path[0] === "start" ? 0 : prepare(ref.owner).moments
      if (typeof value !== "number") for (const key of ref.path) {
        if (typeof value === "number" || !Object.hasOwn(value, key)) throw new Error(`Unknown moment ${ref.path.join(".")}`)
        value = value[key]
      }
      if (typeof value !== "number") throw new Error("Expected a moment, not a moment group")
      return nonnegative(at + value + ref.offset, "Resolved moment")
    }
    const shift = (tree: Numbers, offset: number): Numbers => Object.freeze(Object.fromEntries(Object.entries(tree)
      .map(([key, value]) => [key, typeof value === "number" ? finite(value + offset, key) : shift(value, offset)])))
    let duration = 0
    const marks: [string, Numbers][] = []
    for (const [name, owner] of entries) {
      const at = start(owner), result = prepare(owner)
      duration = Math.max(duration, finite(at + result.duration, `${name}.end`))
      marks.push([name, shift(result.moments, at)])
    }
    return { duration, moments: Object.freeze({ ...Object.fromEntries(marks), start: 0, end: duration }) }
  }
  if (source[node].kind !== "parallel") throw new Error("Compile a parallel composition")
  const { duration, moments } = group(source[node].entries, "")
  return Object.freeze({ duration, moments: moments as ReadonlyMoments<M> })
}
