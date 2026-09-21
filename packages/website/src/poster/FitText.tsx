import type { CSSProperties } from "react"

// Display type set to an exact width. The glyphs are stretched to fill the box
// (`lengthAdjust="spacingAndGlyphs"`), so the line always runs edge to edge no
// matter which face is loaded, and a same-colour stroke adds weight.
const WIDTH = 1000

type Props = {
  children: string
  /** Cap height of the face in em: Anton's caps measure .867em (canvas actualBoundingBoxAscent). */
  capHeight?: number
  /** Extra weight, as a fraction of the font size. */
  weight?: number
  /** Font weight of the face itself. */
  fontWeight?: number
  aspect?: number
  /** Fill the CSS box in both directions: a taller box condenses the letterforms. */
  stretch?: boolean
  className?: string
  style?: CSSProperties
}

export function FitText({ children, capHeight = .867, weight = .03, aspect = 4.2, stretch = false, fontWeight, className, style }: Props) {
  const height = WIDTH / aspect
  const fontSize = height / capHeight
  const strokeWidth = fontSize * weight
  // The box is the caps' ink plus the stroke's half-width on every side, so the letters sit centred in it.
  const slack = strokeWidth / 2
  return <svg className={className} style={style} viewBox={`${-slack} ${-slack} ${WIDTH + strokeWidth} ${height + strokeWidth}`} preserveAspectRatio={stretch ? "none" : "xMidYMid meet"} aria-hidden="true" focusable="false">
    <text x={0} y={height} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={fontSize} fontWeight={fontWeight} fill="currentColor" stroke="currentColor" strokeWidth={strokeWidth} strokeLinejoin="round" style={{ paintOrder: "stroke fill" }}>{children}</text>
  </svg>
}
