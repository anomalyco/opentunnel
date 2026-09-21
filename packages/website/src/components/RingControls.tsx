import { useEffect, useState } from "react"
import { ringDefaults, ringKnobs, ringPresets, ringSettings, useRingSettings, type RingSettings } from "./ringSettings"
import "../poster/poster-controls.css"

// The ring tunnel's knobs, in the poster panel's clothes: presets, Randomize, Reset and Copy settings.

const keys = Object.keys(ringKnobs) as (keyof RingSettings)[]
const groups = [...new Set(keys.map(key => ringKnobs[key].group))]

export function RingControls() {
  const settings = useRingSettings()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [copied])
  const changed = ringSettings.changed()
  const presets = ringSettings.presets()
  const current = Object.entries(presets).find(([, preset]) => keys.every(key => preset[key] === settings[key]))?.[0]
  const save = () => { const name = window.prompt("Name this stack", current ?? "")?.trim(); if (name) ringSettings.save(name) }
  const copy = async () => {
    const patch = Object.fromEntries(changed.map(key => [key, settings[key]]))
    await navigator.clipboard.writeText(`ringDefaults patch:\n${JSON.stringify(patch, null, 2)}`)
    setCopied(true)
  }
  return <aside className="poster-controls" aria-label="Ring settings">
    <header>
      <span>Rings</span>
      <span className="poster-controls-actions">
        <button type="button" onClick={() => ringSettings.randomize()}>Randomize</button>
        <button type="button" onClick={() => ringSettings.reset()} disabled={!changed.length}>Reset</button>
        <button type="button" onClick={copy} disabled={!changed.length}>{copied ? "Copied" : "Copy settings"}</button>
      </span>
    </header>
    <section>
      <h3>Stacks</h3>
      <div className="poster-controls-presets">
        {Object.keys(presets).map(name => <button key={name} type="button" data-current={current === name || undefined} onClick={() => ringSettings.apply(name)} onDoubleClick={() => { if (!(name in ringPresets) && window.confirm(`Forget "${name}"?`)) ringSettings.forget(name) }}>{name}</button>)}
        <button type="button" onClick={save}>Save…</button>
      </div>
    </section>
    {groups.map(group => <section key={group}>
      <h3>{group}</h3>
      {keys.filter(key => ringKnobs[key].group === group).map(key => {
        const knob = ringKnobs[key], value = settings[key]
        const digits = Math.max(0, -Math.floor(Math.log10(knob.step)))
        return <label key={key} data-changed={value !== ringDefaults[key] ? "" : undefined}>
          <span>{knob.label}<output>{value.toFixed(digits)}</output></span>
          <input type="range" min={knob.min} max={knob.max} step={knob.step} value={value} onChange={event => ringSettings.set({ [key]: event.currentTarget.valueAsNumber })} onDoubleClick={() => ringSettings.set({ [key]: ringDefaults[key] })} />
        </label>
      })}
    </section>)}
  </aside>
}
