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

pub fn public_hostname(route: &str, hostname: &str) -> String {
    if route == names::ROOT_ROUTE {
        hostname.to_owned()
    } else {
        format!("{route}.{hostname}")
    }
}
