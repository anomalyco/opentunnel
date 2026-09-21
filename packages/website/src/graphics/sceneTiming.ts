/** Finite authoring-time relationships. Motion and the prepared rigs own playback. */
const node = Symbol("scene clip"), reference = Symbol("scene moment"), interval = Symbol("scene interval")
const valueType = Symbol("prepared type"), momentType = Symbol("moment type")
type Numbers = { readonly [key: string]: number | Numbers }
type Bound<M> = { readonly [K in keyof M]: M[K] extends number ? Moment : Bound<M[K]> }
type ReadonlyMoments<M> = { readonly [K in keyof M]: M[K] extends number ? number : ReadonlyMoments<M[K]> }
export type Moment = { readonly [reference]: { owner: Placement; path: readonly string[]; offset: number } }
type Duration = { readonly [interval]: { start: Moment; end: Moment } }
type Input = number | Moment | Duration
type Lane = { readonly path: string; readonly start: number; readonly end: number; readonly because: string }
type Prepared = { duration: number; moments: Numbers; value: unknown; lanes?: readonly Lane[] }
type Node = { kind: "clip"; prepared: Prepared }
  | { kind: "deferred"; inputs: Readonly<Record<string, Input>>; prepare: (values: Record<string, number>) => AnyClip }
  | { kind: "parallel"; entries: readonly (readonly [string, Placement])[] }
export type Clip<V, M extends object> = { readonly [node]: Node; readonly [valueType]?: V; readonly [momentType]?: M }
type AnyClip = Clip<unknown, object>
type Placement = { source: AnyClip; start: number | Moment }
export type Occurrence<V, M extends object> = { readonly placement: Placement; readonly moments: Bound<M> }
type AnyOccurrence = Occurrence<unknown, object>
type ValueOf<O> = O extends Occurrence<infer V, object> ? V : never
type MarksOf<O> = O extends Occurrence<unknown, infer M> ? M : never
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
function make<V, M extends object>(value: Node): Clip<V, M> { return Object.freeze({ [node]: Object.freeze(value) }) }

/** The value may be an existing sampler. Never clone/freeze its private Motion caches. */
export function clip<V, const M extends Record<string, number>>(input: { duration: number; moments: M; value: V }): Clip<V, Readonly<M> & { start: number; end: number }> {
  const duration = nonnegative(input.duration, "Clip duration")
  names(Object.keys(input.moments))
  for (const [name, time] of Object.entries(input.moments)) if (nonnegative(time, name) > duration) throw new Error(`${name} is outside its clip`)
  return make({ kind: "clip", prepared: Object.freeze({ duration, value: input.value,
    moments: Object.freeze({ ...input.moments, start: 0, end: duration }) }) })
}
/** A pacing interval with no rig of its own. */
export const hold = (duration: number) => clip({ duration, moments: {}, value: undefined })

/** Shared pauses between steps, so no diagram has a stretch where nothing happens. */
export const scenePace = {
  /** An automatic consequence follows its cause (a notification, a plugin reacting to one). */
  react: .3,
  /** The next action after a contact whose effect is quick (a roll, a toggle). */
  step: .8,
  /** The next action after rows or a list have entered. */
  settle: 1.2,
  /** Hold a finished result to be read before annotating or moving on. */
  read: 1,
} as const
/** Moment paths stay symbolic until preparation; only statically known keys are public. */
function moments(owner: Placement, path: readonly string[] = []): object {
  return new Proxy(Object.freeze({ [reference]: Object.freeze({ owner, path, offset: 0 }) }), {
    get(target, key) { return typeof key === "symbol" ? Reflect.get(target, key) : moments(owner, Object.freeze([...path, key])) },
  })
}
export function at<V, M extends object>(start: number | Moment, source: Clip<V, M>): Occurrence<V, M> {
  if (typeof start === "number") nonnegative(start, "Placement start")
  const placement = Object.freeze({ source, start })
  return Object.freeze({ placement, moments: moments(placement) as Bound<M> })
}
export function after(moment: Moment, seconds: number): Moment {
  return Object.freeze({ [reference]: Object.freeze({ ...moment[reference], offset: moment[reference].offset + finite(seconds, "Offset") }) })
}
export function between(start: Moment, end: Moment): Duration { return Object.freeze({ [interval]: Object.freeze({ start, end }) }) }
export function defer<const I extends Record<string, Input>, V, M extends object>(inputs: I, prepare: (values: { readonly [K in keyof I]: number }) => Clip<V, M>): Clip<V, M> {
  return make({ kind: "deferred", inputs: Object.freeze({ ...inputs }), prepare: prepare as (values: Record<string, number>) => AnyClip })
}
export function parallel<const O extends Record<string, AnyOccurrence>>(parts: O): Clip<
  { readonly [K in keyof O]: ValueOf<O[K]> }, { readonly [K in keyof O]: MarksOf<O[K]> } & { start: number; end: number }
> {
  names(Object.keys(parts))
  const entries = Object.entries(parts).map(([name, part]) => Object.freeze([name, part.placement] as const))
  if (new Set(entries.map(([, owner]) => owner)).size !== entries.length) throw new Error("Use at() twice for two occurrences")
  return make({ kind: "parallel", entries: Object.freeze(entries) })
}
export const cue = <E extends string>(moment: Moment, event: E) => Object.freeze({ moment, event })
export const span = (start: Moment, end: Moment, label: string) => Object.freeze({ start, end, label })
export const stop = (moment: Moment, label: string) => Object.freeze({ moment, label })

/** Compile a closed product once. Foreign references, cycles and invalid durations fail here. */
export function compile<V, M extends object, E extends string = never>(source: Clip<V, M>, metadata: {
  unit?: "seconds" | "milliseconds"
  cues?: readonly { moment: Moment; event: E }[]
  spans?: readonly ReturnType<typeof span>[]
  stops?: readonly ReturnType<typeof stop>[]
} = {}) {
  const unit = metadata.unit ?? "seconds", suffix = unit === "seconds" ? "s" : "ms"
  const constructing = new Set<AnyClip>()
  function build(source: AnyClip, resolve?: (moment: Moment) => number, path = ""): Prepared {
    if (constructing.has(source)) throw new Error(`Cyclic clip construction at ${path}`)
    const current = source[node]
    if (current.kind === "clip") return current.prepared
    constructing.add(source)
    try {
      if (current.kind === "parallel") return group(current.entries, path).prepared
      if (!resolve) throw new Error("Deferred clips need a containing parallel composition")
      const values = Object.fromEntries(Object.entries(current.inputs).map(([key, input]) => [key,
        typeof input === "number" ? finite(input, key) : interval in input
          ? nonnegative(resolve(input[interval].end) - resolve(input[interval].start), key) : resolve(input)]))
      return build(current.prepare(Object.freeze(values)), resolve, path)
    } finally { constructing.delete(source) }
  }
  function group(entries: readonly (readonly [string, Placement])[], path: string) {
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
      const result = build(owner.source, resolve, path ? `${path}.${name}` : name)
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
      const ref = moment[reference]; member(ref.owner)
      const at = start(ref.owner)
      // A deferred rig may depend on its own start without depending on its own preparation.
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
    const lanes: Lane[] = []
    const values: [string, unknown][] = [], marks: [string, Numbers][] = []
    for (const [name, owner] of entries) {
      const at = start(owner), result = prepare(owner), end = finite(at + result.duration, `${name}.end`)
      duration = Math.max(duration, end); values.push([name, result.value]); marks.push([name, shift(result.moments, at)])
      const ref = typeof owner.start === "number" ? undefined : owner.start[reference]
      lanes.push(Object.freeze({ path: name, start: at, end,
        because: ref ? `${member(ref.owner)}.${ref.path.join(".")} + ${ref.offset}${suffix}` : `at ${at}${suffix}` }))
      lanes.push(...(result.lanes ?? []).map(lane => Object.freeze({ ...lane, path: `${name}.${lane.path}`, start: lane.start + at, end: lane.end + at })))
    }
    const describeMoment = (moment: Moment) => {
      const ref = moment[reference]
      return `${member(ref.owner)}.${ref.path.join(".")}${ref.offset ? ` + ${ref.offset}${suffix}` : ""}`
    }
    return { prepared: { duration, value: Object.freeze(Object.fromEntries(values)), lanes: Object.freeze(lanes),
      moments: Object.freeze({ ...Object.fromEntries(marks), start: 0, end: duration }) }, resolve, describeMoment }
  }
  if (source[node].kind !== "parallel") throw new Error("Compile a parallel composition")
  const { prepared, resolve, describeMoment } = group(source[node].entries, "")
  const bounded = (moment: Moment) => {
    const time = resolve(moment)
    if (time > prepared.duration) throw new Error("Metadata is outside the composition")
    return time
  }
  const cues = Object.freeze((metadata.cues ?? []).map(({ moment, event }, index) => Object.freeze({ at: bounded(moment), event, id: `cue:${index}`, from: describeMoment(moment) })).sort((a, b) => a.at - b.at))
  const spans = Object.freeze((metadata.spans ?? []).map(({ start, end, label }) => {
    const from = bounded(start), until = bounded(end)
    if (until < from) throw new Error("Span ends before it starts")
    return Object.freeze({ start: from, end: until, label })
  }))
  const stops = Object.freeze((metadata.stops ?? []).map(({ moment, label }) => Object.freeze({ at: bounded(moment), label })))
  const description = Object.freeze({ unit, duration: prepared.duration, moments: prepared.moments, lanes: prepared.lanes, cues, spans, stops })
  return Object.freeze({ duration: prepared.duration, moments: prepared.moments as ReadonlyMoments<M>, values: prepared.value as V, cues, spans, stops,
    describe: () => description })
}
