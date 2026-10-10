//! Identifiers and tokens, generated exactly as the Worker generated them.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::{SecureRandom, SystemRandom};

const SLUG_ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system random number generator is available");
    bytes
}

pub fn base64url(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

pub fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(value.trim_end_matches('=')).ok()
}

/// A tunnel ID: 12 random base32 characters.
pub fn slug() -> String {
    random_bytes::<12>()
        .iter()
        .map(|byte| SLUG_ALPHABET[(byte & 31) as usize] as char)
        .collect()
}

/// A bearer token, `rly_` and 32 random bytes in base64url.
pub fn token() -> String {
    format!("rly_{}", base64url(&random_bytes::<32>()))
}

/// The stored form of a token: lowercase hex SHA-256.
pub fn hash_token(token: &str) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, token.as_bytes()).as_ref())
}

/// Whether `token` hashes to `hash`, compared in constant time.
pub fn token_matches(token: &str, hash: &str) -> bool {
    let actual = hash_token(token);
    actual.len() == hash.len()
        && actual
            .bytes()
            .zip(hash.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

pub fn hex(data: &[u8]) -> String {
    data.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A random (version 4) UUID, as `crypto.randomUUID()` formats it.
pub fn uuid() -> String {
    let mut bytes = random_bytes::<16>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_the_worker() {
        // sha256("token") in hex, as crypto.subtle.digest produced it.
        assert_eq!(
            hash_token("token"),
            "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0"
        );
        assert!(token_matches("token", &hash_token("token")));
        assert!(!token_matches("other", &hash_token("token")));
    }

    #[test]
    fn generates_identifiers() {
        let slug = slug();
        assert_eq!(slug.len(), 12);
        assert!(slug.bytes().all(|byte| SLUG_ALPHABET.contains(&byte)));
        let token = token();
        assert!(token.starts_with("rly_") && token.len() == 4 + 43);
        let uuid = uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4");
    }
}
