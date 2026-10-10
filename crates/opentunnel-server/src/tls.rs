//! TLS for the API domain only: tenant TLS is never terminated here.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};

use anyhow::{Result, anyhow};
use rustls::crypto::ring::sign::any_supported_type;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

/// The API domain's current certificate, swapped in place when it renews.
#[derive(Default)]
pub struct ServerCertificate {
    current: RwLock<Option<Arc<CertifiedKey>>>,
}

impl std::fmt::Debug for ServerCertificate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ServerCertificate")
    }
}

impl ServerCertificate {
    pub fn install(&self, chain_pem: &str, key_pem: &str) -> Result<()> {
        let chain = CertificateDer::pem_slice_iter(chain_pem.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| anyhow!("invalid certificate chain: {error}"))?;
        anyhow::ensure!(!chain.is_empty(), "certificate chain is empty");
        let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes())
            .map_err(|error| anyhow!("invalid private key: {error}"))?;
        let key = any_supported_type(&key).map_err(|error| anyhow!("unsupported key: {error}"))?;
        *self.current.write().expect("certificate lock") =
            Some(Arc::new(CertifiedKey::new(chain, key)));
        Ok(())
    }

    pub fn is_installed(&self) -> bool {
        self.current.read().expect("certificate lock").is_some()
    }
}

impl ResolvesServerCert for ServerCertificate {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.current.read().expect("certificate lock").clone()
    }
}

pub fn acceptor(certificate: Arc<ServerCertificate>) -> tokio_rustls::TlsAcceptor {
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("ring supports the default protocol versions")
    .with_no_client_auth()
    .with_cert_resolver(certificate);
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    tokio_rustls::TlsAcceptor::from(Arc::new(config))
}

/// A TCP stream that first replays bytes already read from it (the ClientHello).
pub struct Replay {
    prefix: Vec<u8>,
    position: usize,
    inner: TcpStream,
}

impl Replay {
    pub fn new(prefix: Vec<u8>, inner: TcpStream) -> Self {
        Self {
            prefix,
            position: 0,
            inner,
        }
    }
}

impl AsyncRead for Replay {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.position < self.prefix.len() {
            let remaining = &self.prefix[self.position..];
            let count = remaining.len().min(buffer.remaining());
            buffer.put_slice(&remaining[..count]);
            self.position += count;
            if self.position == self.prefix.len() {
                self.prefix = Vec::new();
                self.position = 0;
            }
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}

impl AsyncWrite for Replay {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(context, data)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(context, buffers)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}
