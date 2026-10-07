use std::fmt;

/// A provisioned tunnel: its credentials and the certificate for its hostname.
#[derive(Clone, PartialEq, Eq)]
pub struct Identity {
    pub id: String,
    pub hostname: String,
    pub token: String,
    pub private_key: String,
    pub certificate: String,
    pub chain: String,
    /// ISO-8601 timestamp.
    pub certificate_expiry: String,
}

/// A tunnel whose certificate has been requested but not issued yet.
#[derive(Clone, PartialEq, Eq)]
pub struct PendingIdentity {
    pub id: String,
    pub hostname: String,
    pub token: String,
    pub private_key: String,
    pub csr: String,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("id", &self.id)
            .field("hostname", &self.hostname)
            .field("certificate_expiry", &self.certificate_expiry)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for PendingIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingIdentity")
            .field("id", &self.id)
            .field("hostname", &self.hostname)
            .finish_non_exhaustive()
    }
}
