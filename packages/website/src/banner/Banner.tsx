import { FitText } from "../poster/FitText"
import { TunnelArt } from "../poster/TunnelArt"
import "./banner.css"

/** The hero print, full width: the wordmark on red paper, the tunnel printed in red ink on black beside it. */
export function Banner() {
  return <div className="banner" role="img" aria-label="OpenTunnel: public URLs for anything. Encrypted end to end; your machine is the destination.">
    <div className="banner-paper">
      <FitText className="banner-wordmark" aspect={3.6} weight={.03} stretch>OPENTUNNEL</FitText>
      <div className="banner-tagline" aria-hidden="true">
        <span className="banner-tagline-lead">public urls for anything</span>
        <span className="banner-tagline-rule" />
        <span className="banner-tagline-notes">encrypted end to end<br />your machine is the destination</span>
      </div>
    </div>
    <div className="banner-art">
      <TunnelArt className="banner-canvas" />
      <ul className="banner-labels" data-corner="top" aria-hidden="true"><li>any service</li><li>any machine</li><li>anywhere</li></ul>
      <ul className="banner-labels" data-corner="bottom" aria-hidden="true"><li>open</li><li>private</li><li>borderless</li></ul>
    </div>
  </div>
}
