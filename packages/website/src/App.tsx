import { Banner } from "./banner/Banner"
import { Poster } from "./poster/Poster"
import { PosterControls } from "./poster/PosterControls"
import { TunnelScene } from "./scenes/TunnelScene"
import { Install } from "./Install"
import { monoTables, theme } from "./theme"

const github = "https://github.com/anomalyco/opentunnel"
const docs = `${github}/tree/master/packages/cli`
const npm = "https://www.npmjs.com/package/opentunnel"

/** Terminal lines: what you typed is bright, what came back is dim. */
const cmd = (text: string) => <><span className="tok-dim">$ </span><span className="tok-cmd">{text}</span>{"\n"}</>
const out = (text: string) => <><span className="tok-out">{text}</span>{"\n"}</>

/** Dev only: `?hero=poster` shows the earlier portrait print in place of the banner. */
const hero = import.meta.env.DEV ? new URLSearchParams(location.search).get("hero") : null

/** One cell of the grid: a small label above its matter. The grid aligns; nothing is boxed. */
function Cell({ span, title, className = "", children }: { span: number; title?: string; className?: string; children: React.ReactNode }) {
  return <section className={`cell ${className}`} style={{ gridColumn: `span ${span}` }}>
    {title && <h3 className="cell-label">{title === "&nbsp;" ? "\u00a0" : title}</h3>}
    {children}
  </section>
}

export function App() {
  return <div className="site" data-theme={theme}>
    {theme === "mono" && <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden="true"><defs>
      {/* Duotone: everything becomes its luminance, then luminance is printed as bg→ink. */}
      <filter id="monotone" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={monoTables[0]} />
          <feFuncG type="table" tableValues={monoTables[1]} />
          <feFuncB type="table" tableValues={monoTables[2]} />
        </feComponentTransfer>
      </filter>
    </defs></svg>}

    <header className="site-header">
      <a className="site-mark" href="/">opentunnel</a>
      <nav className="site-nav">
        <a href={docs}>docs</a>
        <a href={github}>github</a>
        <a href={npm}>npm</a>
      </nav>
    </header>

    <main className="grid">
      <div className="cell cell-hero" style={{ gridColumn: "span 12" }}>
        {hero === "poster" ? <div className="hero-poster"><Poster /></div> : <Banner />}
      </div>

      <Cell span={8} className="cell-lede">
        <h1>a cli and sdk to create end-to-end encrypted public urls for apps running on your machine, reachable from anywhere in the world.</h1>
      </Cell>
      <Cell span={4} className="cell-install">
        <Install />
      </Cell>

      <Cell span={12} title="public urls for anything" className="cell-diagram">
        <div className="diagram"><TunnelScene /></div>
      </Cell>

      <Cell span={7} className="cell-code">
        <pre className="code" data-filename="cli"><code>
{cmd("opentunnel create")}
{out("Created https://f7a2mx4kq9vn.opentunnel.xyz")}
{"\n"}
{cmd("opentunnel route add opencode 127.0.0.1:47365")}
{out("Added route opencode.f7a2mx4kq9vn.opentunnel.xyz -> 127.0.0.1:47365")}
{"\n"}
{cmd("curl https://opencode.f7a2mx4kq9vn.opentunnel.xyz")}
{out("hello from localhost:47365")}</code></pre>
      </Cell>
      <Cell span={5} className="cell-code">
        <pre className="code" data-filename="~/.config/opentunnel/default.toml"><code>
<span className="tok-dim">[</span>routes<span className="tok-dim">]</span>{"\n"}
opencode <span className="tok-dim">= "</span>127.0.0.1:47365<span className="tok-dim">"</span>{"\n"}
api <span className="tok-dim">= "</span>127.0.0.1:3000<span className="tok-dim">"</span></code></pre>
        <p className="note">routes are subdomains under one wildcard certificate. no path routing. keys and certificates live outside the config.</p>
      </Cell>

      <Cell span={12} title="how it works" className="cell-steps">
        <ol className="steps">
          <li><code>opentunnel create</code> reserves your hostname and generates a private key on your machine. the key never leaves it.</li>
          <li>the cli sends a certificate request for that hostname. a certificate is issued and bound to your tunnel name. the relay only ever sees the public half.</li>
          <li>a service on your machine opens an encrypted bridge to the relay.</li>
          <li>visitors hit your public url. the relay reads only the hostname from the tls handshake and forwards the encrypted stream through the bridge.</li>
          <li>your machine terminates tls with its private key and proxies the traffic to your local apps.</li>
        </ol>
      </Cell>

      <Cell span={3} title="privacy">
        <p><strong>the relay can't read your traffic.</strong> connections are routed by the hostname in the tls handshake. the bytes stay encrypted until they reach your machine. the relay has no key to decrypt them.</p>
      </Cell>
      <Cell span={3} title="&nbsp;">
        <p><strong>your tunnel hostname is public.</strong> anyone with your url can reach your services. when a tunnel is created, its certificate is published to certificate transparency logs, so the hostname is discoverable by anyone watching them.</p>
      </Cell>
      <Cell span={3} title="&nbsp;">
        <p><strong>route names are private, not secret.</strong> the certificate is a wildcard, so route names never appear in any log. they are still guessable, especially common names like <code>api</code> or <code>postgres</code>, so don't treat them as authentication.</p>
      </Cell>
      <Cell span={3} title="&nbsp;">
        <p><strong>put auth in the services themselves.</strong> anything sensitive behind a tunnel should authenticate on its own.</p>
      </Cell>
    </main>

    {import.meta.env.DEV && <PosterControls />}

    <footer className="site-footer">
      <a href={github}>github.com/anomalyco/opentunnel</a>
      <a href="https://anomaly.co">anomaly</a>
    </footer>
  </div>
}
