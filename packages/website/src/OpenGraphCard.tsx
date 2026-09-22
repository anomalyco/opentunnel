import { useEffect } from "react"
import { ArrowsLeftRight, Globe, LockSimple } from "@phosphor-icons/react"
import { TunnelArt } from "./poster/TunnelArt"
import { Barcode, Crosshair } from "./Micro"
import { Caption, Wordmark, wordmarkFontSize } from "./wordmark"
import { Splatter } from "./Splatter"
import { Ink } from "./Ink"
import "./OpenGraphCard.css"

declare global {
  interface Window { __ogReady?: Promise<void> }
}

// The share card, as a printed sheet in one ink: a frame with registration marks, the print, the wordmark with
// its caption, three squares that say what the thing is, the address and a barcode. Rendered at `/og` in development; `bun run og`
// screenshots it under reduced motion into public/og.png.

export function OpenGraphCard() {
  useEffect(() => {
    window.__ogReady = Promise.all([document.fonts.load(`400 ${wordmarkFontSize}px Anton`), document.fonts.load("400 16px 'IBM Plex Mono'"), document.fonts.ready])
      .then(() => new Promise(resolve => setTimeout(resolve, 600)))
  }, [])
  return <div className="og-card" data-og-card>
    <Ink />
    <div className="og-frame" aria-hidden="true">
      <Crosshair className="og-reg og-reg-tl" /><Crosshair className="og-reg og-reg-tr" /><Crosshair className="og-reg og-reg-bl" /><Crosshair className="og-reg og-reg-br" />
    </div>
    <div className="og-print"><TunnelArt className="og-canvas" /></div>
    <div className="og-right">
      <div className="og-mark"><Wordmark className="og-wordmark" /><Splatter /></div>
      <p className="og-caption"><Caption size={22} /></p>
      <ul className="og-facts">
        <li><Globe size={48} weight="thin" /><b>public url</b></li>
        <li><ArrowsLeftRight size={48} weight="thin" /><b>relay</b></li>
        <li><LockSimple size={48} weight="thin" /><b>end to end</b></li>
      </ul>
      <div className="og-foot"><span>opentunnel.xyz</span><Barcode text="OPENTUNNEL.XYZ" height={22} className="og-barcode" /></div>
    </div>
  </div>
}
