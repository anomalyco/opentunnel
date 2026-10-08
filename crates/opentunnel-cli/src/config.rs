//! Declarative per-profile route configuration in
//! `$XDG_CONFIG_HOME/opentunnel/<profile>.toml`.

use std::path::PathBuf;
use std::time::SystemTime;

use anyhow::{Context, Result, bail};
use opentunnel::Routes;
use opentunnel::protocol::names;
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
    let config: Config =
        toml::from_str(&content).with_context(|| format!("parsing {}", path.display()))?;
    for (name, target) in &config.routes {
        validate(name, target).with_context(|| format!("in {}", path.display()))?;
    }
    Ok(config)
}

pub fn save(profile: &str, config: &Config) -> Result<()> {
    let path = path(profile);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let content = toml::to_string(config).context("serializing config")?;
    std::fs::write(&path, content).with_context(|| format!("writing {}", path.display()))
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

/// The route that `route add` should write: the explicit name if one was given; otherwise the
/// existing route already pointing at `target` (so repeating the command keeps the same URL),
/// or a new random name. Returns the name and whether the route already existed as is.
pub fn choose_route(routes: &Routes, target: &str, name: Option<&str>) -> Result<(String, bool)> {
    if let Some(name) = name {
        validate(name, target)?;
        return Ok((
            name.to_owned(),
            routes.get(name).is_some_and(|existing| existing == target),
        ));
    }
    validate(names::ROOT_ROUTE, target)?;
    if let Some((existing, _)) = routes
        .iter()
        .find(|(_, existing)| existing.as_str() == target)
    {
        return Ok((existing.clone(), true));
    }
    Ok((random_route_name(routes)?, false))
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
            .map(|(name, target)| (name.to_string(), target.to_string()))
            .collect()
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
        let (name, existed) = choose_route(&existing, "127.0.0.1:4000", None).unwrap();
        assert_eq!(name.len(), RANDOM_ROUTE_LENGTH);
        assert!(!existed);
    }

    #[test]
    fn repeating_a_target_keeps_its_route() {
        let existing = routes(&[("0123456789abcdef", "127.0.0.1:3000")]);
        assert_eq!(
            choose_route(&existing, "127.0.0.1:3000", None).unwrap(),
            ("0123456789abcdef".to_owned(), true)
        );
    }

    #[test]
    fn an_explicit_name_is_validated_and_used() {
        let existing = routes(&[("api", "127.0.0.1:3000")]);
        assert_eq!(
            choose_route(&existing, "127.0.0.1:3000", Some("api")).unwrap(),
            ("api".to_owned(), true)
        );
        assert_eq!(
            choose_route(&existing, "127.0.0.1:4000", Some("api")).unwrap(),
            ("api".to_owned(), false)
        );
        assert_eq!(
            choose_route(&existing, "127.0.0.1:4000", Some("@")).unwrap(),
            ("@".to_owned(), false)
        );
        assert!(choose_route(&existing, "127.0.0.1:4000", Some("Not_Valid")).is_err());
        assert!(choose_route(&existing, "not a target", None).is_err());
    }
}
