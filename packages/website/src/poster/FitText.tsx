import type { CSSProperties } from "react"

// Display type set to an exact width. The glyphs are stretched to fill the box
// (`lengthAdjust="spacingAndGlyphs"`), so the line always runs edge to edge no
// matter which face is loaded, and a same-colour stroke adds weight.
const WIDTH = 1000

type Props = {
  children: string
  /** Cap height as a fraction of the box height: Anton caps sit near .72em. */
  capHeight?: number
  /** Extra weight, as a fraction of the font size. */
  weight?: number
  aspect?: number
  className?: string
  style?: CSSProperties
}

export function FitText({ children, capHeight = .72, weight = .03, aspect = 4.2, className, style }: Props) {
  const height = WIDTH / aspect
  const fontSize = height / capHeight
  const strokeWidth = fontSize * weight
  return <svg className={className} style={style} viewBox={`${-strokeWidth / 2} 0 ${WIDTH + strokeWidth} ${height}`} aria-hidden="true" focusable="false">
    <text x={0} y={height} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={fontSize} fill="currentColor" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" style={{ paintOrder: "stroke fill" }}>{children}</text>
  </svg>
}
