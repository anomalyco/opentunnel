//! The per-profile background service: keeps the profile's tunnel connected
//! to the routes in its config file.

use std::fs::{self, File, TryLockError};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use opentunnel::{Client, Identity, State, Tunnel};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::config;
use crate::control::{self, Command, DaemonStatus, Phase, Request, Response};

const RECONCILE_INTERVAL: Duration = Duration::from_secs(2);

struct Running {
    identity: Identity,
    tunnel: Tunnel,
    logger: JoinHandle<()>,
}

struct Daemon {
    client: Client,
    profile: String,
    paths: control::Paths,
    running: Option<Running>,
    provisioning: Option<JoinHandle<()>>,
    provisioning_error: Arc<Mutex<Option<String>>>,
    stopped: bool,
    last_error: Option<String>,
    config_modified: Option<SystemTime>,
    started_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub async fn serve(client: Client, profile: String) -> Result<()> {
    let paths = control::paths(&profile);
    let runtime = paths.socket.parent().expect("socket has a parent");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(runtime)
        .with_context(|| format!("creating {}", runtime.display()))?;

    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.lock)
        .with_context(|| format!("opening {}", paths.lock.display()))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            bail!("the background service is already running for profile '{profile}'")
        }
        Err(TryLockError::Error(error)) => return Err(error).context("locking service"),
    }

    let _ = fs::remove_file(&paths.socket);
    let listener = UnixListener::bind(&paths.socket)
        .with_context(|| format!("binding {}", paths.socket.display()))?;
    fs::set_permissions(&paths.socket, fs::Permissions::from_mode(0o600))?;

    let (commands, mut commands_rx) = mpsc::channel(16);
    let accept = tokio::spawn(accept_loop(listener, commands));

    let mut daemon = Daemon {
        client,
        profile,
        paths,
        running: None,
        provisioning: None,
        provisioning_error: Arc::default(),
        stopped: false,
        last_error: None,
        config_modified: None,
        started_at: now_ms(),
    };
    info!(profile = %daemon.profile, pid = std::process::id(), "service started");
    daemon.reconcile();

    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut hangup = signal(SignalKind::hangup())?;
    let mut tick = tokio::time::interval(RECONCILE_INTERVAL);

    loop {
        tokio::select! {
            Some((command, reply)) = commands_rx.recv() => {
                let response = match command {
                    Command::Status => Response { ok: true, status: Some(daemon.status()), error: None },
                    Command::Reload => {
                        daemon.stopped = false;
                        daemon.reconcile();
                        Response { ok: true, status: Some(daemon.status()), error: None }
                    }
                    Command::Stop => {
                        let _ = reply.send(Response { ok: true, status: None, error: None });
                        break;
                    }
                };
                let _ = reply.send(response);
            }
            _ = terminate.recv() => break,
            _ = interrupt.recv() => break,
            _ = hangup.recv() => daemon.reconcile(),
            _ = tick.tick() => daemon.check(),
        }
    }

    info!("service stopping");
    accept.abort();
    if let Some(running) = daemon.running.take() {
        running.logger.abort();
        let _ = running.tunnel.close().await;
    }
    if let Some(provisioning) = daemon.provisioning.take() {
        provisioning.abort();
    }
    let _ = fs::remove_file(&daemon.paths.socket);
    Ok(())
}

impl Daemon {
    fn status(&self) -> DaemonStatus {
        let phase = match (&self.running, &self.provisioning) {
            (Some(running), _) if running.tunnel.status().state == State::Stopped => Phase::Stopped,
            (Some(_), _) => Phase::Running,
            (None, Some(_)) => Phase::Provisioning,
            (None, None) if self.stopped => Phase::Stopped,
            (None, None) => Phase::NoTunnel,
        };
        DaemonStatus {
            pid: std::process::id(),
            version: env!("CARGO_PKG_VERSION").into(),
            profile: self.profile.clone(),
            phase,
            tunnel: self
                .running
                .as_ref()
                .map(|running| running.tunnel.status().into()),
            last_error: self.last_error.clone(),
            started_at: self.started_at,
        }
    }

    /// Periodic housekeeping: apply config edits, notice finished
    /// provisioning, and record fatal tunnel errors.
    fn check(&mut self) {
        let provisioning_error = self.provisioning_error.lock().expect("lock").take();
        if let Some(error) = provisioning_error {
            self.record_error(error);
        }
        if self
            .provisioning
            .as_ref()
            .is_some_and(|task| task.is_finished())
        {
            self.provisioning = None;
            self.reconcile();
        }
        if let Some(running) = &self.running {
            let status = running.tunnel.status();
            if status.state == State::Stopped {
                let running = self.running.take().expect("running");
                running.logger.abort();
                self.stopped = true;
                self.record_error(status.last_error.unwrap_or_else(|| "tunnel stopped".into()));
                return;
            }
        }
        if !self.stopped && config::modified(&self.profile) != self.config_modified {
            info!("config changed");
            self.reconcile();
        }
    }

    fn reconcile(&mut self) {
        if let Err(error) = self.try_reconcile() {
            self.record_error(format!("{error:#}"));
        }
    }

    fn try_reconcile(&mut self) -> Result<()> {
        self.config_modified = config::modified(&self.profile);
        let Some(identity) = self.client.get(&self.profile)? else {
            if let Some(running) = self.running.take() {
                running.logger.abort();
            }
            if self.provisioning.is_none() && self.client.pending(&self.profile)?.is_some() {
                self.start_provisioning();
            }
            return Ok(());
        };
        let routes = config::load(&self.profile)?.routes;
        // Renewed certificates are applied by the tunnel itself, so only a
        // different tunnel requires a restart.
        if let Some(running) = &self.running
            && running.identity.id == identity.id
            && running.identity.token == identity.token
        {
            running.tunnel.set_routes(routes)?;
            return Ok(());
        }
        if let Some(running) = self.running.take() {
            running.logger.abort();
        }
        info!(hostname = %identity.hostname, routes = routes.len(), "starting tunnel");
        let tunnel = self.client.connect(&self.profile, routes)?;
        let mut events = tunnel.subscribe();
        let logger = tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => info!(event = %serde_json::to_string(&event).unwrap_or_default()),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });
        self.stopped = false;
        self.running = Some(Running {
            identity,
            tunnel,
            logger,
        });
        Ok(())
    }

    fn start_provisioning(&mut self) {
        info!("resuming pending certificate verification");
        let client = self.client.clone();
        let profile = self.profile.clone();
        let errors = self.provisioning_error.clone();
        self.provisioning = Some(tokio::spawn(async move {
            match client.resume(&profile, |_| {}).await {
                Ok(_) => info!("certificate ready"),
                Err(error) => {
                    warn!(%error, "provisioning failed");
                    *errors.lock().expect("lock") = Some(error.to_string());
                }
            }
        }));
    }

    fn record_error(&mut self, message: String) {
        error!(error = %message);
        let record = serde_json::json!({ "time": now_ms(), "message": message });
        if let Some(parent) = self.paths.last_error.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&self.paths.last_error, format!("{record}\n"));
        self.last_error = Some(message);
    }
}

type Commands = mpsc::Sender<(Command, oneshot::Sender<Response>)>;

async fn accept_loop(listener: UnixListener, commands: Commands) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let commands = commands.clone();
        tokio::spawn(async move {
            let _ = handle(stream, commands).await;
        });
    }
}

async fn handle(stream: UnixStream, commands: Commands) -> Result<()> {
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    BufReader::new(read.take(4096)).read_line(&mut line).await?;
    let response = match serde_json::from_str::<Request>(&line) {
        Ok(request) => {
            let (reply, response) = oneshot::channel();
            commands.send((request.command, reply)).await?;
            response.await?
        }
        Err(error) => Response {
            ok: false,
            status: None,
            error: Some(format!("invalid request: {error}")),
        },
    };
    let mut body = serde_json::to_vec(&response)?;
    body.push(b'\n');
    write.write_all(&body).await?;
    write.shutdown().await?;
    Ok(())
}
