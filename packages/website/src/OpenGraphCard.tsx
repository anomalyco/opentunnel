import { useEffect } from "react"
import { TunnelArt } from "./poster/TunnelArt"
import { Barcode, Crosshair } from "./Micro"
import { Caption, Wordmark, wordmarkFontSize } from "./wordmark"
import "./OpenGraphCard.css"

declare global {
  interface Window { __ogReady?: Promise<void> }
}

// The share card, as a printed sheet in one ink: a frame with registration marks, the print, the wordmark with
// its caption, a hairline, the address and a barcode. Rendered at `/og` in development; `bun run og`
// screenshots it under reduced motion into public/og.png.

export function OpenGraphCard() {
  useEffect(() => {
    window.__ogReady = Promise.all([document.fonts.load(`400 ${wordmarkFontSize}px Anton`), document.fonts.load("400 16px 'IBM Plex Mono'"), document.fonts.ready])
      .then(() => new Promise(resolve => setTimeout(resolve, 600)))
  }, [])
  return <div className="og-card" data-og-card>
    <div className="og-frame" aria-hidden="true">
      <Crosshair className="og-reg og-reg-tl" /><Crosshair className="og-reg og-reg-tr" /><Crosshair className="og-reg og-reg-bl" /><Crosshair className="og-reg og-reg-br" />
    </div>
    <div className="og-print"><TunnelArt className="og-canvas" /></div>
    <div className="og-right">
      <Wordmark className="og-wordmark" />
      <p className="og-caption"><Caption size={16} /></p>
      <div className="og-foot"><span>opentunnel.xyz</span><Barcode text="OPENTUNNEL.XYZ" height={22} className="og-barcode" /></div>
    </div>
  </div>
}
