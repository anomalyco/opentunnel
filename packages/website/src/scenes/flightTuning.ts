import { createTuning } from "../tuning"

/** The shape story's timings and easings, live-tunable in development (TuningPanel); the defaults ship. The flight's
 * defaults are the original diagram's (cubic in-out, a thick relay and a rush out of it) with gentle slowdowns at the borders. */
export const flightTuning = createTuning("opentunnel:flight-tuning", [
  // The browser choosing: the reel's spin, a rest on the choice, the slide out through the browser's border.
  { key: "spin", label: "spin", min: .5, max: 2.4, step: .05, value: 1.55, random: [.8, 1.9] },
  { key: "slots", label: "reel slots", min: 4, max: 18, step: 1, value: 12, random: [6, 15] },
  { key: "overshoot", label: "overshoot", min: 0, max: 2, step: .05, value: 1.1, random: [0, 1.2] },
  { key: "rest", label: "rest", min: 0, max: .8, step: .05, value: .1, random: [.1, .5] },
  { key: "slide", label: "slide", min: .3, max: 1.8, step: .05, value: .65, random: [.5, 1.3] },
  { key: "slideCarry", label: "slide carry", min: 0, max: 1, step: .05, value: .3, random: [.2, .8] },
  // The flight: overall ease (0 cubic in-out, 1 even pace), the relay's thickness and the rush out of it.
  { key: "pace", label: "even pace", min: 0, max: 1, step: .05, value: 0, random: [.3, .9] },
  { key: "drag", label: "relay drag", min: 1, max: 6, step: .1, value: 5, random: [1.3, 4] },
  { key: "rush", label: "relay rush", min: 0, max: 1.2, step: .05, value: .9, random: [0, .6] },
  // Each border: how much the bytes slow (0 not at all, 1 a stop) and how far either side, in pixels.
  { key: "exitDepth", label: "exit slow", min: 0, max: .95, step: .05, value: .25, random: [.25, .8] },
  { key: "exitReach", label: "exit reach", min: 4, max: 40, step: 1, value: 15, random: [8, 28] },
  { key: "gateDepth", label: "gate slow", min: 0, max: .95, step: .05, value: .85, random: [.3, .85] },
  { key: "gateReach", label: "gate reach", min: 6, max: 60, step: 1, value: 33, random: [12, 42] },
] as const)
