//! Who signs certificates: an ACME CA (ZeroSSL in production, Pebble in tests), or a local test CA that signs
//! requests directly for development and end-to-end tests.

use anyhow::{Context, Result, anyhow};
use time::OffsetDateTime;

use crate::acme::{Acme, Challenge, Issued, chain_from_pem};
use crate::store::Store;

pub enum Issuer {
    Acme(Acme),
    Local(LocalCa),
}

impl Issuer {
    pub async fn issue(
        &self,
        identifiers: &[String],
        csr: &str,
        on_challenge: impl AsyncFnOnce(Challenge) -> Result<()>,
    ) -> Result<Issued> {
        match self {
            Self::Acme(acme) => acme.issue(identifiers, csr, on_challenge).await,
            Self::Local(ca) => ca.sign(identifiers, csr),
        }
    }
}

/// An insecure certificate authority whose key lives in the database. Never use it in production: anyone with
/// the database can mint certificates its clients trust.
pub struct LocalCa {
    key: rcgen::KeyPair,
    certificate_pem: String,
    validity_days: u32,
}

impl LocalCa {
    /// Loads the CA from the store, creating it on first use.
    pub async fn load(store: &Store, validity_days: u32) -> Result<Self> {
        let existing = (
            store.meta("test_ca_key").await?,
            store.meta("test_ca_certificate").await?,
        );
        let (key_pem, certificate_pem) = match existing {
            (Some(key), Some(certificate)) => (key, certificate),
            _ => {
                let key = rcgen::KeyPair::generate()?;
                let mut params = rcgen::CertificateParams::new(Vec::<String>::new())?;
                params
                    .distinguished_name
                    .push(rcgen::DnType::CommonName, "OpenTunnel insecure test CA");
                params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
                params.key_usages = vec![
                    rcgen::KeyUsagePurpose::KeyCertSign,
                    rcgen::KeyUsagePurpose::CrlSign,
                    rcgen::KeyUsagePurpose::DigitalSignature,
                ];
                let certificate = params.self_signed(&key)?;
                let pair = (key.serialize_pem(), certificate.pem());
                store.set_meta("test_ca_key", &pair.0).await?;
                store.set_meta("test_ca_certificate", &pair.1).await?;
                pair
            }
        };
        Ok(Self {
            key: rcgen::KeyPair::from_pem(&key_pem)?,
            certificate_pem,
            validity_days,
        })
    }

    pub fn certificate_pem(&self) -> &str {
        &self.certificate_pem
    }

    fn sign(&self, identifiers: &[String], csr: &str) -> Result<Issued> {
        let issuer = rcgen::Issuer::from_ca_cert_pem(&self.certificate_pem, &self.key)?;
        let mut request = rcgen::CertificateSigningRequestParams::from_pem(csr)
            .map_err(|error| anyhow!("ACME order ended in invalid: {error}"))?;
        let now = OffsetDateTime::now_utc();
        request.params.not_before = now - time::Duration::minutes(5);
        request.params.not_after = now + time::Duration::days(self.validity_days.into());
        request.params.subject_alt_names = identifiers
            .iter()
            .map(|name| rcgen::SanType::DnsName(name.clone().try_into().expect("valid DNS names")))
            .collect();
        let mut serial = crate::crypto::random_bytes::<16>();
        serial[0] &= 0x7f;
        request.params.serial_number = Some(rcgen::SerialNumber::from_slice(&serial));
        let certificate = request.signed_by(&issuer).context("signing the request")?;
        chain_from_pem(&format!("{}\n{}", certificate.pem(), self.certificate_pem))
    }
}
