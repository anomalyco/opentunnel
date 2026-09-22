import { Globe as GlobeIcon, LockSimple } from "@phosphor-icons/react"
import type { ReactNode } from "react"

// The lockup's fixed parts, shared by the masthead and the share card: the wordmark set in Anton, its glyphs
// stretched to a 4.6:1 box (`textLength` + `preserveAspectRatio="none"`), and the two caption lines under
// the square, each a word, a dotted leader, a word and a small icon on the caps.

export const WORDMARK = "OPENTUNNEL"
const WIDTH = 1000, ASPECT = 4.6, CAP = .867
export const wordmarkHeight = WIDTH / ASPECT
export const wordmarkFontSize = wordmarkHeight / CAP

export function Wordmark({ className }: { className: string }) {
  return <svg className={className} viewBox={`0 0 ${WIDTH} ${wordmarkHeight}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <text x={0} y={wordmarkHeight} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={wordmarkFontSize} fill="currentColor">{WORDMARK}</text>
  </svg>
}

/** The caption's two lines; `globe` lets the masthead put its turning globe where the card has a still one. */
export function Caption({ globe, size = 11 }: { globe?: ReactNode; size?: number }) {
  return <>
    <b><span>public</span><i className="fill" /><span>urls</span>{globe ?? <GlobeIcon size={size} className="tail" />}</b>
    <b><span>for</span><i className="fill" /><span>anything</span><LockSimple size={size} className="tail" /></b>
  </>
}
