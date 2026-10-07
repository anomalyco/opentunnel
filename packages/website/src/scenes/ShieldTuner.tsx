import { useEffect, useState, useSyncExternalStore } from "react"
import { shieldParams, shieldTuning, type ShieldKey, type ShieldParam } from "./shieldTuning"
import "./shield-tuner.css"

/** Development only: live controls for the shield. R randomizes the unlocked parameters, T hides the panel;
 * click a label to lock it against randomizing. */
export function ShieldTuner() {
  const values = useSyncExternalStore(shieldTuning.subscribe, shieldTuning.get)
  const [locked, setLocked] = useState<ReadonlySet<ShieldKey>>(new Set())
  const [open, setOpen] = useState(true)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest("input, textarea")) return
      if (event.key === "r") shieldTuning.randomize(locked)
      if (event.key === "t") setOpen(open => !open)
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [locked])
  const toggleLock = (key: ShieldKey) => setLocked(previous => {
    const next = new Set(previous)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(values, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  if (!open) return <button type="button" className="shield-tuner-tab" onClick={() => setOpen(true)}>shield</button>
  return <aside className="shield-tuner" onClick={event => event.stopPropagation()}>
    <header>
      <span>shield</span>
      <button type="button" onClick={() => shieldTuning.randomize(locked)}>randomize</button>
      <button type="button" onClick={copy}>{copied ? "copied" : "copy"}</button>
      <button type="button" onClick={shieldTuning.reset}>reset</button>
      <button type="button" onClick={() => setOpen(false)} aria-label="Hide">×</button>
    </header>
    {(shieldParams as readonly ShieldParam[]).map(param => {
      const key = param.key as ShieldKey, value = values[key]
      return <div key={key} className="shield-tuner-row" data-locked={locked.has(key) || undefined}>
        <button type="button" className="shield-tuner-label" onClick={() => toggleLock(key)} title="Lock against randomize">{param.label}</button>
        {param.options
          ? <div className="shield-tuner-options">{param.options.map((option, index) =>
            <button type="button" key={option} aria-pressed={value === index} onClick={() => shieldTuning.set(key, index)}>{option}</button>)}</div>
          : <>
            <input type="range" min={param.min} max={param.max} step={param.step} value={value} onChange={event => shieldTuning.set(key, Number(event.target.value))} />
            <output>{value.toFixed(param.step < .01 ? 3 : 2)}</output>
          </>}
      </div>
    })}
  </aside>
}
