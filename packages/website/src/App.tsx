import { Poster } from "./poster/Poster"
import { TunnelScene } from "./scenes/TunnelScene"
import { Install } from "./Install"

const github = "https://github.com/anomalyco/opentunnel"
const npm = "https://www.npmjs.com/package/opentunnel"

export function App() {
  return <div className="site">
    <header className="site-header">
      <a className="site-mark" href="/">Open Tunnel</a>
      <nav className="site-nav">
        <a href={`${github}/tree/master/packages/cli`}>Docs</a>
        <a href={github}>GitHub</a>
        <a href={npm}>npm</a>
      </nav>
    </header>

    <main>
      <section className="hero">
        <Poster />
        <div className="hero-copy">
          <h1>The internet,<br />without the middle.</h1>
          <p className="hero-lede">OpenTunnel gives anything on your machine a public HTTPS URL, end-to-end encrypted, with a relay that <em>cannot</em> read your traffic.</p>
          <Install />
          <p className="hero-links">
            <a href={`${github}/tree/master/packages/cli`}>Docs →</a>
            <a href={github}>GitHub →</a>
            <a href={npm}>npm →</a>
          </p>
        </div>
      </section>

      <article className="prose">
        <section>
          <h2>Encrypted by default</h2>
          <p>A visitor connects to your public URL. The relay reads only the hostname from the TLS handshake and forwards the still-encrypted bytes to your machine. TLS terminates on your laptop; the traffic is decrypted only at its destination.</p>
          <div className="diagram"><TunnelScene /></div>
        </section>

        <section>
          <h2>How it works</h2>
          <ol className="steps">
            <li><strong>Reserve a hostname.</strong> <code>opentunnel create</code> gets you <code>&lt;id&gt;.opentunnel.xyz</code> and generates a private key on your machine. The key never leaves.</li>
            <li><strong>Get a certificate.</strong> The CLI requests a wildcard certificate for <code>*.&lt;id&gt;.opentunnel.xyz</code> from ZeroSSL, through a Cloudflare Workflow. The relay only ever sees the public half.</li>
            <li><strong>Open an encrypted bridge.</strong> A background service on your machine holds a WebSocket to the relay.</li>
            <li><strong>Relay by name.</strong> Cloudflare Spectrum passes TCP 443 to a Worker with TLS termination off. The Worker reads the hostname from the ClientHello and forwards the encrypted stream through the bridge. One Durable Object per tunnel owns the bridge and its TCP channels.</li>
            <li><strong>Decrypt at the destination.</strong> Your machine terminates TLS with its private key and proxies plaintext to the matching local app.</li>
          </ol>
        </section>

        <section>
          <h2>Using it</h2>
          <p>Create a tunnel once, add as many named routes as you like, and every command makes sure the background service is running.</p>
          <pre className="code"><code>{`$ opentunnel create
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
          <p>Routes are subdomains of your tunnel, covered by its wildcard certificate. There is no path routing. Configuration is a plain TOML file, safe to commit; keys and certificates live separately.</p>
          <pre className="code" data-filename="~/.config/opentunnel/default.toml"><code>{`[routes]
opencode = "127.0.0.1:47365"
api = "127.0.0.1:3000"`}</code></pre>
        </section>

        <section>
          <h2>Privacy</h2>
          <dl className="limits">
            <dt>The relay can't read your traffic.</dt>
            <dd>Connections are routed by the hostname in the TLS handshake. The bytes stay encrypted until they reach your machine, and the relay has no key to decrypt them.</dd>
            <dt>Your tunnel hostname is public.</dt>
            <dd>Anyone with your URL can reach your services. When a tunnel is created, its certificate is published to Certificate Transparency logs, so <code>&lt;id&gt;.opentunnel.xyz</code> is discoverable by anyone watching them.</dd>
            <dt>Route names are private, not secret.</dt>
            <dd>The certificate is a wildcard, so route names never appear in any log. They are still guessable, especially common names like <code>api</code> or <code>postgres</code>, so don't treat them as authentication.</dd>
            <dt>Put auth in the services themselves.</dt>
            <dd>Anything sensitive behind a tunnel should authenticate on its own.</dd>
          </dl>
        </section>
      </article>
    </main>

    <footer className="site-footer">
      <span>OpenTunnel is open source, by <a href="https://anomaly.co">Anomaly</a>.</span>
      <a href={github}>github.com/anomalyco/opentunnel</a>
    </footer>
  </div>
}
