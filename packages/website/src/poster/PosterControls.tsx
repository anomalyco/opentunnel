import { useEffect, useState } from "react"
import { posterDefaults, posterKnobs, posterPresets, posterSettings, usePosterSettings, type PosterSettings } from "./posterSettings"
import "./poster-controls.css"

// Development only: a panel of knobs for the poster's print, with Randomize, Reset and
// Copy settings. Press T to toggle it. Copy pastes a `posterDefaults` patch back into chat.

const keys = Object.keys(posterKnobs) as (keyof PosterSettings)[]
const groups = [...new Set(keys.map(key => posterKnobs[key].group))]

export function PosterControls() {
  const settings = usePosterSettings()
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).has("tune"))
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "t" || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "BUTTON"].includes(event.target.tagName)) return
      setOpen(value => !value)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  if (!open) return <button type="button" className="poster-controls-toggle" onClick={() => setOpen(true)} title="Tune the poster (T)">tune poster</button>
  const changed = keys.filter(key => settings[key] !== posterDefaults[key])
  const presets = posterSettings.presets()
  const current = Object.entries(presets).find(([, preset]) => keys.every(key => preset[key] === settings[key]))?.[0]
  const save = () => { const name = window.prompt("Name this print", current ?? "")?.trim(); if (name) posterSettings.save(name) }
  const copy = async () => {
    const patch = Object.fromEntries(changed.map(key => [key, settings[key]]))
    await navigator.clipboard.writeText(`posterDefaults patch:\n${JSON.stringify(patch, null, 2)}`)
    setCopied(true)
  }
  return <aside className="poster-controls" aria-label="Poster settings">
    <header>
      <span>Poster <kbd>T</kbd></span>
      <span className="poster-controls-actions">
        <button type="button" onClick={() => posterSettings.randomize()}>Randomize</button>
        <button type="button" onClick={() => posterSettings.reset()} disabled={!changed.length}>Reset</button>
        <button type="button" onClick={copy} disabled={!changed.length}>{copied ? "Copied" : "Copy settings"}</button>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
      </span>
    </header>
    <section>
      <h3>Prints</h3>
      <div className="poster-controls-presets">
        {Object.keys(presets).map(name => <button key={name} type="button" data-current={current === name || undefined} onClick={() => posterSettings.apply(name)} onDoubleClick={() => { if (!(name in posterPresets) && window.confirm(`Forget "${name}"?`)) posterSettings.forget(name) }}>{name}</button>)}
        <button type="button" onClick={save}>Save…</button>
      </div>
    </section>
    {groups.map(group => <section key={group}>
      <h3>{group}</h3>
      {keys.filter(key => posterKnobs[key].group === group).map(key => {
        const knob = posterKnobs[key], value = settings[key]
        const digits = Math.max(0, -Math.floor(Math.log10(knob.step)))
        return <label key={key} data-changed={value !== posterDefaults[key] ? "" : undefined}>
          <span>{knob.label}<output>{value.toFixed(digits)}</output></span>
          <input type="range" min={knob.min} max={knob.max} step={knob.step} value={value} onChange={event => posterSettings.set({ [key]: event.currentTarget.valueAsNumber })} onDoubleClick={() => posterSettings.set({ [key]: posterDefaults[key] })} />
        </label>
      })}
    </section>)}
  </aside>
}
