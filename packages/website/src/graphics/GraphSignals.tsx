import type { ReactNode } from "react"
import { motion, type MotionValue } from "motion/react"

/** Both ends of a graph wire use the same socket. */
export function GraphPort({ x, y, fill }: { x: number; y: number; fill?: string | MotionValue<string> }) {
  return <g className="graph-dots"><motion.circle cx={x} cy={y} r={3.5} style={{ fill }} /></g>
}

/** Wires share geometry/ink defaults; scenes may quiet long overlapping routes. */
export function GraphWire({ d, id, inactive, stroke = "#383838", width = 1 }: { d: string | MotionValue<string>; id?: string; inactive?: boolean; stroke?: string; width?: number }) {
  return <motion.path id={id} d={d} data-inactive={inactive} fill="none" stroke={stroke} strokeWidth={width} />
}

/** SVG painter order is part of the rig: no socket can cover gathering light. */
export function GraphSignals({ ports, glows, children }: { ports: ReactNode; glows?: ReactNode; children: ReactNode }) {
  return <>
    <g data-graph-ports="">{ports}</g>
    {glows}
    <g className="graph-pulses">{children}</g>
  </>
}
