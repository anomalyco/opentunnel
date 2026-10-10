//! Background work that replaces the certificate Workflow and the Durable Object alarms: durable issuance jobs
//! (resumed after a restart), renewal alarms, the sweep for silent bridges, and the API domain's certificate.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use opentunnel::protocol::api::CertificateState;
use tokio::task::JoinSet;
use tracing::{error, info, warn};

use crate::acme::Challenge;
use crate::clock::{DAY_MS, HOUR_MS, MINUTE_MS};
use crate::crypto::uuid;
use crate::issuer::Issuer;
use crate::service::{RENEW_BEFORE_MS, Service};
use crate::store::{Job, JobKind, LEASE_MS, ServerCertificate};
use crate::tls;

/// Attempts per job, like the Workflow step's two retries.
pub const ATTEMPTS: u32 = 3;
const PERSIST_FAILED: &str = "Failed to persist certificate state: tunnel or certificate not found";
/// Imported issuance gets this long to finish on the Worker before this server takes it over.
pub const ORPHAN_GRACE_MS: u64 = 15 * MINUTE_MS;

pub struct Jobs {
    pub service: Service,
    pub issuer: Arc<Issuer>,
    pub concurrency: usize,
    /// Delay before the second attempt; it doubles for each one after.
    pub retry_delay_ms: u64,
    pub server: Option<Arc<ServerCertificates>>,
    /// This process's name on job leases.
    pub owner: String,
    running: Mutex<HashSet<String>>,
}

/// The lease owner for this process: the Fly machine ID, which survives restarts so a restarted server takes
/// its own jobs back at once, or a random name.
pub fn lease_owner() -> String {
    std::env::var("FLY_MACHINE_ID")
        .ok()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("process-{}", uuid()))
}

impl Jobs {
    pub fn new(
        service: Service,
        issuer: Arc<Issuer>,
        concurrency: usize,
        retry_delay_ms: u64,
        server: Option<Arc<ServerCertificates>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            service,
            issuer,
            concurrency: concurrency.max(1),
            retry_delay_ms,
            server,
            owner: lease_owner(),
            running: Mutex::new(HashSet::new()),
        })
    }

    /// Runs due jobs forever, `concurrency` at a time.
    pub async fn run(self: Arc<Self>) {
        let mut tasks = JoinSet::new();
        loop {
            if let Err(error) = self.start_due(&mut tasks).await {
                error!(%error, "failed to start certificate jobs");
            }
            let wait = match self.service.store.next_job_at().await {
                Ok(Some(at)) => {
                    Duration::from_millis(at.saturating_sub(self.service.now()).min(30_000))
                }
                _ => Duration::from_secs(30),
            };
            tokio::select! {
                _ = tokio::time::sleep(wait.max(Duration::from_millis(50))) => {}
                _ = self.service.jobs.notified() => {}
                Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            }
        }
    }

    async fn start_due(self: &Arc<Self>, tasks: &mut JoinSet<()>) -> Result<()> {
        let running = self.running.lock().expect("running lock").len();
        if running >= self.concurrency {
            return Ok(());
        }
        let store = &self.service.store;
        let due = store
            .due_job_ids(&self.owner, self.service.now(), self.concurrency + running)
            .await?;
        for id in due {
            if self.running.lock().expect("running lock").len() >= self.concurrency {
                break;
            }
            if !self
                .running
                .lock()
                .expect("running lock")
                .insert(id.clone())
            {
                continue;
            }
            // Another server may have taken it since it was listed.
            let job = match store.claim_job(&id, &self.owner, self.service.now()).await {
                Ok(Some(job)) => job,
                Ok(None) => {
                    self.running.lock().expect("running lock").remove(&id);
                    continue;
                }
                Err(error) => {
                    self.running.lock().expect("running lock").remove(&id);
                    return Err(error);
                }
            };
            let jobs = self.clone();
            tasks.spawn(async move {
                let id = job.certificate_id.clone();
                if let Err(error) = jobs.execute(job).await {
                    error!(%error, certificate = %id, "certificate job failed to record its result");
                }
                jobs.running.lock().expect("running lock").remove(&id);
                jobs.service.jobs.notify_one();
            });
        }
        Ok(())
    }

    /// Gives up this process's job leases, on shutdown.
    pub async fn release(&self) {
        if let Err(error) = self.service.store.release_leases(&self.owner).await {
            warn!(%error, "releasing job leases failed");
        }
    }

    /// Runs every due job to completion, for tests.
    pub async fn run_due(self: &Arc<Self>) -> Result<usize> {
        let due = self
            .service
            .store
            .claim_due_jobs(&self.owner, self.service.now(), 100)
            .await?;
        let count = due.len();
        for job in due {
            self.execute(job).await?;
        }
        Ok(count)
    }

    /// One attempt of a job, and what follows from it.
    async fn execute(&self, job: Job) -> Result<()> {
        let service = &self.service;
        let tunnel = job.tunnel_id.clone();
        let certificate_id = job.certificate_id.clone();
        let kind = job.kind;
        let owner = &self.owner;
        let issue = self
            .issuer
            .issue(&job.identifiers, &job.csr, async |challenge: Challenge| {
                // Only first issuance shows the challenge; a renewal keeps showing the current certificate.
                if kind != JobKind::Issue {
                    return Ok(());
                }
                let Some(tunnel) = &tunnel else { return Ok(()) };
                let state = CertificateState::Challenge {
                    token: challenge.token,
                    key: challenge.key,
                };
                if !service
                    .update_certificate(tunnel, &certificate_id, state)
                    .await?
                {
                    anyhow::bail!(PERSIST_FAILED);
                }
                Ok(())
            });
        // Keep the lease while the order runs, so no other server takes the job over.
        tokio::pin!(issue);
        let mut renew = tokio::time::interval(Duration::from_millis(LEASE_MS / 3));
        renew.tick().await;
        let result = loop {
            tokio::select! {
                result = &mut issue => break result,
                _ = renew.tick() => {
                    match service.store.extend_lease(&job.certificate_id, owner, service.now()).await {
                        Ok(true) => {}
                        Ok(false) => warn!(certificate = %job.certificate_id, "lost the lease on a certificate job"),
                        Err(error) => warn!(%error, certificate = %job.certificate_id, "extending a job lease failed"),
                    }
                }
            }
        };
        // A server that lost its lease (it could not extend it in time) leaves the results to the one that
        // took the job over.
        if let Ok(false) = service
            .store
            .extend_lease(&job.certificate_id, owner, service.now())
            .await
        {
            warn!(certificate = %job.certificate_id, "lost the lease on a certificate job; not recording its result");
            return Ok(());
        }
        let now = service.now();
        match result {
            Ok(issued) => {
                match (&job.kind, &job.tunnel_id) {
                    (JobKind::Server, _) => {
                        if let Some(server) = &self.server {
                            server.installed(&job, &issued).await?;
                        }
                    }
                    (_, Some(tunnel)) => {
                        let state = CertificateState::Ready {
                            certificate: issued.certificate,
                            chain: issued.chain,
                            expiry: issued.expiry,
                        };
                        if !service
                            .update_certificate(tunnel, &job.certificate_id, state)
                            .await?
                        {
                            warn!(tunnel, certificate = %job.certificate_id, "issued certificate is no longer wanted");
                        }
                    }
                    (_, None) => {}
                }
                service
                    .store
                    .finish_job(&job.certificate_id, owner, "done", None, now)
                    .await
                    .map(drop)
            }
            Err(error) => {
                let reason = format!("{error:#}");
                warn!(certificate = %job.certificate_id, attempt = job.attempts + 1, %reason, "certificate issuance attempt failed");
                let attempts = job.attempts + 1;
                if reason.contains(PERSIST_FAILED) {
                    // The tunnel was deleted or issued another certificate meanwhile.
                    return service
                        .store
                        .finish_job(&job.certificate_id, owner, "failed", Some(reason), now)
                        .await
                        .map(drop);
                }
                if attempts < ATTEMPTS {
                    let delay = self.retry_delay_ms * (1 << (attempts - 1));
                    return service
                        .store
                        .retry_job(
                            &job.certificate_id,
                            owner,
                            attempts,
                            now + delay,
                            reason,
                            now,
                        )
                        .await
                        .map(drop);
                }
                if let (JobKind::Issue | JobKind::Renew, Some(tunnel)) = (&job.kind, &job.tunnel_id)
                {
                    let state = CertificateState::Failed {
                        reason: reason.clone(),
                    };
                    service
                        .update_certificate(tunnel, &job.certificate_id, state)
                        .await?;
                }
                service
                    .store
                    .finish_job(&job.certificate_id, owner, "failed", Some(reason), now)
                    .await
                    .map(drop)
            }
        }
    }
}

/// Fires due renewal alarms. Returns how many fired.
pub async fn fire_due_alarms(service: &Service) -> Result<usize> {
    let due = service.store.take_due_alarms(service.now()).await?;
    for id in &due {
        if let Err(error) = service.alarm(id).await {
            // Like a Durable Object alarm that throws: try again shortly.
            error!(%error, tunnel = %id, "renewal alarm failed");
            service
                .store
                .set_alarm(id, Some(service.now() + MINUTE_MS))
                .await?;
        }
    }
    Ok(due.len())
}

pub async fn run_alarms(service: Service) {
    loop {
        if let Err(error) = fire_due_alarms(&service).await {
            error!(%error, "renewal alarms failed");
        }
        let wait = match service.store.next_alarm().await {
            Ok(Some(at)) => Duration::from_millis(at.saturating_sub(service.now()).min(60_000)),
            _ => Duration::from_secs(60),
        };
        tokio::select! {
            _ = tokio::time::sleep(wait.max(Duration::from_millis(100))) => {}
            _ = service.alarms.notified() => {}
        }
    }
}

pub async fn run_sweeper(service: Service) {
    let mut interval = tokio::time::interval(Duration::from_millis(
        opentunnel::protocol::bridge::HEARTBEAT_MS,
    ));
    loop {
        interval.tick().await;
        if let Err(error) = service.sweep().await {
            error!(%error, "bridge sweep failed");
        }
    }
}

pub async fn run_reconcile(service: Service) {
    let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
    loop {
        interval.tick().await;
        match service.resume_orphaned_issuance(ORPHAN_GRACE_MS).await {
            Ok(0) => {}
            Ok(resumed) => info!(resumed, "resumed certificate issuance without a job"),
            Err(error) => error!(%error, "resuming certificate issuance failed"),
        }
    }
}

/// The API domain's own certificate: issued through the same jobs, renewed 30 days before expiry, and served
/// from memory.
pub struct ServerCertificates {
    pub service: Service,
    pub name: String,
    pub resolver: Arc<tls::ServerCertificate>,
}

impl ServerCertificates {
    /// Serves the stored certificate, if any.
    pub async fn load(&self) -> Result<()> {
        if let Some(stored) = self.service.store.server_certificate(&self.name).await?
            && let (Some(certificate), Some(chain)) = (&stored.certificate, &stored.chain)
        {
            self.resolver
                .install(&format!("{certificate}\n{chain}"), &stored.private_key)?;
            info!(domain = %self.name, expiry = ?stored.expiry, "serving the stored certificate");
        }
        Ok(())
    }

    /// Starts issuance when there is no certificate or it is due for renewal and no job is pending.
    pub async fn ensure(&self) -> Result<()> {
        let store = &self.service.store;
        let now = self.service.now();
        let stored = store.server_certificate(&self.name).await?;
        let due = stored
            .as_ref()
            .and_then(|stored| stored.expiry.as_deref())
            .and_then(crate::clock::parse_iso)
            .is_none_or(|expiry| expiry.saturating_sub(RENEW_BEFORE_MS) <= now);
        if !due {
            return Ok(());
        }
        let job_key = format!("server_job:{}", self.name);
        let previous = store.meta(&job_key).await?;
        if let Some(job) = &previous
            && store.job_pending(job).await?
        {
            return Ok(());
        }
        let stored = match stored {
            Some(stored) => stored,
            None => {
                let key = rcgen::KeyPair::generate()?;
                let mut params = rcgen::CertificateParams::new(vec![self.name.clone()])?;
                params
                    .distinguished_name
                    .push(rcgen::DnType::CommonName, self.name.clone());
                let csr = params.serialize_request(&key)?.pem()?;
                let created = ServerCertificate {
                    private_key: key.serialize_pem(),
                    csr,
                    certificate: None,
                    chain: None,
                    expiry: None,
                };
                // Another server sharing the database may have stored one first; everyone uses that one.
                store
                    .create_server_certificate(&self.name, created, now)
                    .await?
            }
        };
        let id = format!("server_{}", uuid());
        if !store.swap_meta(&job_key, previous.as_deref(), &id).await? {
            // Another server requested it meanwhile.
            return Ok(());
        }
        store
            .add_job(
                Job {
                    certificate_id: id.clone(),
                    tunnel_id: None,
                    kind: JobKind::Server,
                    identifiers: vec![self.name.clone()],
                    csr: stored.csr,
                    attempts: 0,
                    created_at: now,
                },
                now,
            )
            .await?;
        self.service.jobs.notify_one();
        info!(domain = %self.name, "requested a certificate for the API domain");
        Ok(())
    }

    async fn installed(&self, job: &Job, issued: &crate::acme::Issued) -> Result<()> {
        let store = &self.service.store;
        let Some(stored) = store.server_certificate(&self.name).await? else {
            return Ok(());
        };
        if stored.csr != job.csr {
            return Ok(());
        }
        self.resolver.install(
            &format!("{}\n{}", issued.certificate, issued.chain),
            &stored.private_key,
        )?;
        store
            .save_server_certificate(
                &self.name,
                ServerCertificate {
                    certificate: Some(issued.certificate.clone()),
                    chain: Some(issued.chain.clone()),
                    expiry: Some(issued.expiry.clone()),
                    ..stored
                },
                self.service.now(),
            )
            .await?;
        info!(domain = %self.name, expiry = %issued.expiry, "installed a new certificate for the API domain");
        Ok(())
    }

    pub async fn run(self: Arc<Self>) {
        loop {
            // Another machine may have issued or renewed it.
            if let Err(error) = self.load().await {
                error!(%error, "loading the API domain certificate failed");
            }
            if let Err(error) = self.ensure().await {
                error!(%error, "ensuring the API domain certificate failed");
            }
            // Hourly, which also spaces out retries after a failed issuance; often while there is none.
            let wait = if self.resolver.is_installed() {
                HOUR_MS.min(DAY_MS)
            } else {
                10_000
            };
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }
    }
}
