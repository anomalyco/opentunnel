import { useEffect } from "react"
import { Globe, LockSimple } from "@phosphor-icons/react"
import { TunnelArt } from "./poster/TunnelArt"
import { Barcode, Crosshair } from "./Micro"
import "./OpenGraphCard.css"

declare global {
  interface Window { __ogReady?: Promise<void> }
}

// The share card, as a printed sheet in one ink: a frame with registration marks, the print, the wordmark with
// its caption, a hairline, the address and a barcode. Rendered at `/og`; `scripts/build-og.ts` screenshots it
// under reduced motion.

const WORDMARK = "OPENTUNNEL", WIDTH = 1000, ASPECT = 4.6, CAP = .867

export function OpenGraphCard() {
  const height = WIDTH / ASPECT, fontSize = height / CAP
  useEffect(() => {
    window.__ogReady = Promise.all([document.fonts.load(`400 ${fontSize}px Anton`), document.fonts.load("400 16px 'IBM Plex Mono'"), document.fonts.ready])
      .then(() => new Promise(resolve => setTimeout(resolve, 600)))
  }, [fontSize])
  return <div className="og-card" data-og-card>
    <div className="og-frame" aria-hidden="true">
      <Crosshair className="og-reg og-reg-tl" /><Crosshair className="og-reg og-reg-tr" /><Crosshair className="og-reg og-reg-bl" /><Crosshair className="og-reg og-reg-br" />
    </div>
    <div className="og-print"><TunnelArt className="og-canvas" /></div>
    <div className="og-right">
      <svg className="og-wordmark" viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <text x={0} y={height} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={fontSize} fill="currentColor">{WORDMARK}</text>
      </svg>
      <p className="og-caption">
        <b><span>public</span><i className="fill" /><span>urls</span><Globe size={16} className="tail" /></b>
        <b><span>for</span><i className="fill" /><span>anything</span><LockSimple size={16} className="tail" /></b>
      </p>
      <div className="og-foot"><span>opentunnel.xyz</span><Barcode text="OPENTUNNEL.XYZ" height={22} className="og-barcode" /></div>
    </div>
  </div>
}
