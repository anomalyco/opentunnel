import type React from "react"
import { FitText } from "./FitText"
import { TunnelArt } from "./TunnelArt"
import "./poster.css"

/** The hero's print: red paper, black ink, a live tunnel under the wordmark. */
/** Dev only: `?font=Bebas Neue` tries another display face on the poster. */
const fontOverride = import.meta.env.DEV ? new URLSearchParams(location.search).get("font") : null

export function Poster() {
  return <div className="poster" role="img" style={fontOverride ? { "--font-display": `"${fontOverride}"` } as React.CSSProperties : undefined} aria-label="OpenTunnel poster: public URLs for anything. Your laptop is the destination.">
    <FitText className="poster-wordmark" aspect={4.6} weight={.035}>OPENTUNNEL</FitText>
    <div className="poster-art"><TunnelArt className="poster-canvas" /></div>
    <FitText className="poster-tagline" aspect={11} weight={.02}>PUBLIC URLS FOR ANYTHING</FitText>
    <div className="poster-notes" aria-hidden="true">
      <ul>
        <li>encrypted end to end</li>
        <li>built by anomaly</li>
        <li>for a more open internet</li>
      </ul>
      <span className="poster-glyph">公開</span>
    </div>
    <div className="poster-foot" aria-hidden="true">your laptop is the destination</div>
  </div>
}
