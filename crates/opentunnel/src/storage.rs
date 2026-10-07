//! On-disk tunnel identities. The layout is shared with the TypeScript SDK;
//! see `docs/protocol.md`.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::identity::{Identity, PendingIdentity};
use crate::paths;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelFile {
    id: String,
    hostname: String,
    certificate_expiry: String,
}

#[derive(Serialize, Deserialize)]
struct PendingFile {
    id: String,
    hostname: String,
    csr: String,
}

#[derive(Debug, Clone)]
pub struct Storage {
    root: PathBuf,
}

impl Default for Storage {
    fn default() -> Self {
        Self::xdg()
    }
}

impl Storage {
    /// Stores identities under `$XDG_DATA_HOME/opentunnel`.
    pub fn xdg() -> Self {
        Self::at(paths::data_dir())
    }

    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn profile_dir(&self, profile: &str) -> Result<PathBuf> {
        if !crate::protocol::names::is_valid_profile(profile) {
            return Err(Error::Invalid(format!(
                "invalid profile name '{profile}': use lowercase letters, numbers, and hyphens"
            )));
        }
        Ok(self.root.join(profile))
    }

    pub fn profiles(&self) -> Result<Vec<String>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(Error::io(format!("listing {}", self.root.display()))(error)),
        };
        let mut profiles: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| crate::protocol::names::is_valid_profile(name))
            .collect();
        profiles.sort();
        Ok(profiles)
    }

    pub fn load(&self, profile: &str) -> Result<Option<Identity>> {
        let dir = self.profile_dir(profile)?;
        let Some(file) = read_json::<TunnelFile>(&dir.join("tunnel.json"))? else {
            return Ok(None);
        };
        let incomplete = || Error::Invalid(format!("incomplete tunnel identity for '{profile}'"));
        Ok(Some(Identity {
            id: file.id,
            hostname: file.hostname,
            token: read_optional(&dir.join("token"))?
                .ok_or_else(incomplete)?
                .trim()
                .to_owned(),
            private_key: read_optional(&dir.join("private-key.pem"))?.ok_or_else(incomplete)?,
            certificate: read_optional(&dir.join("certificate.pem"))?.ok_or_else(incomplete)?,
            chain: read_optional(&dir.join("chain.pem"))?.ok_or_else(incomplete)?,
            certificate_expiry: file.certificate_expiry,
        }))
    }

    pub fn load_pending(&self, profile: &str) -> Result<Option<PendingIdentity>> {
        let dir = self.profile_dir(profile)?;
        let Some(file) = read_json::<PendingFile>(&dir.join("pending.json"))? else {
            return Ok(None);
        };
        let incomplete = || {
            Error::Invalid(format!(
                "incomplete pending tunnel identity for '{profile}'"
            ))
        };
        Ok(Some(PendingIdentity {
            id: file.id,
            hostname: file.hostname,
            token: read_optional(&dir.join("token"))?
                .ok_or_else(incomplete)?
                .trim()
                .to_owned(),
            private_key: read_optional(&dir.join("private-key.pem"))?.ok_or_else(incomplete)?,
            csr: file.csr,
        }))
    }

    pub fn save_pending(&self, profile: &str, pending: &PendingIdentity) -> Result<()> {
        let dir = self.ensure_dir(profile)?;
        let metadata = PendingFile {
            id: pending.id.clone(),
            hostname: pending.hostname.clone(),
            csr: pending.csr.clone(),
        };
        write_secret(
            &dir.join("token"),
            format!("{}\n", pending.token).as_bytes(),
        )?;
        write_secret(&dir.join("private-key.pem"), pending.private_key.as_bytes())?;
        write_secret(&dir.join("pending.json"), &to_json(&metadata))
    }

    pub fn save(&self, profile: &str, identity: &Identity) -> Result<()> {
        let dir = self.ensure_dir(profile)?;
        let metadata = TunnelFile {
            id: identity.id.clone(),
            hostname: identity.hostname.clone(),
            certificate_expiry: identity.certificate_expiry.clone(),
        };
        write_secret(
            &dir.join("token"),
            format!("{}\n", identity.token).as_bytes(),
        )?;
        write_secret(
            &dir.join("private-key.pem"),
            identity.private_key.as_bytes(),
        )?;
        write_secret(
            &dir.join("certificate.pem"),
            identity.certificate.as_bytes(),
        )?;
        write_secret(&dir.join("chain.pem"), identity.chain.as_bytes())?;
        write_secret(&dir.join("tunnel.json"), &to_json(&metadata))?;
        match fs::remove_file(dir.join("pending.json")) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                Err(Error::io("removing pending.json")(error))
            }
            _ => Ok(()),
        }
    }

    pub fn remove(&self, profile: &str) -> Result<()> {
        let dir = self.profile_dir(profile)?;
        match fs::remove_dir_all(&dir) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                Err(Error::io(format!("removing {}", dir.display()))(error))
            }
            _ => Ok(()),
        }
    }

    pub fn list(&self) -> Result<Vec<(String, Identity)>> {
        let mut tunnels = Vec::new();
        for profile in self.profiles()? {
            if let Some(identity) = self.load(&profile)? {
                tunnels.push((profile, identity));
            }
        }
        Ok(tunnels)
    }

    fn ensure_dir(&self, profile: &str) -> Result<PathBuf> {
        let dir = self.profile_dir(profile)?;
        create_private_dir(&dir)?;
        Ok(dir)
    }
}

fn to_json(value: &impl Serialize) -> Vec<u8> {
    let mut json = serde_json::to_vec_pretty(value).expect("metadata serializes");
    json.push(b'\n');
    json
}

fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(Error::io(format!("reading {}", path.display()))(error)),
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    let Some(content) = read_optional(path)? else {
        return Ok(None);
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|source| Error::Corrupt {
            path: path.display().to_string(),
            source,
        })
}

pub(crate) fn create_private_dir(dir: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(dir)
        .map_err(Error::io(format!("creating {}", dir.display())))
}

/// Writes a file readable only by the current user, replacing it atomically.
pub(crate) fn write_secret(path: &Path, content: &[u8]) -> Result<()> {
    let context = || format!("writing {}", path.display());
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&temporary).map_err(Error::io(context()))?;
    file.write_all(content)
        .and_then(|()| file.sync_all())
        .map_err(Error::io(context()))?;
    fs::rename(&temporary, path).map_err(Error::io(context()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary() -> Storage {
        let root = std::env::temp_dir().join(format!(
            "opentunnel-storage-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        Storage::at(root)
    }

    #[test]
    fn pending_then_identity_round_trip() {
        let storage = temporary();
        let pending = PendingIdentity {
            id: "demo".into(),
            hostname: "demo.opentunnel.xyz".into(),
            token: "token".into(),
            private_key: "KEY".into(),
            csr: "CSR".into(),
        };
        storage.save_pending("default", &pending).unwrap();
        assert_eq!(storage.load_pending("default").unwrap(), Some(pending));
        assert_eq!(storage.load("default").unwrap(), None);

        let identity = Identity {
            id: "demo".into(),
            hostname: "demo.opentunnel.xyz".into(),
            token: "token".into(),
            private_key: "KEY".into(),
            certificate: "CERT".into(),
            chain: "CHAIN".into(),
            certificate_expiry: "2099-01-01T00:00:00.000Z".into(),
        };
        storage.save("default", &identity).unwrap();
        assert_eq!(storage.load("default").unwrap(), Some(identity));
        assert_eq!(storage.load_pending("default").unwrap(), None);
        assert_eq!(storage.profiles().unwrap(), vec!["default".to_string()]);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(storage.root().join("default")), 0o700);
            assert_eq!(mode(storage.root().join("default/token")), 0o600);
            assert_eq!(mode(storage.root().join("default/private-key.pem")), 0o600);
        }

        storage.remove("default").unwrap();
        assert!(storage.profiles().unwrap().is_empty());
        let _ = fs::remove_dir_all(storage.root());
    }

    #[test]
    fn rejects_invalid_profiles() {
        assert!(temporary().load("../etc").is_err());
    }

    #[test]
    fn generates_valid_csr() {
        let generated = crate::provision::generate("demo.opentunnel.xyz").unwrap();
        assert!(
            generated
                .private_key
                .starts_with("-----BEGIN PRIVATE KEY-----")
        );
        assert!(
            generated
                .csr
                .starts_with("-----BEGIN CERTIFICATE REQUEST-----")
        );
    }
}
