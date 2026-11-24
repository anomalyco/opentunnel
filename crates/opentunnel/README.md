# opentunnel

Rust client for [OpenTunnel](https://github.com/anomalyco/opentunnel): blind
TLS tunnels. TLS terminates in your process, so the relay never
sees plaintext or the private key.

```rust
let client = opentunnel::Client::default();
client.ensure("default").await?;
let routes = [
    ("web".to_string(), "127.0.0.1:3000".into()),
    (
        "api".to_string(),
        opentunnel::Route::new("127.0.0.1:4000")
            .with_proxy_protocol(Some(opentunnel::ProxyProtocol::V2)),
    ),
]
.into();
let mut tunnel = client.connect("default", routes)?;
let mut events = tunnel.subscribe();
tunnel.ready().await?; // the bridge attached: the public URLs work
tunnel.wait().await?;
```

`Client` creates and stores tunnels per profile under
`$XDG_DATA_HOME/opentunnel`, in the same layout as the TypeScript SDK and CLI.
`Tunnel` keeps one bridge session connected, reconnects with backoff, accepts
route changes with `set_routes`, and picks up certificates the server renews.

The API and bridge connections trust the bundled Mozilla roots, the OS trust
store (`SSL_CERT_FILE` and `SSL_CERT_DIR` are honored), and the PEM file in
`ClientOptions::ca_cert` or `OPENTUNNEL_CA_CERT`, so the client works behind
TLS-inspecting corporate proxies. Unreadable OS certificates are skipped.

Both connections also go through the HTTP proxy the environment names, chosen
by the same rules (reqwest's): `HTTPS_PROXY` for an `https://` API and its
`wss://` bridge, `HTTP_PROXY` for `http://` and `ws://`, then `ALL_PROXY`,
except for hosts in `NO_PROXY`. The bridge supports `http://` and `https://`
proxies, with basic auth from the URL's credentials; a SOCKS proxy stops the
tunnel with an error.
