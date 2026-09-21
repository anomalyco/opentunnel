import type React from "react"
import { FitText } from "./FitText"
import { Bars, CropMark, Globe, HalftoneSkyline, LaptopLock, Relay, Sparkle, SparklePlus, Target } from "./PosterMarks"
import { TunnelArt } from "./TunnelArt"
import "./poster.css"

/** The hero's print: red paper, black ink, a live tunnel under the wordmark. */
/** Dev only: `?font=Bebas Neue` tries another display face on the poster. */
const fontOverride = import.meta.env.DEV ? new URLSearchParams(location.search).get("font") : null

export function Poster() {
  return <div className="poster" role="img" style={fontOverride ? { "--font-display": `"${fontOverride}"` } as React.CSSProperties : undefined} aria-label="OpenTunnel poster: public URLs for anything. Encrypted end to end, built by Anomaly.">
    <FitText className="poster-wordmark" aspect={4.6} weight={.035}>OPENTUNNEL</FitText>
    <div className="poster-art"><TunnelArt className="poster-canvas" /></div>
    <FitText className="poster-tagline" aspect={11} weight={.02}>PUBLIC URLS FOR ANYTHING</FitText>
    <div className="poster-footer" aria-hidden="true">
      <ul className="poster-notes">
        <li>encrypted<br />end to end</li>
        <li>built by<br />anomaly</li>
        <li>for a more<br />open internet</li>
      </ul>
      <HalftoneSkyline />
      <div className="poster-icons"><Globe /><LaptopLock /><Relay /></div>
      <div className="poster-marks"><SparklePlus /><Target /></div>
    </div>
    <div className="poster-colophon" aria-hidden="true">
      <CropMark />
      <Bars />
      <span className="poster-cut" />
      <Sparkle />
      <CropMark flip />
    </div>
  </div>
}
