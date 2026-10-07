use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_ECDSA_P256_SHA256};

use crate::error::{Error, Result};

pub(crate) struct KeyAndCsr {
    pub private_key: String,
    pub csr: String,
}

/// Generates a P-256 key and a CSR covering the hostname and its subdomains.
pub(crate) fn generate(hostname: &str) -> Result<KeyAndCsr> {
    let crypto = |error: rcgen::Error| Error::Crypto(error.to_string());
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(crypto)?;
    let mut params = CertificateParams::new(vec![hostname.to_owned(), format!("*.{hostname}")])
        .map_err(crypto)?;
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, hostname);
    params.distinguished_name = name;
    let csr = params.serialize_request(&key).map_err(crypto)?;
    Ok(KeyAndCsr {
        private_key: key.serialize_pem(),
        csr: csr.pem().map_err(crypto)?,
    })
}
