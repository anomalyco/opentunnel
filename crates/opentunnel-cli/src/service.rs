//! The background service: registering it with the OS, starting and stopping
//! it, and talking to it over its control socket.

use std::fs;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command as Process, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::control::{self, Command, DaemonStatus, Request, Response};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

pub async fn request(profile: &str, command: Command) -> Result<Response> {
    let socket = control::paths(profile).socket;
    let exchange = async {
        let mut stream = UnixStream::connect(&socket).await?;
        let mut body = serde_json::to_vec(&Request { command })?;
        body.push(b'\n');
        stream.write_all(&body).await?;
        let mut response = String::new();
        stream.read_to_string(&mut response).await?;
        Ok::<_, anyhow::Error>(serde_json::from_str::<Response>(&response)?)
    };
    let response = tokio::time::timeout(REQUEST_TIMEOUT, exchange)
        .await
        .context("background service did not respond")??;
    if !response.ok {
        bail!(response.error.unwrap_or_else(|| "request failed".into()));
    }
    Ok(response)
}

/// The running service's status, or `None` when it is not running.
pub async fn status(profile: &str) -> Option<DaemonStatus> {
    request(profile, Command::Status).await.ok()?.status
}

/// Starts the service in the background unless it is already running.
/// Returns whether it was started.
async fn ensure_running(profile: &str, api: Option<&str>) -> Result<bool> {
    if status(profile).await.is_some() {
        return Ok(false);
    }
    let paths = control::paths(profile);
    let log_dir = paths.log.parent().expect("log has a parent");
    fs::create_dir_all(log_dir).with_context(|| format!("creating {}", log_dir.display()))?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)
        .with_context(|| format!("opening {}", paths.log.display()))?;

    let mut command = Process::new(std::env::current_exe()?);
    command.args(["--profile", profile]);
    if let Some(api) = api {
        command.args(["--api", api]);
    }
    command
        .arg("serve")
        .env("OPENTUNNEL_DAEMON", "1")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0);
    command.spawn().context("starting background service")?;
    wait_until_running(profile).await.map(|()| true)
}

async fn wait_until_running(profile: &str) -> Result<()> {
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if status(profile).await.is_some() {
            return Ok(());
        }
    }
    bail!(
        "background service did not start; see {}",
        control::paths(profile).log.display()
    )
}

/// Starts the service and registers it with the OS (systemd on Linux, launchd
/// on macOS) so it starts at login. Where neither is available it runs as a
/// plain background process until the next reboot.
pub async fn up(profile: &str, api: Option<&str>) -> Result<()> {
    if !platform::supported() {
        if !ensure_running(profile, api).await? {
            request(profile, Command::Reload).await?;
        }
        return Ok(());
    }
    if platform::installed(profile) && status(profile).await.is_some() {
        request(profile, Command::Reload).await?;
        return Ok(());
    }
    // Replace a service started without OS registration.
    stop(profile).await?;
    install(profile, api)?;
    wait_until_running(profile).await
}

/// Stops the service and removes its OS registration. Returns whether
/// anything was running or registered.
pub async fn down(profile: &str) -> Result<bool> {
    let registered = uninstall(profile)?.is_some();
    let stopped = stop(profile).await?;
    Ok(registered || stopped)
}

/// Tells a running service to re-read its identity and routes.
pub async fn reload_if_running(profile: &str) -> Result<()> {
    if status(profile).await.is_some() {
        request(profile, Command::Reload).await?;
    }
    Ok(())
}

/// Stops the service. Returns whether it was running.
pub async fn stop(profile: &str) -> Result<bool> {
    if status(profile).await.is_none() {
        return Ok(false);
    }
    request(profile, Command::Stop).await?;
    for _ in 0..150 {
        if status(profile).await.is_none() {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("background service did not stop")
}

fn install(profile: &str, api: Option<&str>) -> Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let mut arguments = vec![
        executable.display().to_string(),
        "--profile".into(),
        profile.into(),
    ];
    if let Some(api) = api {
        arguments.extend(["--api".into(), api.into()]);
    }
    arguments.push("serve".into());
    platform::install(profile, &arguments)
}

fn uninstall(profile: &str) -> Result<Option<PathBuf>> {
    platform::uninstall(profile)
}

/// Runs a service-manager command quietly, reporting its stderr on failure.
fn run(program: &str, arguments: &[&str]) -> Result<()> {
    let output = Process::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("running {program}"))?;
    if !output.status.success() {
        bail!(
            "{program} {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    fn unit_name(profile: &str) -> String {
        format!("opentunnel-{profile}.service")
    }

    fn unit_path(profile: &str) -> PathBuf {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
            });
        config.join("systemd/user").join(unit_name(profile))
    }

    fn quote(argument: &str) -> String {
        if argument
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || "/-_.:".contains(char))
        {
            argument.to_owned()
        } else {
            format!(
                "\"{}\"",
                argument.replace('\\', "\\\\").replace('"', "\\\"")
            )
        }
    }

    /// Whether a systemd user manager is available (not the case in most containers).
    pub fn supported() -> bool {
        Process::new("systemctl")
            .args(["--user", "show-environment"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    pub fn installed(profile: &str) -> bool {
        unit_path(profile).exists()
    }

    pub fn install(profile: &str, arguments: &[String]) -> Result<PathBuf> {
        let path = unit_path(profile);
        let log = control::paths(profile).log;
        fs::create_dir_all(log.parent().expect("log has a parent"))?;
        let exec: Vec<String> = arguments.iter().map(|argument| quote(argument)).collect();
        let unit = format!(
            "[Unit]\n\
             Description=OpenTunnel ({profile})\n\
             Wants=network-online.target\n\
             After=network-online.target\n\
             \n\
             [Service]\n\
             ExecStart={}\n\
             Restart=on-failure\n\
             RestartSec=5\n\
             StandardOutput=append:{log}\n\
             StandardError=append:{log}\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n",
            exec.join(" "),
            log = log.display(),
        );
        fs::create_dir_all(path.parent().expect("unit has a parent"))?;
        fs::write(&path, unit).with_context(|| format!("writing {}", path.display()))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        run(
            "systemctl",
            &["--user", "enable", "--now", &unit_name(profile)],
        )?;
        Ok(path)
    }

    pub fn uninstall(profile: &str) -> Result<Option<PathBuf>> {
        let path = unit_path(profile);
        if !path.exists() {
            return Ok(None);
        }
        let _ = run(
            "systemctl",
            &["--user", "disable", "--now", &unit_name(profile)],
        );
        fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        Ok(Some(path))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn label(profile: &str) -> String {
        format!("xyz.opentunnel.{profile}")
    }

    fn plist_path(profile: &str) -> PathBuf {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", label(profile)))
    }

    fn domain() -> String {
        // SAFETY: getuid has no preconditions and cannot fail.
        format!("gui/{}", unsafe { libc::getuid() })
    }

    fn escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    pub fn supported() -> bool {
        true
    }

    pub fn installed(profile: &str) -> bool {
        plist_path(profile).exists()
    }

    pub fn install(profile: &str, arguments: &[String]) -> Result<PathBuf> {
        let path = plist_path(profile);
        let log = control::paths(profile).log;
        fs::create_dir_all(log.parent().expect("log has a parent"))?;
        let arguments: String = arguments
            .iter()
            .map(|argument| format!("    <string>{}</string>\n", escape(argument)))
            .collect();
        let log = escape(&log.display().to_string());
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{arguments}  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENTUNNEL_DAEMON</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
            label = label(profile),
        );
        fs::create_dir_all(path.parent().expect("plist has a parent"))?;
        fs::write(&path, plist).with_context(|| format!("writing {}", path.display()))?;
        let _ = run(
            "launchctl",
            &["bootout", &format!("{}/{}", domain(), label(profile))],
        );
        run(
            "launchctl",
            &["bootstrap", &domain(), &path.display().to_string()],
        )?;
        Ok(path)
    }

    pub fn uninstall(profile: &str) -> Result<Option<PathBuf>> {
        let path = plist_path(profile);
        if !path.exists() {
            return Ok(None);
        }
        let _ = run(
            "launchctl",
            &["bootout", &format!("{}/{}", domain(), label(profile))],
        );
        fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
        Ok(Some(path))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use super::*;

    pub fn supported() -> bool {
        false
    }

    pub fn installed(_profile: &str) -> bool {
        false
    }

    pub fn install(_profile: &str, _arguments: &[String]) -> Result<PathBuf> {
        bail!("starting at login is supported on Linux (systemd) and macOS (launchd)")
    }

    pub fn uninstall(_profile: &str) -> Result<Option<PathBuf>> {
        Ok(None)
    }
}
