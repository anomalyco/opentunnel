import type { ReactNode } from "react"

/** Both ends of a graph wire use the same socket. */
export function GraphPort({ x, y }: { x: number; y: number }) {
  return <g className="graph-dots"><circle cx={x} cy={y} r={3.5} /></g>
}

export function GraphWire({ d }: { d: string }) {
  return <path d={d} fill="none" stroke="#383838" strokeWidth={1} />
}

/** SVG painter order is part of the rig: no socket can cover gathering light. */
export function GraphSignals({ ports, glows, children }: { ports: ReactNode; glows?: ReactNode; children: ReactNode }) {
  return <>
    <g>{ports}</g>
    {glows}
    <g>{children}</g>
  </>
}
