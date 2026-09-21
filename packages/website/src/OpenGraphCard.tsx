import { useEffect } from "react"
import { Globe, LockSimple } from "@phosphor-icons/react"
import { TunnelArt } from "./poster/TunnelArt"
import "./OpenGraphCard.css"

declare global {
  interface Window { __ogReady?: Promise<void> }
}

/** The masthead's lockup as the page's share card: the print, the stretched mark, the two-line caption under
 * the square, centred on a 1200×630 black canvas. Rendered at `/og`; `scripts/build-og.ts` screenshots it. */
const WORDMARK = "OPENTUNNEL", WIDTH = 1000, ASPECT = 4.6, CAP = .867

export function OpenGraphCard() {
  const height = WIDTH / ASPECT, fontSize = height / CAP
  useEffect(() => {
    // Ready once both faces have loaded (the mark stretches to its box only in the real Anton) and the print
    // has had a few frames to draw.
    window.__ogReady = Promise.all([document.fonts.load(`400 ${fontSize}px Anton`), document.fonts.load("400 16px 'IBM Plex Mono'"), document.fonts.ready])
      .then(() => new Promise(resolve => setTimeout(resolve, 600)))
  }, [fontSize])
  return <div className="og-card" data-og-card>
    <div className="og-lockup">
      <div className="og-print"><TunnelArt className="og-canvas" /></div>
      <svg className="og-wordmark" viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <text x={0} y={height} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={fontSize} fill="currentColor">{WORDMARK}</text>
      </svg>
      <p className="og-caption">
        <b><span>public</span><i className="fill" /><span>urls</span><Globe size={11} className="tail" /></b>
        <b><span>for</span><i className="fill" /><span>anything</span><LockSimple size={11} className="tail" /></b>
      </p>
    </div>
  </div>
}
