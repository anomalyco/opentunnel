//! Route values as stored in profile configs and passed to clients. See
//! "Route options" in `docs/protocol.md`.

use std::fmt;

use serde::de::{self, MapAccess, Unexpected, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::names::{is_valid_route, parse_target};
use super::proxy::ProxyProtocol;

const FIELDS: &[&str] = &["target", "proxy_protocol"];

/// Where a route forwards to, and how. Serializes as the plain `host:port`
/// string when no options are set, otherwise as a table with `target`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Route {
    pub target: String,
    /// Writes a PROXY protocol header to the target before any payload.
    pub proxy_protocol: Option<ProxyProtocol>,
}

impl Route {
    pub fn new(target: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            proxy_protocol: None,
        }
    }

    pub fn with_proxy_protocol(mut self, proxy_protocol: Option<ProxyProtocol>) -> Self {
        self.proxy_protocol = proxy_protocol;
        self
    }

    pub fn has_options(&self) -> bool {
        self.proxy_protocol.is_some()
    }

    /// Checks the route name and the target. Returns a message for the user.
    pub fn validate(&self, name: &str) -> Result<(), String> {
        if !is_valid_route(name) {
            return Err(format!("invalid route name '{name}'"));
        }
        if parse_target(&self.target).is_none() {
            return Err(format!(
                "invalid target '{}' for route '{name}': use host:port",
                self.target
            ));
        }
        Ok(())
    }
}

impl From<String> for Route {
    fn from(target: String) -> Self {
        Self::new(target)
    }
}

impl From<&str> for Route {
    fn from(target: &str) -> Self {
        Self::new(target)
    }
}

/// `host:port`, followed by the options in parentheses when there are any.
impl fmt::Display for Route {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.target)?;
        if let Some(version) = self.proxy_protocol {
            write!(formatter, " (proxy protocol {version})")?;
        }
        Ok(())
    }
}

impl Serialize for Route {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if !self.has_options() {
            return serializer.serialize_str(&self.target);
        }
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("target", &self.target)?;
        if let Some(version) = self.proxy_protocol {
            map.serialize_entry("proxy_protocol", version.as_str())?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Route {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(RouteVisitor)
    }
}

struct RouteVisitor;

impl<'de> Visitor<'de> for RouteVisitor {
    type Value = Route;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str(r#"a "host:port" string or a table with `target` and options"#)
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Route, E> {
        Ok(Route::new(value))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Route, A::Error> {
        let mut target: Option<String> = None;
        let mut proxy_protocol: Option<ProxyProtocol> = None;
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "target" => {
                    if target.is_some() {
                        return Err(de::Error::duplicate_field("target"));
                    }
                    target = Some(map.next_value()?);
                }
                "proxy_protocol" => {
                    if proxy_protocol.is_some() {
                        return Err(de::Error::duplicate_field("proxy_protocol"));
                    }
                    let value: String = map.next_value()?;
                    proxy_protocol = Some(ProxyProtocol::parse(&value).ok_or_else(|| {
                        de::Error::invalid_value(Unexpected::Str(&value), &r#""v1" or "v2""#)
                    })?);
                }
                other => return Err(de::Error::unknown_field(other, FIELDS)),
            }
        }
        let target = target.ok_or_else(|| de::Error::missing_field("target"))?;
        Ok(Route {
            target,
            proxy_protocol,
        })
    }
}
