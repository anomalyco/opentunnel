import { FitText } from "../poster/FitText"
import { TunnelArt } from "../poster/TunnelArt"
import "./banner.css"

/** The hero print, full width: the wordmark on red paper, the tunnel printed beside it. Nothing else. */
export function Banner() {
  return <div className="banner" role="img" aria-label="OpenTunnel">
    <div className="banner-paper">
      <FitText className="banner-wordmark" aspect={3.6} weight={.03} stretch>OPENTUNNEL</FitText>
    </div>
    <div className="banner-art">
      <TunnelArt className="banner-canvas" />
    </div>
  </div>
}
