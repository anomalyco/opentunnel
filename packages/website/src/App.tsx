import { Banner } from "./banner/Banner"
import { Poster } from "./poster/Poster"
import { PosterControls } from "./poster/PosterControls"
import { TunnelScene } from "./scenes/TunnelScene"
import { DiagramHeader } from "./graphics/Diagram"
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

/** One framed cell of the grid: a header set into the frame, then its matter. */
function Cell({ span, title, className = "", children }: { span: number; title?: string; className?: string; children: React.ReactNode }) {
  return <section className={`cell ${className}`} style={{ gridColumn: `span ${span}` }}>
    {title && <DiagramHeader as="h3">{title}</DiagramHeader>}
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
      <a className="site-mark" href="/">OpenTunnel</a>
      <nav className="site-nav">
        <a href={docs}>Docs</a>
        <a href={github}>GitHub</a>
        <a href={npm}>npm</a>
      </nav>
    </header>

    <main className="grid">
      <div className="cell cell-hero" style={{ gridColumn: "span 12" }}>
        {hero === "poster" ? <div className="hero-poster"><Poster /></div> : <Banner />}
      </div>

      <Cell span={8} className="cell-lede">
        <h1>Public HTTPS URLs for anything on your machine. End-to-end encrypted. The relay can't read your traffic.</h1>
      </Cell>
      <Cell span={4} className="cell-install">
        <Install />
      </Cell>

      <Cell span={12} title="Encrypted by default" className="cell-diagram">
        <div className="diagram"><TunnelScene /></div>
      </Cell>

      <Cell span={4} title="Your machine">
        <p>The private key is generated here and never leaves.</p>
      </Cell>
      <Cell span={4} title="The relay">
        <p>Routes by hostname. Holds no key. Reads nothing.</p>
      </Cell>
      <Cell span={4} title="The certificate">
        <p>One wildcard per tunnel. The relay sees only the public half.</p>
      </Cell>

      <Cell span={7} title="terminal" className="cell-code">
        <pre className="code"><code>
{cmd("opentunnel create")}
{out("Generating private key...")}
{out("Requesting certificate...")}
{out("Created https://f7a2mx4kq9vn.opentunnel.xyz")}
{"\n"}
{cmd("opentunnel route add opencode 127.0.0.1:47365")}
{cmd("opentunnel route add api 127.0.0.1:3000")}
{cmd("opentunnel route list")}
{out("api.f7a2mx4kq9vn.opentunnel.xyz       →  127.0.0.1:3000")}
{out("opencode.f7a2mx4kq9vn.opentunnel.xyz  →  127.0.0.1:47365")}</code></pre>
      </Cell>
      <Cell span={5} title="~/.config/opentunnel/default.toml" className="cell-code">
        <pre className="code"><code>
<span className="tok-dim">[</span>routes<span className="tok-dim">]</span>{"\n"}
opencode <span className="tok-dim">= "</span>127.0.0.1:47365<span className="tok-dim">"</span>{"\n"}
api <span className="tok-dim">= "</span>127.0.0.1:3000<span className="tok-dim">"</span></code></pre>
        <p className="note">Subdomains under one wildcard certificate. No path routing. Keys live outside the config.</p>
      </Cell>

      <Cell span={3} title="Unreadable">
        <p>The relay routes by hostname and holds no key.</p>
      </Cell>
      <Cell span={3} title="Public hostname">
        <p>Certificates go to CT logs. Anyone can find <code>&lt;id&gt;.opentunnel.xyz</code>.</p>
      </Cell>
      <Cell span={3} title="Guessable routes">
        <p>Route names stay out of logs, but <code>api</code> is a guess. Not authentication.</p>
      </Cell>
      <Cell span={3} title="Bring auth">
        <p>Anything sensitive should authenticate on its own.</p>
      </Cell>
    </main>

    {import.meta.env.DEV && <PosterControls />}

    <footer className="site-footer">
      <a href={github}>github.com/anomalyco/opentunnel</a>
      <a href="https://anomaly.co">Anomaly</a>
    </footer>
  </div>
}
