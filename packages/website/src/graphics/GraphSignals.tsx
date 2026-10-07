import type { ReactNode } from "react"

export function GraphWire({ d }: { d: string }) {
  return <path d={d} fill="none" stroke="#383838" strokeWidth={1} />
}

export function GraphSignals({ glows, children }: { glows?: ReactNode; children: ReactNode }) {
  return <>
    {glows}
    <g>{children}</g>
  </>
}
