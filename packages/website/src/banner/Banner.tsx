import { useEffect, useRef, useState } from "react"
import { FitText } from "../poster/FitText"
import { TunnelArt } from "../poster/TunnelArt"
import "./banner.css"

// Wide: paper on the left, the print dissolving in from under the wordmark's last letters.
// Stacked: paper on top, the print dissolving in from under the wordmark's baseline.
const paperWidth = .44

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

/** The hero print, full width: the wordmark on red paper, the tunnel dissolving in beside or below it. Nothing else. */
export function Banner() {
  const wide = useWide()
  const banner = useRef<HTMLDivElement>(null), paper = useRef<HTMLDivElement>(null)
  const [paperHeight, setPaperHeight] = useState(.5)
  useEffect(() => {
    if (wide || !banner.current || !paper.current) return
    const measure = () => setPaperHeight(paper.current!.offsetHeight / Math.max(1, banner.current!.offsetHeight))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(banner.current); observer.observe(paper.current)
    return () => observer.disconnect()
  }, [wide])
  const fade = wide
    ? { axis: "x" as const, from: paperWidth - .14, to: paperWidth + .18 }
    : { axis: "y" as const, from: paperHeight - .12, to: paperHeight + .14 }
  return <div ref={banner} className="banner" role="img" aria-label="OpenTunnel">
    <TunnelArt className="banner-canvas" fade={fade} />
    <div ref={paper} className="banner-paper">
      <FitText className="banner-wordmark" aspect={3.6} weight={.03} stretch>OPENTUNNEL</FitText>
    </div>
    <div className="banner-space" aria-hidden="true" />
  </div>
}
