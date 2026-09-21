import { useState } from "react"
import { Banner } from "./banner/Banner"
import { PosterControls } from "./poster/PosterControls"
import { TunnelScene } from "./scenes/TunnelScene"
import { FitText } from "./poster/FitText"
import { monoTables, theme } from "./theme"

const github = "https://github.com/anomalyco/opentunnel"

/** Dev only: `?hero=banner` puts the red print above the page. */
const hero = import.meta.env.DEV ? new URLSearchParams(location.search).get("hero") : null

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
      <FitText className="wordmark" capHeight={.71} aspect={5} weight={.028} fontWeight={800} stretch>OPENTUNNEL</FitText>
      <h1>public urls for anything</h1>

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

    {import.meta.env.DEV && hero === "banner" && <PosterControls />}
  </div>
}
