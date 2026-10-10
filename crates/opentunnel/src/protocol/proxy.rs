//! The PROXY protocol preamble a route can send to its target. See
//! `docs/protocol.md` and <https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt>.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use serde::{Deserialize, Serialize};

/// The public port every visitor connected to.
pub const PUBLIC_PORT: u16 = 443;

/// The 12-byte signature that starts every v2 header.
pub const V2_SIGNATURE: [u8; 12] = *b"\r\n\r\n\0\r\nQUIT\n";

const V2_PROXY: u8 = 0x21;
const V2_LOCAL: u8 = 0x20;
const V2_TCP4: u8 = 0x11;
const V2_TCP6: u8 = 0x21;
const V2_UNSPEC: u8 = 0x00;
const PP2_TYPE_AUTHORITY: u8 = 0x02;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyProtocol {
    V1,
    V2,
}

impl ProxyProtocol {
    pub const VALUES: [&str; 2] = ["v1", "v2"];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::V1 => "v1",
            Self::V2 => "v2",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "v1" => Some(Self::V1),
            "v2" => Some(Self::V2),
            _ => None,
        }
    }
}

impl fmt::Display for ProxyProtocol {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Parses the `peer` of an `open` frame: `ipv4:port`, `[ipv6]:port`, or a bare
/// address (port 0). IPv4-mapped IPv6 addresses become IPv4.
pub fn parse_peer(peer: &str) -> Option<SocketAddr> {
    let (ip, port) = if let Ok(ip) = peer.parse::<IpAddr>() {
        (ip, 0)
    } else if let Some(rest) = peer.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        (
            IpAddr::V6(host.parse::<Ipv6Addr>().ok()?),
            parse_port(port)?,
        )
    } else {
        let (host, port) = peer.rsplit_once(':')?;
        (
            IpAddr::V4(host.parse::<Ipv4Addr>().ok()?),
            parse_port(port)?,
        )
    };
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        ip => ip,
    };
    Some(SocketAddr::new(ip, port))
}

fn parse_port(value: &str) -> Option<u16> {
    if value.is_empty() || value.len() > 5 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// The header to write to a route target before any payload. The source is
/// the visitor (`peer`); the destination is the unspecified address of the
/// same family on port 443. v2 carries `sni` in a `PP2_TYPE_AUTHORITY` TLV.
pub fn header(version: ProxyProtocol, peer: &str, sni: &str) -> Vec<u8> {
    let source = parse_peer(peer);
    match version {
        ProxyProtocol::V1 => v1(source),
        ProxyProtocol::V2 => v2(source, sni),
    }
}

fn v1(source: Option<SocketAddr>) -> Vec<u8> {
    let line = match source {
        Some(SocketAddr::V4(source)) => format!(
            "PROXY TCP4 {} {} {} {PUBLIC_PORT}\r\n",
            source.ip(),
            Ipv4Addr::UNSPECIFIED,
            source.port()
        ),
        Some(SocketAddr::V6(source)) => format!(
            "PROXY TCP6 {} {} {} {PUBLIC_PORT}\r\n",
            source.ip(),
            Ipv6Addr::UNSPECIFIED,
            source.port()
        ),
        None => "PROXY UNKNOWN\r\n".to_owned(),
    };
    line.into_bytes()
}

fn v2(source: Option<SocketAddr>, sni: &str) -> Vec<u8> {
    let (command, family, mut body) = match source {
        Some(SocketAddr::V4(source)) => {
            let mut body = Vec::with_capacity(12);
            body.extend_from_slice(&source.ip().octets());
            body.extend_from_slice(&Ipv4Addr::UNSPECIFIED.octets());
            body.extend_from_slice(&source.port().to_be_bytes());
            body.extend_from_slice(&PUBLIC_PORT.to_be_bytes());
            (V2_PROXY, V2_TCP4, body)
        }
        Some(SocketAddr::V6(source)) => {
            let mut body = Vec::with_capacity(36);
            body.extend_from_slice(&source.ip().octets());
            body.extend_from_slice(&Ipv6Addr::UNSPECIFIED.octets());
            body.extend_from_slice(&source.port().to_be_bytes());
            body.extend_from_slice(&PUBLIC_PORT.to_be_bytes());
            (V2_PROXY, V2_TCP6, body)
        }
        None => (V2_LOCAL, V2_UNSPEC, Vec::new()),
    };
    // A TLS server name is at most 255 bytes; anything longer is not one.
    if !sni.is_empty() && sni.len() <= 255 {
        body.push(PP2_TYPE_AUTHORITY);
        body.extend_from_slice(&(sni.len() as u16).to_be_bytes());
        body.extend_from_slice(sni.as_bytes());
    }
    let mut header = Vec::with_capacity(16 + body.len());
    header.extend_from_slice(&V2_SIGNATURE);
    header.push(command);
    header.push(family);
    header.extend_from_slice(&(body.len() as u16).to_be_bytes());
    header.extend_from_slice(&body);
    header
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_peers() {
        assert_eq!(
            parse_peer("203.0.113.9:51234"),
            Some("203.0.113.9:51234".parse().unwrap())
        );
        assert_eq!(
            parse_peer("[2001:db8::1]:443"),
            Some("[2001:db8::1]:443".parse().unwrap())
        );
        assert_eq!(
            parse_peer("[::ffff:203.0.113.9]:80"),
            Some("203.0.113.9:80".parse().unwrap())
        );
        assert_eq!(
            parse_peer("203.0.113.9"),
            Some("203.0.113.9:0".parse().unwrap())
        );
        assert_eq!(parse_peer("203.0.113.9:+1"), None);
        assert_eq!(parse_peer("unknown"), None);
    }
}
