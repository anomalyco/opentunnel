import { spring } from "motion"
import { useTransform, type MotionValue } from "motion/react"

/**
 * One activity vocabulary for every plugin card, so the same event reads the same
 * way in every diagram:
 *
 * - `dispatch` — the plugin acted and a pulse leaves its port: the name flashes,
 *   the frame flickers from the inset rule outward, and an ember warms the port.
 * - `running` — the plugin is doing sustained work: the plug icon holds bright,
 *   eased at both ends.
 * - `contact` — the destination received the pulse: it floods from the socket
 *   (the receiving frame's own CardGlow; not part of the card).
 */
export const pluginActivity = {
  /** Name ink 170→255, decaying as (1 − t/duration)². */
  flash: { rest: 170, peak: 255, duration: 1.2 },
  /** Inset rule brightens first; the outer border follows a little later and less. */
  frame: { rise: .18, decay: 1.1, outerDelay: .14, inset: { rest: 41, lift: 14 }, outer: { rest: 56, lift: 8 } },
  /** Plug icon #777 → #eee while running. */
  icon: { rest: 119, active: 238 },
  /** CardGlow `role="leaving"` at the port on dispatch. */
  ember: { size: 210, strength: .6 },
} as const

const arrival = spring({ keyframes: [0, 1], visualDuration: .3, bounce: 0 })
const ease = (age: number) => age <= 0 ? 0 : age >= 1.5 ? 1 : arrival.next(age * 1000).value

const pluginFlash = (time: number, at: number) => time < at ? 0 : Math.max(0, 1 - (time - at) / pluginActivity.flash.duration) ** 2
const pluginFrame = (time: number, at: number) => {
  const age = time - at, { rise, decay } = pluginActivity.frame
  return age < 0 ? 0 : age < rise ? Math.sin(age / rise * Math.PI / 2) : Math.max(0, 1 - (age - rise) / decay) ** 2
}
/** Sustained work between `from` and `until`, eased on and off with the shared arrival spring. */
const pluginRunning = (time: number, from: number, until: number) => ease(time - from) * (1 - ease(time - until))

type PluginActivity = {
  /** Scene times at which this plugin's pulses start (gathering). */
  dispatches: readonly number[]
  /** Intervals of sustained work. */
  running?: readonly (readonly [from: number, until: number])[]
  reduced?: boolean
}

const gray = (ink: number) => `rgb(${ink} ${ink} ${ink})`

export function pluginActivityAt(time: number, { dispatches, running = [], reduced = false }: PluginActivity) {
  const flash = reduced ? 0 : Math.max(0, ...dispatches.map(at => pluginFlash(time, at)))
  const frame = reduced ? 0 : Math.max(0, ...dispatches.map(at => pluginFrame(time, at)))
  const outer = reduced ? 0 : Math.max(0, ...dispatches.map(at => pluginFrame(time - pluginActivity.frame.outerDelay, at)))
  const active = Math.max(0, ...running.map(([from, until]) => reduced ? Number(time >= from && time < until) : pluginRunning(time, from, until)))
  return { flash, frame, outer, running: active }
}

function pluginInks(time: number, activity: PluginActivity) {
  const { flash, frame, outer, running } = pluginActivityAt(time, activity)
  const { flash: name, frame: rules, icon } = pluginActivity
  return {
    color: gray(name.rest + Math.round(flash * (name.peak - name.rest))),
    iconColor: gray(Math.round(icon.rest + running * (icon.active - icon.rest))),
    insetColor: gray(rules.inset.rest + frame * rules.inset.lift),
    frameColor: gray(rules.outer.rest + outer * rules.outer.lift),
  }
}

/** Live PluginFile inks from a scene clock: one sample per tick, split four ways. */
export function usePluginActivity(clock: MotionValue<number>, activity: PluginActivity) {
  const inks = useTransform(clock, time => pluginInks(time, activity))
  const color = useTransform(inks, ink => ink.color)
  const iconColor = useTransform(inks, ink => ink.iconColor)
  const insetColor = useTransform(inks, ink => ink.insetColor)
  const frameColor = useTransform(inks, ink => ink.frameColor)
  return { color, iconColor, insetColor, frameColor }
}
