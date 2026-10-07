/// The route name for the tunnel hostname itself.
pub const ROOT_ROUTE: &str = "@";

fn is_label(value: &str) -> bool {
    let bytes = value.as_bytes();
    let valid_char = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    match bytes {
        [] => false,
        [only] => valid_char(only),
        [first, middle @ .., last] => {
            bytes.len() <= 63
                && valid_char(first)
                && valid_char(last)
                && middle.iter().all(|byte| valid_char(byte) || *byte == b'-')
        }
    }
}

pub fn is_valid_route(value: &str) -> bool {
    value == ROOT_ROUTE || is_label(value)
}

pub fn is_valid_profile(value: &str) -> bool {
    is_label(value)
}

/// Resolves the route name for a TLS SNI on the given tunnel hostname.
pub fn route_for_sni(sni: &str, hostname: &str) -> Option<String> {
    let sni = sni.to_ascii_lowercase();
    let hostname = hostname.to_ascii_lowercase();
    if sni == hostname {
        return Some(ROOT_ROUTE.to_owned());
    }
    let label = sni.strip_suffix(&hostname)?.strip_suffix('.')?;
    is_label(label).then(|| label.to_owned())
}

/// Validates a `host:port` route target and returns its parts.
pub fn parse_target(value: &str) -> Option<(&str, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let port: u16 = port.parse().ok().filter(|port| *port != 0)?;
    let host = match host.strip_prefix('[') {
        Some(inner) => inner.strip_suffix(']')?,
        None => host,
    };
    let valid_host = !host.is_empty()
        && host
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '-' | ':' | '_'));
    valid_host.then_some((host, port))
}
