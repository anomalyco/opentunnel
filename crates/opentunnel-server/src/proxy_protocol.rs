//! PROXY protocol v1 and v2 headers, which Fly's `proxy_proto` handler puts in front of raw TCP connections so
//! the visitor's address survives the proxy.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

const V2_SIGNATURE: &[u8; 12] = b"\r\n\r\n\0\r\nQUIT\n";
const V1_MAX: usize = 107;

#[derive(Debug, PartialEq, Eq)]
pub enum Header {
    Incomplete,
    Invalid,
    /// The header's length and the original source address, if it carried one (`LOCAL` and `UNKNOWN` do not).
    Complete {
        length: usize,
        source: Option<SocketAddr>,
    },
}

pub fn parse(data: &[u8]) -> Header {
    if data.is_empty() {
        return Header::Incomplete;
    }
    if data[0] == b'\r' {
        return parse_v2(data);
    }
    if data[0] == b'P' {
        return parse_v1(data);
    }
    Header::Invalid
}

fn parse_v2(data: &[u8]) -> Header {
    let prefix = data.len().min(12);
    if data[..prefix] != V2_SIGNATURE[..prefix] {
        return Header::Invalid;
    }
    if data.len() < 16 {
        return Header::Incomplete;
    }
    let version_command = data[12];
    if version_command >> 4 != 2 {
        return Header::Invalid;
    }
    let family = data[13];
    let length = u16::from_be_bytes([data[14], data[15]]) as usize;
    let total = 16 + length;
    if data.len() < total {
        return Header::Incomplete;
    }
    let body = &data[16..total];
    let source = match (version_command & 0x0f, family >> 4) {
        // LOCAL: health checks from the proxy itself.
        (0, _) => None,
        (1, 1) if body.len() >= 12 => {
            let ip = Ipv4Addr::new(body[0], body[1], body[2], body[3]);
            Some(SocketAddr::new(
                IpAddr::V4(ip),
                u16::from_be_bytes([body[8], body[9]]),
            ))
        }
        (1, 2) if body.len() >= 36 => {
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&body[..16]);
            Some(SocketAddr::new(
                IpAddr::V6(Ipv6Addr::from(octets)),
                u16::from_be_bytes([body[32], body[33]]),
            ))
        }
        (1, _) => None,
        _ => return Header::Invalid,
    };
    Header::Complete {
        length: total,
        source,
    }
}

fn parse_v1(data: &[u8]) -> Header {
    let prefix = data.len().min(6);
    if data[..prefix] != b"PROXY "[..prefix] {
        return Header::Invalid;
    }
    let Some(end) = data.windows(2).position(|window| window == b"\r\n") else {
        return if data.len() >= V1_MAX {
            Header::Invalid
        } else {
            Header::Incomplete
        };
    };
    let Ok(line) = std::str::from_utf8(&data[..end]) else {
        return Header::Invalid;
    };
    let parts: Vec<&str> = line.split(' ').collect();
    let source = match parts.as_slice() {
        ["PROXY", "UNKNOWN", ..] => None,
        ["PROXY", "TCP4" | "TCP6", source, _, port, _] => {
            match (source.parse::<IpAddr>(), port.parse::<u16>()) {
                (Ok(ip), Ok(port)) => Some(SocketAddr::new(ip, port)),
                _ => return Header::Invalid,
            }
        }
        _ => return Header::Invalid,
    };
    Header::Complete {
        length: end + 2,
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_v1() {
        let data = b"PROXY TCP4 192.0.2.1 198.51.100.2 51234 443\r\n\x16\x03";
        assert_eq!(
            parse(data),
            Header::Complete {
                length: data.len() - 2,
                source: Some("192.0.2.1:51234".parse().unwrap())
            }
        );
        assert_eq!(parse(b"PROXY TCP4 192.0"), Header::Incomplete);
        assert_eq!(parse(b"\x16\x03\x01"), Header::Invalid);
    }

    #[test]
    fn parses_v2() {
        let mut data = V2_SIGNATURE.to_vec();
        data.extend([0x21, 0x11, 0, 12]);
        data.extend([203, 0, 113, 7, 10, 0, 0, 1]);
        data.extend(4433u16.to_be_bytes());
        data.extend(443u16.to_be_bytes());
        data.extend([0x16, 3, 1]);
        assert_eq!(
            parse(&data),
            Header::Complete {
                length: 28,
                source: Some("203.0.113.7:4433".parse().unwrap())
            }
        );
        assert_eq!(parse(&data[..20]), Header::Incomplete);
        let mut local = V2_SIGNATURE.to_vec();
        local.extend([0x20, 0x00, 0, 0]);
        assert_eq!(
            parse(&local),
            Header::Complete {
                length: 16,
                source: None
            }
        );
    }
}
