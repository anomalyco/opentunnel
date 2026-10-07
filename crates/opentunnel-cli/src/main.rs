#[cfg(not(unix))]
compile_error!("opentunnel-cli currently supports Unix platforms only");

mod config;
mod control;
mod daemon;
mod service;

use std::io::{IsTerminal, Write};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use opentunnel::protocol::names;
use opentunnel::{Client, ClientOptions, ProvisionStage};

use crate::control::{DaemonStatus, Phase};

#[derive(Parser)]
#[command(
    name = "opentunnel",
    version,
    about = "Create and manage blind TLS tunnels"
)]
struct Cli {
    /// Profile name. Each profile owns one tunnel.
    #[arg(
        long,
        global = true,
        default_value = "default",
        env = "OPENTUNNEL_PROFILE"
    )]
    profile: String,

    /// API base URL.
    #[arg(long, global = true, env = "OPENTUNNEL_API", hide = true)]
    api: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Connect this device: create the tunnel if needed and run the service,
    /// starting it at login where systemd or launchd is available.
    Up,
    /// Disconnect: stop the service and stop starting it at login.
    Down,
    /// Show the tunnel, its routes, and the connection.
    Status,
    /// Manage subdomain routes.
    #[command(subcommand)]
    Route(RouteCommand),
    /// Run the service in the foreground (containers, debugging).
    Serve,
    /// Delete the tunnel for good, losing its hostname.
    Delete {
        /// Confirm deletion.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum RouteCommand {
    /// Add or replace a route and bring the tunnel up. Use `@` for the tunnel
    /// hostname itself; the target is a port or host:port.
    Add { name: String, target: String },
    /// Remove a route.
    Remove { name: String },
    /// List routes.
    List,
}

fn main() -> Result<()> {
    // Exit quietly when stdout closes early (for example `opentunnel info | head`).
    // SAFETY: restoring the default SIGPIPE handler before any threads start.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let cli = Cli::parse();
    let daemon = matches!(cli.command, Commands::Serve);
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| if daemon { "info" } else { "warn" }.into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .init();
    tokio::runtime::Runtime::new()?.block_on(run(cli))
}

async fn run(cli: Cli) -> Result<()> {
    if !names::is_valid_profile(&cli.profile) {
        bail!("profile names must contain only lowercase letters, numbers, and hyphens");
    }
    let api = cli.api.as_deref();
    let client = Client::new(ClientOptions {
        api: api
            .map(|api| api.parse().context("invalid --api URL"))
            .transpose()?,
        storage: None,
    });
    let profile = cli.profile.as_str();

    match cli.command {
        Commands::Up => {
            let hostname = up(&client, profile, api).await?;
            println!("Connected https://{hostname}");
            if config::load(profile)?.routes.is_empty() {
                println!("Add a route with: opentunnel route add <name> <port>");
            }
            Ok(())
        }
        Commands::Down => {
            if service::down(profile).await? {
                println!("Disconnected profile {profile}.");
            } else {
                println!("Profile {profile} is not connected.");
            }
            Ok(())
        }
        Commands::Status => status(&client, profile).await,
        Commands::Route(command) => route(&client, profile, command, api).await,
        Commands::Serve => daemon::serve(client, profile.to_owned()).await,
        Commands::Delete { yes } => {
            if !yes {
                bail!("this deletes the tunnel and its hostname; rerun with --yes to confirm");
            }
            service::down(profile).await?;
            client.remove(profile).await?;
            println!("Deleted the tunnel for profile {profile}.");
            Ok(())
        }
    }
}

/// Ensures the profile has a tunnel and the service is running. Returns the hostname.
async fn up(client: &Client, profile: &str, api: Option<&str>) -> Result<String> {
    let identity = match client.get(profile)? {
        Some(identity) => identity,
        None => create(client, profile).await?,
    };
    service::up(profile, api).await?;
    Ok(identity.hostname)
}

async fn create(client: &Client, profile: &str) -> Result<opentunnel::Identity> {
    let waiting = std::cell::Cell::new(false);
    let progress = |stage: ProvisionStage| {
        let mut stdout = std::io::stdout();
        if stage == ProvisionStage::WaitingCertificate {
            if waiting.replace(true) {
                print!(".");
            } else {
                print!("Waiting for certificate verification (this can take a few minutes)...");
            }
            let _ = stdout.flush();
            return;
        }
        if waiting.replace(false) {
            println!();
        }
        let message = match stage {
            ProvisionStage::CreatingTunnel => "Creating tunnel...",
            ProvisionStage::GeneratingKey => "Generating private key...",
            ProvisionStage::GeneratingCsr => "Generating certificate request...",
            ProvisionStage::ResumingCertificate => "Resuming pending certificate verification...",
            ProvisionStage::RequestingCertificate => "Requesting certificate...",
            ProvisionStage::SavingIdentity => "Saving tunnel identity...",
            ProvisionStage::Ready => "Tunnel is ready.",
            ProvisionStage::WaitingCertificate => unreachable!(),
        };
        println!("{message}");
    };
    let identity = client.create(profile, progress).await;
    if waiting.get() {
        println!();
    }
    identity.map_err(Into::into)
}

async fn status(client: &Client, profile: &str) -> Result<()> {
    println!("Profile: {profile}");
    let hostname = if let Some(identity) = client.get(profile)? {
        println!("Tunnel ID: {}", identity.id);
        println!("Hostname: {}", identity.hostname);
        println!("Certificate expiry: {}", identity.certificate_expiry);
        Some(identity.hostname)
    } else if let Some(pending) = client.pending(profile)? {
        println!("Tunnel ID: {}", pending.id);
        println!("Hostname: {}", pending.hostname);
        println!("Status: waiting for certificate verification");
        Some(pending.hostname)
    } else {
        println!("No tunnel exists for this profile. Create one with: opentunnel up");
        None
    };
    println!();
    print_routes(profile, hostname.as_deref())?;
    println!();
    print_service(profile, service::status(profile).await.as_ref());
    Ok(())
}

fn print_routes(profile: &str, hostname: Option<&str>) -> Result<()> {
    let routes = config::load(profile)?.routes;
    if routes.is_empty() {
        println!("No routes configured.");
        return Ok(());
    }
    let display: Vec<(String, &String)> = routes
        .iter()
        .map(|(name, target)| {
            let public = match hostname {
                Some(hostname) => config::public_hostname(name, hostname),
                None => name.clone(),
            };
            (public, target)
        })
        .collect();
    let width = display
        .iter()
        .map(|(public, _)| public.len())
        .max()
        .unwrap_or(0);
    for (public, target) in display {
        println!("{public:width$}  →  {target}");
    }
    Ok(())
}

fn print_service(profile: &str, status: Option<&DaemonStatus>) {
    let Some(status) = status else {
        println!("Service: stopped (connect with: opentunnel up)");
        return;
    };
    let phase = match status.phase {
        Phase::NoTunnel => "running, waiting for a tunnel".to_owned(),
        Phase::Provisioning => "running, waiting for certificate verification".to_owned(),
        Phase::Stopped => "running, tunnel stopped after an error".to_owned(),
        Phase::Running => match &status.tunnel {
            Some(tunnel) => match tunnel.state.as_str() {
                "connected" => format!("connected, {} active connection(s)", tunnel.connections),
                "waiting-routes" => "running, waiting for routes".to_owned(),
                state => state.replace('-', " "),
            },
            None => "running".to_owned(),
        },
    };
    println!("Service: {phase} (pid {}, profile {profile})", status.pid);
    println!("Log: {}", control::paths(profile).log.display());
    if let Some(error) = status
        .tunnel
        .as_ref()
        .and_then(|tunnel| tunnel.last_error.as_ref())
        .or(status.last_error.as_ref())
    {
        println!("Last error: {error}");
    }
}

async fn route(
    client: &Client,
    profile: &str,
    command: RouteCommand,
    api: Option<&str>,
) -> Result<()> {
    let hostname = client.get(profile)?.map(|identity| identity.hostname);
    let public = |name: &str| match &hostname {
        Some(hostname) => config::public_hostname(name, hostname),
        None => name.to_owned(),
    };
    match command {
        RouteCommand::Add { name, target } => {
            let target = config::normalize_target(&target);
            config::validate(&name, &target)?;
            let mut config = config::load(profile)?;
            config.routes.insert(name.clone(), target.clone());
            config::save(profile, &config)?;
            let hostname = up(client, profile, api).await?;
            println!("Added route {name} → {target}");
            println!("https://{}", config::public_hostname(&name, &hostname));
        }
        RouteCommand::Remove { name } => {
            let mut config = config::load(profile)?;
            if config.routes.remove(&name).is_none() {
                bail!("no route named '{name}' in profile {profile}");
            }
            config::save(profile, &config)?;
            service::reload_if_running(profile).await?;
            println!("Removed route {}", public(&name));
        }
        RouteCommand::List => print_routes(profile, hostname.as_deref())?,
    }
    Ok(())
}
