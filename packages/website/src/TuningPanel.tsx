import { useEffect, useState, useSyncExternalStore } from "react"
import type { Tuning } from "./tuning"
import "./scenes/shield-tuner.css"

/** Development only: live sliders for a tuning. R randomizes the unlocked values, T hides the panel; click a label to
 * lock it against randomizing. */
export function TuningPanel<K extends string>({ title, tuning }: { title: string; tuning: Tuning<K> }) {
  const values = useSyncExternalStore(tuning.subscribe, tuning.get)
  const [locked, setLocked] = useState<ReadonlySet<K>>(new Set())
  const [open, setOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest("input, textarea")) return
      if (event.key === "r") tuning.randomize(locked)
      if (event.key === "t") setOpen(open => !open)
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [locked, tuning])
  const toggleLock = (key: K) => setLocked(previous => {
    const next = new Set(previous)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(values, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  if (!open) return <button type="button" className="shield-tuner-tab" onClick={event => { event.stopPropagation(); setOpen(true) }}>{title}</button>
  return <aside className="shield-tuner" onClick={event => event.stopPropagation()}>
    <header>
      <span>{title}</span>
      <button type="button" onClick={() => tuning.randomize(locked)}>randomize</button>
      <button type="button" onClick={copy}>{copied ? "copied" : "copy"}</button>
      <button type="button" onClick={tuning.reset}>reset</button>
      <button type="button" onClick={() => setOpen(false)} aria-label="Hide">×</button>
    </header>
    {tuning.params.map(param => {
      const key = param.key as K, value = values[key]
      return <div key={key} className="shield-tuner-row" data-locked={locked.has(key) || undefined}>
        <button type="button" className="shield-tuner-label" onClick={() => toggleLock(key)} title="Lock against randomize">{param.label}</button>
        <input type="range" min={param.min} max={param.max} step={param.step} value={value} onChange={event => tuning.set(key, Number(event.target.value))} />
        <output>{value.toFixed(param.step < .1 ? 2 : param.step < 1 ? 1 : 0)}</output>
      </div>
    })}
  </aside>
}
