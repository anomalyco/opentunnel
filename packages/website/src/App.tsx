import { useEffect, useRef, useState } from "react"
import { Banner } from "./banner/Banner"
import { PosterControls } from "./poster/PosterControls"
import { TunnelScene } from "./scenes/TunnelScene"
import { Mist } from "./mist/Mist"
import { TunnelArt } from "./poster/TunnelArt"
import { Barcode, Crosshair, Ruler } from "./Micro"
import { monoTables, theme } from "./theme"

const github = "https://github.com/anomalyco/opentunnel"

/** Dev only: `?hero=banner` puts the red print above the page; `?mist` shows the mist from the O. */
const hero = import.meta.env.DEV ? new URLSearchParams(location.search).get("hero") : null
const showMist = import.meta.env.DEV && new URLSearchParams(location.search).has("mist")

const installs = {
  npm: "npm i -g opentunnel",
  bun: "bun add -g opentunnel",
  pnpm: "pnpm add -g opentunnel",
} as const
type Manager = keyof typeof installs

function Install() {
  const [manager, setManager] = useState<Manager>("npm")
  return <div className="install">
    <div className="tabs" role="tablist">
      {(Object.keys(installs) as Manager[]).map(name => <button key={name} type="button" role="tab" aria-selected={manager === name} data-current={manager === name || undefined} onClick={() => setManager(name)}>{name}</button>)}
      <a href={github} target="_blank" rel="noopener">github</a>
    </div>
    <div className="command">$ {installs[manager]}</div>
  </div>
}

/** The wordmark as a tunnel mouth. Set like FitText (glyphs stretched to the box), drawn here so mist can be hung
 * from the O's counter, which is measured with a canvas in the same resolved font. */
const WORDMARK = "OPENTUNNEL", WIDTH = 1000, ASPECT = 4.6, CAP = .867

/** Dev: subtitle treatments to compare on the page; ← and → cycle them, the choice persists. */
const subtitleVariants = [
  "mono-left", "mono-right", "mono-caps", "mono-red", "mono-rule", "mono-bracket", "anton-left", "anton-caps", "anton-right", "mono-center",
  "caps-rule", "caps-red", "caps-right", "caps-spread", "caps-underline", "caps-box", "caps-numbered",
  "two-lines-right", "two-lines-square", "on-square", "full-row-rule", "large-light", "caps-dim-large", "caps-between",
  "micro-a", "micro-b", "micro-c", "square-just", "square-just-red", "square-just-rule", "square-just-right",
] as const
type SubtitleVariant = typeof subtitleVariants[number]
function useSubtitleVariant(): SubtitleVariant {
  const [variant, setVariant] = useState<SubtitleVariant>(() => (import.meta.env.DEV && localStorage.getItem("subtitle") as SubtitleVariant) || "mono-left")
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if ((event.target as HTMLElement)?.closest("input, textarea, button, [contenteditable]")) return
      setVariant(current => {
        const index = subtitleVariants.indexOf(current), step = event.key === "ArrowRight" ? 1 : -1
        const next = subtitleVariants[(index + step + subtitleVariants.length) % subtitleVariants.length]!
        localStorage.setItem("subtitle", next)
        return next
      })
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [])
  return variant
}

function Masthead() {
  const variant = useSubtitleVariant()
  const host = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), text = useRef<SVGTextElement>(null)
  const height = WIDTH / ASPECT, fontSize = height / CAP
  const [mist, setMist] = useState<{ left: number; top: number; width: number; height: number; source: [number, number] } | null>(null)
  useEffect(() => {
    const element = host.current, root = svg.current, glyphs = text.current
    if (!element || !root || !glyphs) return
    const context = document.createElement("canvas").getContext("2d")!
    const measure = () => {
      context.font = `400 ${fontSize}px ${getComputedStyle(glyphs).fontFamily}`
      const first = context.measureText("O"), all = context.measureText(WORDMARK)
      const stretch = WIDTH / all.width
      const next = { top: height - first.actualBoundingBoxAscent, bottom: height + first.actualBoundingBoxDescent, centre: first.width / 2 * stretch }
      // Where the ink really starts and ends, so a line under the mark can align with the O's and the L's edges.
      const scaleX = root.getBoundingClientRect().width / WIDTH
      element.style.setProperty("--ink-left", `${Math.max(0, -first.actualBoundingBoxLeft) * stretch * scaleX}px`)
      element.style.setProperty("--ink-right", `${Math.max(0, WIDTH - all.actualBoundingBoxRight * stretch) * scaleX}px`)
      // The mist rises from the O's counter and may wander anywhere: the canvas spans the viewport, from well
      // above the mark to a little below it.
      const ctm = root.getScreenCTM(), box = element.getBoundingClientRect()
      if (!ctm) return
      const mouth = new DOMPoint(next.centre, (next.top + next.bottom) / 2).matrixTransform(ctm)
      const left = -box.left, width = document.documentElement.clientWidth, top = -box.height * 1.6, span = box.height * 3
      setMist({ left, top, width, height: span, source: [(mouth.x - box.left - left) / width, 1 - (mouth.y - box.top - top) / span] })
    }
    document.fonts.ready.then(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [fontSize, height])
  const micro = variant.startsWith("micro")
  return <div ref={host} className="masthead" data-subtitle={variant}>
    {import.meta.env.DEV && <span className="variant-badge" aria-hidden="true">← {variant} →</span>}
    {(variant === "micro-b" || variant === "micro-c") && <><Ruler className="micro-ruler" /><Crosshair className="micro-crosshair" /></>}
    {/* Mist from the O's counter: parked until the smoke reads right. */}
    {mist && showMist && <Mist className="mist" style={{ left: mist.left, top: mist.top, width: mist.width, height: mist.height }} source={mist.source} />}
    {/* The tunnel print, as a square the height of the mark, beside it. */}
    <div className="masthead-print" role="img" aria-label="A tunnel"><TunnelArt className="masthead-canvas" /></div>
    <svg ref={svg} className="wordmark" viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <text ref={text} x={0} y={height} textLength={WIDTH} lengthAdjust="spacingAndGlyphs" fontSize={fontSize} fill="currentColor">{WORDMARK}</text>
    </svg>
    <h1><span>{variant.startsWith("two-lines") ? <>public urls<br />for anything</> : variant.startsWith("square-just") ? <><b>public urls</b><b>for anything</b></> : variant === "caps-between" ? <><em>public</em><em>urls</em><em>for</em><em>anything</em></> : "public urls for anything"}</span>
      {micro && <><span className="micro-leader" aria-hidden="true" /><span className="micro-meta">e2e · tls · v0.0.30</span></>}
      {variant === "micro-c" && <Barcode className="micro-barcode" text="OPENTUNNEL.XYZ" height={18} />}
    </h1>
  </div>
}

const out = (text: string) => <span className="output">{text}</span>

export function App() {
  return <div className="site" data-theme={theme}>
    {theme === "mono" && <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden="true"><defs>
      <filter id="monotone" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={monoTables[0]} />
          <feFuncG type="table" tableValues={monoTables[1]} />
          <feFuncB type="table" tableValues={monoTables[2]} />
        </feComponentTransfer>
      </filter>
    </defs></svg>}

    {hero === "banner" && <Banner />}

    <main>
      <Masthead />

      <div className="diagram-wrap"><div className="diagram"><TunnelScene /></div></div>

      <p className="description">
        a cli and sdk to create end-to-end encrypted public urls for apps running on your
        machine reachable from anywhere in the world
      </p>

      <Install />

      <section className="usage">
        <h2>cli</h2>
        <pre>{`$ opentunnel create\n`}{out("created f7a2mx4kq9vn.opentunnel.xyz")}{`\n\n$ opentunnel route add opencode localhost:47365\n`}{out("added route opencode.f7a2mx4kq9vn.opentunnel.xyz -> localhost:47365")}{`\n\n$ curl https://opencode.f7a2mx4kq9vn.opentunnel.xyz\n`}{out("hello from localhost:47365")}</pre>
      </section>

      <section className="sdk">
        <h2>sdk</h2>
        <pre>{`import { create } from "@opentunnel/client"

const client = create()

await client.route.add({
  name: "opencode",
  target: "localhost:47365",
})

const connection = await client.tunnel.connect()

console.log(connection.routes[0].hostname)
`}{out("opencode.f7a2mx4kq9vn.opentunnel.xyz")}</pre>
      </section>

      <section className="how">
        <h2>how it works</h2>
        <ol className="steps">
          <li><p>opentunnel create reserves your hostname and generates a private key on your machine. the key never leaves it.</p></li>
          <li><p>the cli sends a certificate request for that hostname. a certificate is issued and bound to your tunnel name. the relay only ever sees the public half.</p></li>
          <li><p>a service on your machine opens an encrypted bridge to the relay.</p></li>
          <li><p>visitors hit your public url. the relay reads only the hostname from the tls handshake and forwards the encrypted stream through the bridge.</p></li>
          <li><p>your machine terminates tls with its private key and proxies the traffic to your local apps.</p></li>
        </ol>
      </section>

      <section className="privacy">
        <h2>privacy</h2>
        <dl className="privacy-list">
          <div>
            <dt>the relay can't read your traffic</dt>
            <dd>connections are routed by the hostname in the tls handshake. the bytes stay encrypted until they reach your machine. the relay has no key to decrypt them.</dd>
          </div>
          <div>
            <dt>your tunnel hostname is public</dt>
            <dd>anyone with your url can reach your services. when a tunnel is created, its certificate is published to certificate transparency logs, so the hostname is discoverable by anyone watching them.</dd>
          </div>
          <div>
            <dt>route names are private, not secret</dt>
            <dd>the certificate is a wildcard, so route names never appear in any log. they are still guessable, especially common names like api or postgres, so don't treat them as authentication.</dd>
          </div>
          <div>
            <dt>put auth in the services themselves</dt>
            <dd>anything sensitive behind a tunnel should authenticate on its own.</dd>
          </div>
        </dl>
      </section>
    </main>

    {import.meta.env.DEV && <PosterControls />}
  </div>
}
