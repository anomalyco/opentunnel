//! The website's static files, loaded into memory at startup. Paths resolve the way Cloudflare's static assets
//! did with default HTML handling: `/` and extensionless paths serve `.html` files, and `/index.html` or
//! `/page.html` redirect to the clean URL.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use bytes::Bytes;

pub struct Asset {
    pub body: Bytes,
    pub content_type: &'static str,
    pub etag: String,
    pub immutable: bool,
}

#[derive(Default)]
pub struct Website {
    files: HashMap<String, Asset>,
}

pub enum Resolved<'a> {
    File(&'a Asset),
    Redirect(String),
    NotFound,
}

impl Website {
    pub fn load(root: &Path) -> Result<Self> {
        let mut files = HashMap::new();
        load_dir(root, root, &mut files)?;
        Ok(Self { files })
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn resolve(&self, path: &str) -> Resolved<'_> {
        let path = path.trim_start_matches('/');
        if path.is_empty() || path.ends_with('/') {
            return match self.files.get(&format!("{path}index.html")) {
                Some(asset) => Resolved::File(asset),
                None => Resolved::NotFound,
            };
        }
        if let Some(stem) = path.strip_suffix(".html") {
            if self.files.contains_key(path) {
                let clean = match stem.strip_suffix("index") {
                    Some(directory) if directory.is_empty() || directory.ends_with('/') => {
                        format!("/{directory}")
                    }
                    _ => format!("/{stem}"),
                };
                return Resolved::Redirect(clean);
            }
            return Resolved::NotFound;
        }
        if let Some(asset) = self.files.get(path) {
            return Resolved::File(asset);
        }
        if let Some(asset) = self.files.get(&format!("{path}.html")) {
            return Resolved::File(asset);
        }
        if self.files.contains_key(&format!("{path}/index.html")) {
            return Resolved::Redirect(format!("/{path}/"));
        }
        Resolved::NotFound
    }
}

fn load_dir(root: &Path, dir: &Path, files: &mut HashMap<String, Asset>) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            load_dir(root, &path, files)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .expect("walked from the root")
            .to_string_lossy()
            .replace('\\', "/");
        let body = Bytes::from(std::fs::read(&path)?);
        let digest = ring::digest::digest(&ring::digest::SHA256, &body);
        files.insert(
            relative.clone(),
            Asset {
                content_type: content_type(&relative),
                etag: format!("\"{}\"", crate::crypto::hex(&digest.as_ref()[..16])),
                immutable: relative.starts_with("assets/"),
                body,
            },
        );
    }
    Ok(())
}

fn content_type(path: &str) -> &'static str {
    let extension = path.rsplit_once('.').map(|(_, extension)| extension);
    match extension {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        // `/install` is a shell script piped to sh.
        None => "text/plain; charset=utf-8",
        Some(_) => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site() -> (tempfile::TempDir, Website) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "home").unwrap();
        std::fs::write(dir.path().join("install"), "#!/bin/sh").unwrap();
        std::fs::write(dir.path().join("about.html"), "about").unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/app-1234.js"), "js").unwrap();
        std::fs::create_dir_all(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs/index.html"), "docs").unwrap();
        let website = Website::load(dir.path()).unwrap();
        (dir, website)
    }

    fn body(resolved: Resolved<'_>) -> String {
        match resolved {
            Resolved::File(asset) => String::from_utf8(asset.body.to_vec()).unwrap(),
            Resolved::Redirect(location) => format!("-> {location}"),
            Resolved::NotFound => "404".into(),
        }
    }

    #[test]
    fn resolves_like_cloudflare_assets() {
        let (_dir, site) = site();
        assert_eq!(body(site.resolve("/")), "home");
        assert_eq!(body(site.resolve("/index.html")), "-> /");
        assert_eq!(body(site.resolve("/install")), "#!/bin/sh");
        assert_eq!(body(site.resolve("/about")), "about");
        assert_eq!(body(site.resolve("/about.html")), "-> /about");
        assert_eq!(body(site.resolve("/docs")), "-> /docs/");
        assert_eq!(body(site.resolve("/docs/")), "docs");
        assert_eq!(body(site.resolve("/docs/index.html")), "-> /docs/");
        assert_eq!(body(site.resolve("/nope")), "404");
        let Resolved::File(asset) = site.resolve("/assets/app-1234.js") else {
            panic!()
        };
        assert!(asset.immutable);
        assert_eq!(asset.content_type, "text/javascript; charset=utf-8");
    }
}
