import { Banner } from "./banner/Banner"
import { Poster } from "./poster/Poster"
import { PosterControls } from "./poster/PosterControls"
import { TunnelScene } from "./scenes/TunnelScene"
import { Install } from "./Install"

const github = "https://github.com/anomalyco/opentunnel"
const docs = `${github}/tree/master/packages/cli`
const npm = "https://www.npmjs.com/package/opentunnel"

/** Terminal lines: what you typed is bright, what came back is dim. */
const cmd = (text: string) => <><span className="tok-dim">$ </span><span className="tok-cmd">{text}</span>{"\n"}</>
const out = (text: string) => <><span className="tok-out">{text}</span>{"\n"}</>

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
      </nav>
    </header>

    <main>
      {hero === "poster" ? <div className="hero-poster"><Poster /></div> : <Banner />}

      <section className="pitch">
        <h1 className="pitch-lede">Public HTTPS URLs for anything on your machine. End-to-end encrypted: the relay can't read your traffic.</h1>
        <Install />
      </section>

      <section className="chapter">
        <h2>Encrypted by default</h2>
        <p className="measure">The relay reads the hostname and forwards the encrypted bytes. TLS ends on your machine.</p>
        <div className="diagram"><TunnelScene /></div>
      </section>

      <section className="chapter">
        <h2>How it works</h2>
        <ul className="steps">
          <li><code>opentunnel create</code> reserves <code>&lt;id&gt;.opentunnel.xyz</code> and generates a private key on your machine. It never leaves.</li>
          <li>A wildcard certificate is issued for it. The relay sees only the public half.</li>
          <li>Your machine holds an encrypted bridge to the relay.</li>
          <li>The relay reads the hostname from the TLS handshake and forwards the encrypted stream.</li>
          <li>Your machine terminates TLS and proxies to the local app.</li>
        </ul>
      </section>

      <section className="chapter">
        <h2>Using it</h2>
        <div className="columns">
          <pre className="code" data-filename="terminal"><code>
{cmd("opentunnel create")}
{out("Creating tunnel...")}
{out("Generating private key...")}
{out("Requesting certificate...")}
{out("Tunnel is ready.")}
{out("Created https://f7a2mx4kq9vn.opentunnel.xyz")}
{"\n"}
{cmd("opentunnel route add opencode 127.0.0.1:47365")}
{out("Added route opencode.f7a2mx4kq9vn.opentunnel.xyz -> 127.0.0.1:47365")}
{"\n"}
{cmd("opentunnel route add api 127.0.0.1:3000")}
{cmd("opentunnel route list")}
{out("api.f7a2mx4kq9vn.opentunnel.xyz       →  127.0.0.1:3000")}
{out("opencode.f7a2mx4kq9vn.opentunnel.xyz  →  127.0.0.1:47365")}</code></pre>
          <div>
            <pre className="code" data-filename="~/.config/opentunnel/default.toml"><code>
<span className="tok-dim">[</span>routes<span className="tok-dim">]</span>{"\n"}
opencode <span className="tok-dim">= "</span>127.0.0.1:47365<span className="tok-dim">"</span>{"\n"}
api <span className="tok-dim">= "</span>127.0.0.1:3000<span className="tok-dim">"</span></code></pre>
            <p className="note">Routes are subdomains under one wildcard certificate. No path routing. Keys and certificates live outside the config.</p>
          </div>
        </div>
      </section>

      <section className="chapter">
        <h2>Privacy</h2>
        <dl className="limits">
          <div>
            <dt>The relay can't read your traffic.</dt>
            <dd>It routes by hostname and holds no key.</dd>
          </div>
          <div>
            <dt>Your hostname is public.</dt>
            <dd>Certificates go to CT logs. Anyone can find <code>&lt;id&gt;.opentunnel.xyz</code>.</dd>
          </div>
          <div>
            <dt>Route names are private, not secret.</dt>
            <dd>They stay out of logs, but <code>api</code> is guessable. Not authentication.</dd>
          </div>
          <div>
            <dt>Put auth in the service.</dt>
            <dd>Anything sensitive should authenticate on its own.</dd>
          </div>
        </dl>
      </section>
    </main>

    {import.meta.env.DEV && <PosterControls />}

    <footer className="site-footer">
      <a href={github}>github.com/anomalyco/opentunnel</a>
      <a href="https://anomaly.co">Anomaly</a>
    </footer>
  </div>
}
