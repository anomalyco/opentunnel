import { useRef } from "react"
import { useMotionValueEvent, useTransform, type MotionValue } from "motion/react"

/** A wireframe globe turning slowly left to right. Six meridians; only those on the near hemisphere are drawn, each
 * as a half-ellipse arc from pole to pole, so a line enters at the left limb, crosses the disc and leaves at the right.
 * `clock` is in seconds. With a `period` (a looping clock's length) the rate is rounded so the turn completes whole
 * meridian spacings per loop and never skips at the restart. */
export function Globe({ clock, reduced = false, period, size = 16, className }: { clock: MotionValue<number>; reduced?: boolean; period?: number; size?: number; className?: string }) {
  const r = 6.5, cx = 8, cy = 8, count = 6, spacing = 2 * Math.PI / count
  const rate = period ? Math.round(.52 * period / spacing) * spacing / period : .52
  const meridians = useTransform(clock, t => {
    const turn = reduced ? .3 : t * rate
    let d = ""
    for (let k = 0; k < count; k++) {
      const lon = turn + k * spacing
      if (Math.cos(lon) <= 0) continue
      const rx = r * Math.abs(Math.sin(lon)), sweep = Math.sin(lon) > 0 ? 1 : 0
      d += `M${cx} ${cy - r}A${rx} ${r} 0 0 ${sweep} ${cx} ${cy + r}`
    }
    return d
  })
  const path = useRef<SVGPathElement>(null)
  useMotionValueEvent(meridians, "change", d => path.current?.setAttribute("d", d))
  return <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" aria-hidden="true">
    <circle cx={cx} cy={cy} r={r} />
    <path d={`M${cx - r} ${cy}h${2 * r}`} />
    <path ref={path} d={meridians.get()} />
  </svg>
}
