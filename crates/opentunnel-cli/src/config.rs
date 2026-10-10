//! Declarative per-profile route configuration in
//! `$XDG_CONFIG_HOME/opentunnel/<profile>.toml`.

use std::path::PathBuf;
use std::time::SystemTime;

use anyhow::{Context, Result, bail};
use opentunnel::protocol::names;
use opentunnel::{ProxyProtocol, Route, Routes};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub routes: Routes,
}

pub fn path(profile: &str) -> PathBuf {
    opentunnel::paths::config_dir().join(format!("{profile}.toml"))
}

pub fn load(profile: &str) -> Result<Config> {
    let path = path(profile);
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    parse(&content).with_context(|| format!("in {}", path.display()))
}

/// Parses and validates a profile config.
pub fn parse(content: &str) -> Result<Config> {
    let config: Config = toml::from_str(content)?;
    for (name, route) in &config.routes {
        validate(name, &route.target)?;
    }
    Ok(config)
}

pub fn save(profile: &str, config: &Config) -> Result<()> {
    let path = path(profile);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(&path, render(config)).with_context(|| format!("writing {}", path.display()))
}

/// Writes the config with one line per route: the plain `host:port` string, or an inline
/// table when the route has options.
pub fn render(config: &Config) -> String {
    let mut content = String::from("[routes]\n");
    for (name, route) in &config.routes {
        let bare = !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        let key = if bare {
            name.clone()
        } else {
            toml::Value::String(name.clone()).to_string()
        };
        let target = toml::Value::String(route.target.clone());
        let value = match route.proxy_protocol {
            None => target.to_string(),
            Some(version) => format!("{{ target = {target}, proxy_protocol = \"{version}\" }}"),
        };
        content.push_str(&format!("{key} = {value}\n"));
    }
    content
}

pub fn modified(profile: &str) -> Option<SystemTime> {
    std::fs::metadata(path(profile))
        .and_then(|meta| meta.modified())
        .ok()
}

/// Expands a bare port to a localhost target: `3000` becomes `127.0.0.1:3000`.
pub fn normalize_target(target: &str) -> String {
    if !target.is_empty() && target.bytes().all(|byte| byte.is_ascii_digit()) {
        format!("127.0.0.1:{target}")
    } else {
        target.to_owned()
    }
}

pub fn validate(name: &str, target: &str) -> Result<()> {
    if !names::is_valid_route(name) {
        bail!("invalid route name '{name}': use '@' or one lowercase DNS label");
    }
    if names::parse_target(target).is_none() {
        bail!(
            "invalid target '{target}': use a port or host:port, for example 3000 or 127.0.0.1:3000"
        );
    }
    Ok(())
}

/// Length of a generated route name, in hex characters (64 bits).
pub const RANDOM_ROUTE_LENGTH: usize = 16;

/// A route name nobody can guess: 16 lowercase hex characters from the operating system's
/// CSPRNG, none of which collide with `routes`. Route names never appear in certificate
/// transparency logs, so this keeps a route's URL private. It is not authentication: anyone
/// given the URL can reach the route.
pub fn random_route_name(routes: &Routes) -> Result<String> {
    use ring::rand::SecureRandom;
    let random = ring::rand::SystemRandom::new();
    // A repeat is astronomically unlikely; a few attempts make it impossible in practice.
    for _ in 0..8 {
        let mut bytes = [0u8; RANDOM_ROUTE_LENGTH / 2];
        random
            .fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("the system random number generator failed"))?;
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        if !routes.contains_key(&name) {
            return Ok(name);
        }
    }
    bail!("could not generate an unused route name")
}

/// What `route add` did to the route it wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    Added,
    /// The route already pointed at the same target with the same options.
    Unchanged,
    /// The route existed with a different target or options; holds the old value.
    Updated(Route),
}

/// The name `route add` should write `route` under: the explicit name if one was given;
/// otherwise the existing route already pointing at the same target (so repeating the command
/// keeps the same URL, and can change its options), or a new random name.
pub fn choose_route(
    routes: &Routes,
    route: &Route,
    name: Option<&str>,
) -> Result<(String, Change)> {
    let name = match name {
        Some(name) => {
            validate(name, &route.target)?;
            name.to_owned()
        }
        None => {
            validate(names::ROOT_ROUTE, &route.target)?;
            match routes
                .iter()
                .find(|(_, existing)| existing.target == route.target)
            {
                Some((existing, _)) => existing.clone(),
                None => random_route_name(routes)?,
            }
        }
    };
    let change = match routes.get(&name) {
        None => Change::Added,
        Some(existing) if existing == route => Change::Unchanged,
        Some(existing) => Change::Updated(existing.clone()),
    };
    Ok((name, change))
}

/// Parses `--proxy-protocol`.
pub fn parse_proxy_protocol(value: &str) -> Result<ProxyProtocol, String> {
    ProxyProtocol::parse(value).ok_or_else(|| {
        format!(
            "invalid PROXY protocol version '{value}': use {}",
            ProxyProtocol::VALUES.join(" or ")
        )
    })
}

pub fn public_hostname(route: &str, hostname: &str) -> String {
    if route == names::ROOT_ROUTE {
        hostname.to_owned()
    } else {
        format!("{route}.{hostname}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routes(entries: &[(&str, &str)]) -> Routes {
        entries
            .iter()
            .map(|(name, target)| (name.to_string(), Route::new(*target)))
            .collect()
    }

    fn plain(target: &str) -> Route {
        Route::new(target)
    }

    #[test]
    fn random_names_are_valid_hex_routes() {
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..1000 {
            let name = random_route_name(&Routes::new()).unwrap();
            assert_eq!(name.len(), RANDOM_ROUTE_LENGTH);
            assert!(
                name.bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            );
            assert!(names::is_valid_route(&name));
            assert!(seen.insert(name), "random route names repeated");
        }
    }

    #[test]
    fn a_new_target_gets_a_random_name() {
        let existing = routes(&[("api", "127.0.0.1:3000")]);
        let (name, change) = choose_route(&existing, &plain("127.0.0.1:4000"), None).unwrap();
        assert_eq!(name.len(), RANDOM_ROUTE_LENGTH);
        assert_eq!(change, Change::Added);
    }

    #[test]
    fn repeating_a_target_keeps_its_route() {
        let existing = routes(&[("0123456789abcdef", "127.0.0.1:3000")]);
        assert_eq!(
            choose_route(&existing, &plain("127.0.0.1:3000"), None).unwrap(),
            ("0123456789abcdef".to_owned(), Change::Unchanged)
        );
    }

    #[test]
    fn repeating_a_target_with_other_options_updates_its_route() {
        let existing = routes(&[("0123456789abcdef", "127.0.0.1:3000")]);
        let proxied = plain("127.0.0.1:3000").with_proxy_protocol(Some(ProxyProtocol::V2));
        assert_eq!(
            choose_route(&existing, &proxied, None).unwrap(),
            (
                "0123456789abcdef".to_owned(),
                Change::Updated(plain("127.0.0.1:3000"))
            )
        );
        assert_eq!(
            choose_route(&existing, &proxied, Some("other")).unwrap(),
            ("other".to_owned(), Change::Added)
        );
    }

    #[test]
    fn profile_vectors() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../spec/vectors/route-options.json"
        );
        let vectors: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in vectors["profiles"].as_array().unwrap() {
            let parsed = parse(case["toml"].as_str().unwrap());
            if case["error"].as_bool() == Some(true) {
                assert!(parsed.is_err(), "{case}");
                continue;
            }
            let config = parsed.unwrap_or_else(|error| panic!("{case}: {error:#}"));
            let expected: Routes = case["routes"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, route)| {
                    let version = route["proxyProtocol"]
                        .as_str()
                        .map(|version| ProxyProtocol::parse(version).unwrap());
                    let route =
                        Route::new(route["target"].as_str().unwrap()).with_proxy_protocol(version);
                    (name.clone(), route)
                })
                .collect();
            assert_eq!(config.routes, expected, "{case}");
            let written = render(&config);
            assert_eq!(parse(&written).unwrap().routes, expected);
            if let Some(expected) = case["written"].as_str() {
                assert_eq!(written, expected);
            }
        }
    }

    #[test]
    fn rejects_unknown_route_keys_clearly() {
        let error =
            parse("[routes]\napi = { target = \"127.0.0.1:1\", proxy = \"v2\" }\n").unwrap_err();
        assert!(
            format!("{error:#}").contains("unknown field `proxy`"),
            "{error:#}"
        );
        let error =
            parse("[routes]\napi = { target = \"127.0.0.1:1\", proxy_protocol = \"v3\" }\n")
                .unwrap_err();
        assert!(
            format!("{error:#}").contains(r#""v1" or "v2""#),
            "{error:#}"
        );
    }

    #[test]
    fn parses_proxy_protocol_versions() {
        assert_eq!(parse_proxy_protocol("v1"), Ok(ProxyProtocol::V1));
        assert_eq!(parse_proxy_protocol("v2"), Ok(ProxyProtocol::V2));
        assert!(parse_proxy_protocol("V2").is_err());
        assert!(parse_proxy_protocol("2").is_err());
    }

    #[test]
    fn writes_plain_routes_unchanged_and_options_as_tables() {
        let mut config = Config::default();
        config.routes.insert("@".into(), plain("127.0.0.1:8080"));
        config.routes.insert("web".into(), plain("127.0.0.1:3000"));
        let before = render(&config);
        assert_eq!(before, toml::to_string(&config).unwrap());
        assert_eq!(
            before,
            "[routes]\n\"@\" = \"127.0.0.1:8080\"\nweb = \"127.0.0.1:3000\"\n"
        );
        assert_eq!(
            toml::from_str::<Config>(&before).unwrap().routes,
            config.routes
        );

        config.routes.insert(
            "api".into(),
            plain("127.0.0.1:4000").with_proxy_protocol(Some(ProxyProtocol::V1)),
        );
        let written = render(&config);
        assert_eq!(
            written,
            "[routes]\n\"@\" = \"127.0.0.1:8080\"\napi = { target = \"127.0.0.1:4000\", proxy_protocol = \"v1\" }\nweb = \"127.0.0.1:3000\"\n"
        );
        assert_eq!(
            toml::from_str::<Config>(&written).unwrap().routes,
            config.routes
        );
        assert_eq!(
            render(&Config::default()),
            toml::to_string(&Config::default()).unwrap()
        );
    }

    #[test]
    fn an_explicit_name_is_validated_and_used() {
        let existing = routes(&[("api", "127.0.0.1:3000")]);
        assert_eq!(
            choose_route(&existing, &plain("127.0.0.1:3000"), Some("api")).unwrap(),
            ("api".to_owned(), Change::Unchanged)
        );
        assert_eq!(
            choose_route(&existing, &plain("127.0.0.1:4000"), Some("api")).unwrap(),
            ("api".to_owned(), Change::Updated(plain("127.0.0.1:3000")))
        );
        assert_eq!(
            choose_route(&existing, &plain("127.0.0.1:4000"), Some("@")).unwrap(),
            ("@".to_owned(), Change::Added)
        );
        assert!(choose_route(&existing, &plain("127.0.0.1:4000"), Some("Not_Valid")).is_err());
        assert!(choose_route(&existing, &plain("not a target"), None).is_err());
    }
}
