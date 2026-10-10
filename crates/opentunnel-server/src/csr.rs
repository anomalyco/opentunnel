//! Reads the names a tunnel's certificate request asks for, after checking its signature.

use x509_parser::certification_request::X509CertificationRequest;
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::prelude::FromDer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// The subject's common name.
    pub hostname: String,
    /// The DNS subject alternative names without duplicates, or the common name when there are none.
    pub identifiers: Vec<String>,
}

/// Accepts PEM or base64 DER. `None` for anything that does not parse or verify.
pub fn parse(csr: &str) -> Option<Request> {
    let der = crate::acme::pem_der(csr)?;
    let (_, request) = X509CertificationRequest::from_der(&der).ok()?;
    request.verify_signature().ok()?;
    let info = &request.certification_request_info;
    let common_names: Vec<String> = info
        .subject
        .iter_common_name()
        .filter_map(|name| name.as_str().ok().map(str::to_owned))
        .collect();
    // The Worker stringified the list of CN values, which joins them with commas.
    let hostname = common_names.join(",");
    let mut identifiers: Vec<String> = Vec::new();
    for extension in request.requested_extensions().into_iter().flatten() {
        if let ParsedExtension::SubjectAlternativeName(names) = extension {
            for name in &names.general_names {
                if let GeneralName::DNSName(name) = name
                    && !identifiers.iter().any(|existing| existing == name)
                {
                    identifiers.push((*name).to_owned());
                }
            }
        }
    }
    if identifiers.is_empty() {
        identifiers.push(hostname.clone());
    }
    Some(Request {
        hostname,
        identifiers,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A tunnel CSR as the clients make it: CN and SANs for the hostname and its wildcard.
    pub(crate) fn tunnel_csr(hostname: &str) -> (String, String) {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params =
            rcgen::CertificateParams::new(vec![hostname.into(), format!("*.{hostname}")]).unwrap();
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, hostname);
        (
            params.serialize_request(&key).unwrap().pem().unwrap(),
            key.serialize_pem(),
        )
    }

    #[test]
    fn reads_tunnel_requests() {
        let (csr, _) = tunnel_csr("abc.opentunnel.test");
        assert_eq!(
            parse(&csr),
            Some(Request {
                hostname: "abc.opentunnel.test".into(),
                identifiers: vec!["abc.opentunnel.test".into(), "*.abc.opentunnel.test".into()]
            })
        );
    }

    #[test]
    fn rejects_garbage_and_bad_signatures() {
        assert_eq!(parse("garbage"), None);
        let (csr, _) = tunnel_csr("abc.opentunnel.test");
        let mut der = crate::acme::pem_der(&csr).unwrap();
        let last = der.len() - 1;
        der[last] ^= 1;
        use base64::Engine;
        let tampered = base64::engine::general_purpose::STANDARD.encode(der);
        assert_eq!(parse(&tampered), None);
    }
}
