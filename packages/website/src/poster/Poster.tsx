import { FitText } from "./FitText"
import { TunnelArt } from "./TunnelArt"
import "./poster.css"

/** The hero's print: red paper, black ink, a live tunnel under the wordmark. */
export function Poster() {
  return <div className="poster" role="img" aria-label="OpenTunnel poster: public URLs for anything. Encrypted end to end, built by Anomaly.">
    <FitText className="poster-wordmark" aspect={4.6} weight={.035}>OPENTUNNEL</FitText>
    <div className="poster-art"><TunnelArt className="poster-canvas" /></div>
    <FitText className="poster-tagline" aspect={11} weight={.02}>PUBLIC URLS FOR ANYTHING</FitText>
    <ul className="poster-notes" aria-hidden="true">
      <li>encrypted end to end</li>
      <li>built by anomaly</li>
      <li>for a more open internet</li>
    </ul>
  </div>
}
