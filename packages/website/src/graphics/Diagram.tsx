import type { ComponentPropsWithRef, ReactNode } from "react"
import { motion, type HTMLMotionProps, type MotionValue } from "motion/react"
import "./diagram.css"

// The blog's shipped diagram anatomy (src/graphics/ui/DiagramFrame, PluginFile), transcribed from StyleX to
// plain CSS with the Clear neutral inks.

export function DiagramFrame({ className = "", ...props }: ComponentPropsWithRef<"section">) {
  return <section {...props} className={`diagram-frame ${className}`} />
}

/** PluginFile's anatomy with a choosable icon: outer border, inset rule at 3px, icon + name, trailing content. */
export function NodeCard({ name, icon, color, iconColor, frameColor, insetColor, children, className = "", ...props }: Omit<HTMLMotionProps<"section">, "color" | "style" | "children"> & {
  name: ReactNode
  /** Any 16px element: a Phosphor icon, a live globe. */
  icon: ReactNode
  color?: MotionValue<string>; iconColor?: MotionValue<string>
  /** Live frame inks (outer border and inset rule); omit for the resting diagram inks. */
  frameColor?: MotionValue<string>; insetColor?: MotionValue<string>; children?: ReactNode
}) {
  return <motion.section {...props} className={`diagram-frame node-card ${className}`} style={{ borderColor: frameColor }}>
    <motion.span className="node-card-inset" style={{ borderColor: insetColor }} aria-hidden="true" />
    <motion.div className="node-card-name" style={{ color }}>
      <motion.span className="node-card-icon" style={{ color: iconColor }} aria-hidden="true">{icon}</motion.span>
      <span className="node-card-label">{name}</span>
    </motion.div>
    {children}
  </motion.section>
}
