import { useEffect, useState } from "react"
import { FitText } from "../poster/FitText"
import { TunnelArt } from "../poster/TunnelArt"
import "./banner.css"

/** Paper ends at 44% of the banner; the print dissolves into it from under the last letters. */
const paperEnd = .44
const wideFade = [paperEnd - .14, paperEnd + .18] as const

function useWide() {
  const [wide, setWide] = useState(() => matchMedia("(min-width: 901px)").matches)
  useEffect(() => {
    const media = matchMedia("(min-width: 901px)")
    const update = () => setWide(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  return wide
}

/** The hero print, full width: the wordmark on red paper, the tunnel dissolving in beside it. Nothing else. */
export function Banner() {
  const wide = useWide()
  return <div className="banner" role="img" aria-label="OpenTunnel">
    <TunnelArt key={wide ? "wide" : "stacked"} className="banner-canvas" fade={wide ? wideFade : undefined} />
    <div className="banner-paper">
      <FitText className="banner-wordmark" aspect={3.6} weight={.03} stretch>OPENTUNNEL</FitText>
    </div>
  </div>
}
