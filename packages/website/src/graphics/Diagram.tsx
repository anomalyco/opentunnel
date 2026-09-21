import type { ComponentPropsWithRef, ReactNode } from "react"
import { motion, type HTMLMotionProps, type MotionValue } from "motion/react"
import "./diagram.css"

// The blog's shipped diagram anatomy (src/graphics/ui/DiagramFrame, DiagramHeader,
// PluginFile), transcribed from StyleX to plain CSS with the Clear neutral inks.

export const diagramInk = {
  text: "#ccc", muted: "#858585", quiet: "#8c8983", number: "#aaa",
  icon: "#777", rule: "#292929", border: "#383838", header: "#131313", surface: "#ffffff02",
  socket: "#5a5a5a", wire: "#444",
} as const

export function DiagramFrame({ as: Element = "div", fill = "soft", className = "", ...props }: ComponentPropsWithRef<"div"> & { as?: "div" | "section"; fill?: "soft" | "plain" }) {
  return <Element {...props} className={`diagram-frame ${className}`} data-fill={fill} />
}

export function DiagramHeader({ as: Element = "div", trailing, divider = "below", className = "", children, ...props }: ComponentPropsWithRef<"div"> & { as?: "div" | "h3"; trailing?: ReactNode; divider?: "below" | "above" | "none" }) {
  return <Element {...props} data-diagram-header="" data-divider={divider} className={`diagram-header ${className}`}>{children}{trailing}</Element>
}

/** Small line icons on a 16-unit grid, drawn like PluginFile's plug. */
export const nodeIcons = {
  plug: <path d="M5.5 2v3m5-3v3M4 5h8v2a4 4 0 0 1-8 0V5Zm4 6v3" />,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12" /><ellipse cx="8" cy="8" rx="2.5" ry="6" /></>,
  relay: <><path d="M2 5h3.5l5 6H14M2 11h3.5l5-6H14" /><path d="M12 3l2 2-2 2M12 9l2 2-2 2" /></>,
  terminal: <><path d="M2.5 4 6 8l-3.5 4" /><path d="M8 12h5.5" /></>,
  layers: <><path d="M8 2.5 2 5.5l6 3 6-3-6-3Z" /><path d="M2 8.5l6 3 6-3M2 11.5l6 3 6-3" /></>,
  webhook: <><path d="M7 5.5 4.5 10a2.3 2.3 0 1 0 2.6 2" /><path d="M9 5.5a2.3 2.3 0 1 0-4 0" /><path d="M9 5.5 11.5 10a2.3 2.3 0 1 1-1 3" /><path d="M4.5 11.5h7" /></>,
} as const
export type NodeIcon = keyof typeof nodeIcons

/** PluginFile's anatomy with a choosable icon: outer border, inset rule at 3px, icon + name, trailing content. */
export function NodeCard({ name, icon = "plug", color, iconColor, frameColor, insetColor, children, className = "", ...props }: Omit<HTMLMotionProps<"section">, "color" | "style" | "children"> & {
  name: ReactNode; icon?: NodeIcon
  color?: MotionValue<string>; iconColor?: MotionValue<string>
  /** Live frame inks (outer border and inset rule); omit for the resting diagram inks. */
  frameColor?: MotionValue<string>; insetColor?: MotionValue<string>; children?: ReactNode
}) {
  return <motion.section {...props} className={`diagram-frame node-card ${className}`} style={{ borderColor: frameColor }}>
    <motion.span className="node-card-inset" style={{ borderColor: insetColor }} data-node-inset="" aria-hidden="true" />
    <motion.div className="node-card-name" style={{ color }}>
      <motion.svg className="node-card-icon" style={{ color: iconColor }} width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-node-icon="">
        {nodeIcons[icon]}
      </motion.svg>
      <span className="node-card-label">{name}</span>
    </motion.div>
    {children}
  </motion.section>
}
