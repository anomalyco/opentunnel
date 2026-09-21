import { Banner } from "./banner/Banner"
import { Poster } from "./poster/Poster"
import { PosterControls } from "./poster/PosterControls"
import { TunnelScene } from "./scenes/TunnelScene"
import { Install } from "./Install"

const github = "https://github.com/anomalyco/opentunnel"
const docs = `${github}/tree/master/packages/cli`
const npm = "https://www.npmjs.com/package/opentunnel"

/** Dev only: `?hero=poster` shows the earlier portrait print in place of the banner. */
const hero = import.meta.env.DEV ? new URLSearchParams(location.search).get("hero") : null

export function App() {
  return <div className="site">
    <header className="site-header">
      <a className="site-mark" href="/">OpenTunnel</a>
      <nav className="site-nav">
        <a href={docs}>Docs</a>
        <a href={github}>GitHub</a>
        <a href={npm}>npm</a>
        <span className="site-nav-rule" aria-hidden="true" />
        <span className="site-nav-note">a more open internet</span>
      </nav>
    </header>

    <main>
      {hero === "poster" ? <div className="hero-poster"><Poster /></div> : <Banner />}

      <section className="pitch">
        <h1>The internet,<br />without the middle.</h1>
        <div className="pitch-side">
          <p className="pitch-lede">OpenTunnel gives anything on your machine a public HTTPS URL, end-to-end encrypted, with a relay that cannot read your traffic.</p>
          <Install />
        </div>
      </section>

      <section className="chapter">
        <h2><span>01</span>Encrypted by default</h2>
        <p className="measure">A visitor connects to your public URL. The relay reads only the hostname from the TLS handshake and forwards the still-encrypted bytes to your machine. TLS terminates on your laptop; the traffic is decrypted only at its destination.</p>
        <div className="diagram"><TunnelScene /></div>
      </section>

      <section className="chapter">
        <h2><span>02</span>How it works</h2>
        <ol className="steps">
          <li><strong>Reserve a hostname.</strong> <code>opentunnel create</code> gets you <code>&lt;id&gt;.opentunnel.xyz</code> and generates a private key on your machine. The key never leaves.</li>
          <li><strong>Get a certificate.</strong> A wildcard certificate for <code>*.&lt;id&gt;.opentunnel.xyz</code> is issued by ZeroSSL through a Cloudflare Workflow. The relay only ever sees the public half.</li>
          <li><strong>Open an encrypted bridge.</strong> A background service on your machine holds a WebSocket to the relay.</li>
          <li><strong>Relay by name.</strong> Cloudflare Spectrum passes TCP 443 to a Worker with TLS termination off. The Worker reads the hostname from the ClientHello and forwards the encrypted stream through the bridge.</li>
          <li><strong>Decrypt at the destination.</strong> Your machine terminates TLS with its private key and proxies plaintext to the matching local app.</li>
        </ol>
      </section>

      <section className="chapter">
        <h2><span>03</span>Using it</h2>
        <p className="measure">Create a tunnel once, add as many named routes as you like. Every command makes sure the background service is running.</p>
        <div className="columns">
          <pre className="code" data-filename="terminal"><code>{`$ opentunnel create
Creating tunnel...
Generating private key...
Requesting certificate...
Tunnel is ready.
Created https://f7a2mx4kq9vn.opentunnel.xyz

$ opentunnel route add opencode 127.0.0.1:47365
Added route opencode.f7a2mx4kq9vn.opentunnel.xyz -> 127.0.0.1:47365

$ opentunnel route add api 127.0.0.1:3000
$ opentunnel route list
api.f7a2mx4kq9vn.opentunnel.xyz       →  127.0.0.1:3000
opencode.f7a2mx4kq9vn.opentunnel.xyz  →  127.0.0.1:47365`}</code></pre>
          <div>
            <pre className="code" data-filename="~/.config/opentunnel/default.toml"><code>{`[routes]
opencode = "127.0.0.1:47365"
api = "127.0.0.1:3000"`}</code></pre>
            <p className="note">Routes are subdomains of your tunnel, covered by its wildcard certificate. No path routing. The config is plain TOML, safe to commit; keys and certificates live separately.</p>
          </div>
        </div>
      </section>

      <section className="chapter">
        <h2><span>04</span>Privacy</h2>
        <dl className="limits">
          <div>
            <dt>The relay can't read your traffic.</dt>
            <dd>Connections are routed by the hostname in the TLS handshake. The bytes stay encrypted until they reach your machine; the relay has no key to decrypt them.</dd>
          </div>
          <div>
            <dt>Your tunnel hostname is public.</dt>
            <dd>Anyone with your URL can reach your services. Certificates go to Certificate Transparency logs, so <code>&lt;id&gt;.opentunnel.xyz</code> is discoverable by anyone watching them.</dd>
          </div>
          <div>
            <dt>Route names are private, not secret.</dt>
            <dd>The wildcard certificate keeps route names out of every log, but <code>api</code> or <code>postgres</code> are guessable. Don't treat them as authentication.</dd>
          </div>
          <div>
            <dt>Put auth in the services themselves.</dt>
            <dd>Anything sensitive behind a tunnel should authenticate on its own.</dd>
          </div>
        </dl>
      </section>
    </main>

    {import.meta.env.DEV && <PosterControls />}

    <footer className="site-footer">
      <span>OpenTunnel <span className="site-footer-sep">/</span> public urls for anything</span>
      <a href={github}>github.com/anomalyco/opentunnel</a>
      <span>built by <a href="https://anomaly.co">Anomaly</a></span>
    </footer>
  </div>
}
