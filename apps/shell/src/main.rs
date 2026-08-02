//! `hypergate` — the desktop shell and CLI for the Hypergate daemon.
//!
//! One binary, several jobs, all of them thin:
//!
//!   • `hypergate app`          the desktop app (manager window + tray agent)
//!   • `hypergate tray`         the per-user logon agent (tray icon + menu)
//!   • `hypergate start|stop|…` a CLI over the daemon's existing HTTP API
//!   • `hypergate add|call|…`   managing servers and driving the gateway
//!   • `hypergate sandbox-exec` the resource-limit launcher the supervisor uses
//!   • `hypergate update`       check for a newer release, and install it
//!   • `hypergate secret`       OS keychain access, including for the daemon
//!   • `hypergate mcp-headers`  the credential a connected client fetches
//!
//! Nothing here reimplements daemon logic. The CLI is a client of the same API
//! the web UI calls, so there is exactly one source of truth for behaviour.

mod api;
mod autostart;
mod commands;
mod daemon;
mod icon;
mod paths;
mod sandbox;
mod secrets;
mod shortcut;
mod tray;
mod update;
mod window;

use std::io::Read;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "hypergate",
    version,
    about = "Local-first runtime and gateway for MCP servers",
    long_about = None
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Open the desktop app: the manager window plus the tray agent.
    App,
    /// Run the tray agent in the foreground (what the login item launches).
    Tray,
    /// Turn Hypergate on: the daemon, a launcher on first run, and the manager.
    Start {
        /// Don't open the manager UI in a browser.
        #[arg(long = "no-open")]
        no_open: bool,
        /// Don't create a launcher, even on the first run.
        #[arg(long = "no-shortcut")]
        no_shortcut: bool,
        /// Also put an icon on the desktop (Windows), now and not just first run.
        #[arg(long)]
        desktop: bool,
    },
    /// Stop a daemon started by this shell.
    Stop,
    /// Restart the daemon.
    Restart,
    /// Check for a newer Hypergate, and optionally install it.
    Update {
        /// Install the update and restart Hypergate (npm installs only).
        #[arg(long)]
        apply: bool,
    },
    /// Show whether the daemon is up, and what it is serving.
    Status,
    /// List managed MCP servers and their state.
    List,
    /// Print a managed server's logs.
    Logs {
        /// Server id, as shown by `hypergate list`.
        id: String,
    },
    /// Browse the curated catalog of servers you can add in one step.
    Catalog {
        /// Only show entries matching this text.
        filter: Option<String>,
    },
    /// Search the official MCP registry for servers to add.
    Search {
        /// What to search for.
        query: String,
    },
    /// Add a managed server, from the catalog or from your own command.
    Add {
        /// A catalog id (see `hypergate catalog`), or the id to give a custom server.
        target: String,
        /// Override the server id.
        #[arg(long)]
        id: Option<String>,
        /// Display name.
        #[arg(long)]
        name: Option<String>,
        /// Launch command, for a server you're defining yourself.
        #[arg(long)]
        command: Option<String>,
        /// An argument for the launch command. Repeat for each one, in order.
        #[arg(long = "arg")]
        args: Vec<String>,
        /// Non-secret environment variable, `KEY=VALUE`. Repeatable.
        #[arg(long = "env")]
        env: Vec<String>,
        /// Secret injected at launch only, `KEY=VALUE`. Repeatable, never logged.
        #[arg(long = "secret")]
        secrets: Vec<String>,
        /// Isolation: process (default), docker, or remote.
        #[arg(long)]
        runtime: Option<String>,
        /// Container image, for the docker runtime.
        #[arg(long)]
        image: Option<String>,
        /// Endpoint, for the remote runtime.
        #[arg(long)]
        url: Option<String>,
        /// Working directory for the launched process.
        #[arg(long)]
        cwd: Option<String>,
        /// Add it without starting it.
        #[arg(long = "no-start")]
        no_start: bool,
    },
    /// Remove a managed server.
    #[command(alias = "remove")]
    Rm {
        /// Server id, as shown by `hypergate list`.
        id: String,
    },
    /// Start, stop or restart one managed server.
    Server {
        #[command(subcommand)]
        action: ServerAction,
    },
    /// List the tools the gateway exposes to connected agents.
    Tools {
        /// Only show tools from this server.
        #[arg(long)]
        server: Option<String>,
    },
    /// Call a tool through the gateway, exactly as an agent would.
    Call {
        /// Namespaced tool name, e.g. `nekkos__open_paw_status`.
        tool: String,
        /// Arguments as a JSON object.
        args: Option<String>,
        /// Single argument as `key=value`. Repeatable; merged over the JSON.
        #[arg(long = "arg")]
        pairs: Vec<String>,
    },
    /// Open the manager UI in the default browser.
    Open,
    /// Print the gateway endpoint and token for pasting into an agent harness.
    Gateway {
        /// Print only the bearer token.
        #[arg(long)]
        token_only: bool,
    },
    /// Print one agent's auth headers as JSON, for a client's headers helper.
    #[command(name = "mcp-headers")]
    McpHeaders {
        /// The agent: its id, its name, or the id it used to have.
        agent: String,
        /// Create the agent if this machine has no match yet.
        #[arg(long)]
        create: bool,
    },
    /// Write the Hypergate mark to a file, for packaging.
    Icon {
        /// Where to write it. `.ico` or `.svg`, chosen by the extension.
        out: String,
    },
    /// Create or remove the desktop and Start Menu launchers.
    Shortcut {
        #[command(subcommand)]
        action: ShortcutAction,
    },
    /// Manage the login item that starts the tray agent.
    Autostart {
        #[command(subcommand)]
        action: AutostartAction,
    },
    /// Read and write Hypergate's secrets in the OS keychain.
    Secret {
        #[command(subcommand)]
        action: SecretAction,
    },
    /// Apply OS resource limits, then run a command (used by the supervisor).
    #[command(name = "sandbox-exec")]
    SandboxExec {
        /// Memory ceiling in MB (Windows Job Object limit / POSIX RLIMIT_AS).
        #[arg(long)]
        mem: Option<u64>,
        /// CPU ceiling as a percentage of the machine (Windows only).
        #[arg(long)]
        cpu: Option<u8>,
        /// Maximum open file descriptors (POSIX only).
        #[arg(long)]
        nofile: Option<u64>,
        /// Fail rather than warn when a requested limit cannot be applied here.
        #[arg(long)]
        strict: bool,
        /// The command to run, after `--`.
        #[arg(last = true, required = true)]
        argv: Vec<String>,
    },
}

#[derive(Subcommand)]
enum ServerAction {
    /// Start a managed server.
    Start { id: String },
    /// Stop a managed server.
    Stop { id: String },
    /// Restart a managed server.
    Restart { id: String },
}

#[derive(Subcommand)]
enum ShortcutAction {
    /// Add the launchers (Start Menu, .app bundle, or XDG desktop entry).
    Install {
        /// Also put an icon on the desktop (Windows only).
        #[arg(long)]
        desktop: bool,
    },
    /// Remove them again.
    Uninstall,
    /// Show which launchers exist.
    Status,
}

#[derive(Subcommand)]
enum AutostartAction {
    /// Enable the login item.
    On,
    /// Disable the login item.
    Off,
    /// Report whether the login item is present.
    Status,
}

#[derive(Subcommand)]
enum SecretAction {
    /// Print a secret's value to stdout.
    Get { key: String },
    /// Store a secret, read from stdin (never argv, which is world-readable).
    Set { key: String },
    /// Delete a secret.
    Delete { key: String },
    /// Report whether a usable keychain exists on this machine.
    Check,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match dispatch(cli.command) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("hypergate: {e}");
            ExitCode::FAILURE
        }
    }
}

fn dispatch(command: Command) -> Result<ExitCode, String> {
    match command {
        // The same resident agent either way; `app` also opens the manager
        // window up front, while `tray` stays headless (it's what the login
        // item runs, and a window at every login would be noise).
        Command::App => {
            tray::run(true)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Tray => {
            tray::run(false)?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Start {
            no_open,
            no_shortcut,
            desktop,
        } => {
            commands::start(&commands::StartOptions {
                open: !no_open,
                shortcut: !no_shortcut,
                desktop,
            })?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Stop => {
            if daemon::stop()? {
                println!("Daemon stopped");
                Ok(ExitCode::SUCCESS)
            } else if api::is_up() {
                Err("a daemon is running but this shell did not start it; stop it where it was started".into())
            } else {
                println!("No daemon running");
                Ok(ExitCode::SUCCESS)
            }
        }

        Command::Restart => {
            let _ = daemon::stop();
            let _ = secrets::adopt_gateway_token();
            let pid = daemon::spawn_detached()?;
            if daemon::wait_until_up(Duration::from_secs(20)) {
                println!("Daemon restarted (pid {pid})");
                Ok(ExitCode::SUCCESS)
            } else {
                Err(format!("daemon (pid {pid}) did not answer /health within 20s"))
            }
        }

        Command::Update { apply } => {
            if apply {
                update::apply()?;
            } else {
                update::show()?;
            }
            Ok(ExitCode::SUCCESS)
        }

        Command::Status => match api::health() {
            Ok(h) => {
                println!("Daemon    running (v{}) at {}", h.version, paths::base_url());
                println!("Servers   {}", h.servers);
                if let Ok(a) = api::analytics() {
                    println!("Usage     {} call(s), {} error(s)", a.total_calls, a.total_errors);
                }
                println!(
                    "Keychain  {}",
                    if secrets::available() {
                        "available"
                    } else {
                        "unavailable (file fallback)"
                    }
                );
                println!(
                    "Autostart {}",
                    if !autostart::is_supported() {
                        "unsupported on this platform"
                    } else if autostart::is_enabled() {
                        "enabled"
                    } else {
                        "disabled"
                    }
                );
                // From the daemon's cache, so `status` stays a local question.
                // Stated either way: "how do I update this" should be
                // answerable without knowing that `hypergate update` exists.
                if let Ok(info) = api::update() {
                    match info.latest.as_deref() {
                        Some(latest) if info.update_available => {
                            println!("Update    v{latest} available — run `hypergate update --apply`");
                        }
                        Some(_) => println!("Update    up to date ({} channel)", info.channel),
                        None => println!("Update    run `hypergate update` to check"),
                    }
                }
                Ok(ExitCode::SUCCESS)
            }
            Err(e) => {
                println!("Daemon    not running ({e})");
                // Not an error: "is it up?" answered honestly is a successful query.
                Ok(ExitCode::SUCCESS)
            }
        },

        Command::List => {
            let servers = api::servers()?;
            if servers.is_empty() {
                println!("No managed servers yet. Add one in the manager UI: {}", api::ui_url());
                return Ok(ExitCode::SUCCESS);
            }
            let id_w = servers.iter().map(|s| s.id.len()).max().unwrap_or(2).max(2);
            let name_w = servers.iter().map(|s| s.name.len()).max().unwrap_or(4).max(4);
            println!(
                "{:<id_w$}  {:<name_w$}  {:<11}  {:<8}  TOOLS",
                "ID",
                "NAME",
                "STATE",
                "RUNTIME",
                id_w = id_w,
                name_w = name_w
            );
            for s in &servers {
                println!(
                    "{:<id_w$}  {:<name_w$}  {:<11}  {:<8}  {}{}",
                    s.id,
                    s.name,
                    s.state,
                    s.runtime,
                    s.tools.len(),
                    s.error.as_deref().map(|e| format!("  ({e})")).unwrap_or_default(),
                    id_w = id_w,
                    name_w = name_w
                );
            }
            Ok(ExitCode::SUCCESS)
        }

        Command::Logs { id } => {
            let logs = api::logs(&id)?;
            if logs.logs.is_empty() {
                println!("(no logs for {id})");
            }
            for line in logs.logs {
                println!("{line}");
            }
            Ok(ExitCode::SUCCESS)
        }

        Command::Catalog { filter } => {
            commands::catalog(filter.as_deref())?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Search { query } => {
            commands::search(&query)?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Add {
            target,
            id,
            name,
            command,
            args,
            env,
            secrets,
            runtime,
            image,
            url,
            cwd,
            no_start,
        } => {
            commands::add(
                &target,
                &commands::AddOptions {
                    id,
                    name,
                    command,
                    args,
                    env,
                    secrets,
                    runtime,
                    image,
                    url,
                    cwd,
                    start: !no_start,
                },
            )?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Rm { id } => {
            commands::remove(&id)?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Server { action } => {
            let (id, verb) = match &action {
                ServerAction::Start { id } => (id.clone(), "started"),
                ServerAction::Stop { id } => (id.clone(), "stopped"),
                ServerAction::Restart { id } => (id.clone(), "restarted"),
            };
            match action {
                ServerAction::Start { id } => api::start_server(&id)?,
                ServerAction::Stop { id } => api::stop_server(&id)?,
                ServerAction::Restart { id } => api::restart_server(&id)?,
            }
            println!("{id} {verb}");
            Ok(ExitCode::SUCCESS)
        }

        Command::Tools { server } => {
            commands::tools(server.as_deref())?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Call { tool, args, pairs } => {
            let ok = commands::call(&tool, args.as_deref(), &pairs)?;
            // A tool that reported an error must not exit 0, or a script can't tell.
            Ok(if ok { ExitCode::SUCCESS } else { ExitCode::from(1) })
        }

        Command::Open => {
            open::that_detached(api::ui_url()).map_err(|e| format!("could not open a browser: {e}"))?;
            Ok(ExitCode::SUCCESS)
        }

        Command::Gateway { token_only } => {
            let g = api::gateway()?;
            if token_only {
                println!("{}", g.token);
            } else {
                println!("URL     {}", g.url);
                println!("Token   {}", g.token);
                println!("stdio   {}", g.stdio_command);
                println!("UI      {}", if g.ui_url.is_empty() { api::ui_url() } else { g.ui_url });
            }
            Ok(ExitCode::SUCCESS)
        }

        // stdout is the client's input here: one JSON object and nothing else,
        // which is why this prints the string rather than reporting anything.
        Command::McpHeaders { agent, create } => {
            println!("{}", commands::mcp_headers(&agent, create)?);
            Ok(ExitCode::SUCCESS)
        }

        Command::Icon { out } => {
            // Installers need the mark as a file at build time, and it only
            // exists as code. Extension picks the format so a packaging script
            // reads as what it means.
            let path = std::path::PathBuf::from(&out);
            let bytes = match path
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("ico") => icon::ico_bytes(),
                Some("svg") => icon::svg().into_bytes(),
                _ => return Err(format!("don't know how to write `{out}` (expected .ico or .svg)")),
            };
            if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
                std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
            }
            std::fs::write(&path, bytes).map_err(|e| format!("could not write {out}: {e}"))?;
            println!("Wrote {out}");
            Ok(ExitCode::SUCCESS)
        }

        Command::Shortcut { action } => match action {
            ShortcutAction::Install { desktop } => {
                let made = shortcut::install(desktop)?;
                for path in &made {
                    println!("Created {}", path.display());
                }
                println!(
                    "
Click it to turn Hypergate on. `hypergate autostart on` starts it at login instead."
                );
                Ok(ExitCode::SUCCESS)
            }
            ShortcutAction::Uninstall => {
                let removed = shortcut::uninstall()?;
                if removed.is_empty() {
                    println!("No launchers to remove");
                }
                for path in &removed {
                    println!("Removed {}", path.display());
                }
                Ok(ExitCode::SUCCESS)
            }
            ShortcutAction::Status => {
                for entry in shortcut::status()? {
                    println!(
                        "{:<12} {}  {}",
                        entry.label,
                        if entry.exists() { "present" } else { "absent " },
                        entry.path.display()
                    );
                }
                Ok(ExitCode::SUCCESS)
            }
        },

        Command::Autostart { action } => match action {
            AutostartAction::On => {
                autostart::enable()?;
                println!("Hypergate will start at login");
                Ok(ExitCode::SUCCESS)
            }
            AutostartAction::Off => {
                autostart::disable()?;
                println!("Hypergate will no longer start at login");
                Ok(ExitCode::SUCCESS)
            }
            AutostartAction::Status => {
                println!("{}", if autostart::is_enabled() { "enabled" } else { "disabled" });
                Ok(ExitCode::SUCCESS)
            }
        },

        Command::Secret { action } => match action {
            SecretAction::Get { key } => match secrets::get(&key)? {
                Some(v) => {
                    // No trailing newline: callers (including the daemon) read
                    // this as an exact value.
                    print!("{v}");
                    Ok(ExitCode::SUCCESS)
                }
                // Absent is not a failure; exit 1 lets a caller branch on it.
                None => Ok(ExitCode::from(1)),
            },
            SecretAction::Set { key } => {
                let mut value = String::new();
                std::io::stdin()
                    .read_to_string(&mut value)
                    .map_err(|e| format!("could not read the value from stdin: {e}"))?;
                secrets::set(&key, &value)?;
                Ok(ExitCode::SUCCESS)
            }
            SecretAction::Delete { key } => {
                secrets::delete(&key)?;
                Ok(ExitCode::SUCCESS)
            }
            SecretAction::Check => {
                let ok = secrets::available();
                println!("{}", if ok { "available" } else { "unavailable" });
                Ok(if ok { ExitCode::SUCCESS } else { ExitCode::from(1) })
            }
        },

        Command::SandboxExec {
            mem,
            cpu,
            nofile,
            strict,
            argv,
        } => {
            let (program, args) = argv.split_first().ok_or("sandbox-exec needs a command after `--`")?;
            let code = sandbox::exec(
                program,
                args,
                sandbox::Limits {
                    mem_mb: mem,
                    cpu_pct: cpu,
                    nofile,
                    strict,
                },
            )?;
            // Propagate the child's exit code, so the supervisor sees the truth.
            Ok(ExitCode::from(u8::try_from(code).unwrap_or(1)))
        }
    }
}
