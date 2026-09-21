import { RingTunnel } from "./RingTunnel"
import { RingControls } from "./RingControls"
import { useRingSettings } from "./ringSettings"
import "./components.css"

// Development: the component workshop at /components. The ring tunnel, large, at the sizes the page would use it,
// and standing in for the print beside the wordmark. Its knobs are in the panel on the right.

const WORDMARK = "OPENTUNNEL", WIDTH = 1000, ASPECT = 4.6, CAP = .867

export function ComponentsPage() {
  const settings = useRingSettings()
  const height = WIDTH / ASPECT
  return <main className="workshop">
    <h1>components <span>/ ring tunnel</span></h1>
    <section className="workshop-stage">
      <RingTunnel size={440} settings={settings} />
    </section>
    <section className="workshop-row" aria-label="At size">
      {[177, 133, 88, 44, 24].map(size => <figure key={size}><RingTunnel size={size} settings={settings} /><figcaption>{size}</figcaption></figure>)}
    </section>
    <section className="workshop-lockup" aria-label="Beside the wordmark">
      <div className="workshop-square"><RingTunnel size={133} settings={settings} /></div>
      <svg className="workshop-wordmark" viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <text x={0} y={height} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={height / CAP} fill="currentColor">{WORDMARK}</text>
      </svg>
    </section>
    <section className="workshop-row" aria-label="Phases">
      {[0, 1.3, 2.6, 3.9].map(offset => <figure key={offset}><RingTunnel size={88} settings={settings} timeOffset={offset} /><figcaption>+{offset}s</figcaption></figure>)}
    </section>
    <RingControls />
  </main>
}
