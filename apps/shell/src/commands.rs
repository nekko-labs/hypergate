//! The server-management half of the CLI: catalog, add, remove, lifecycle,
//! tools and tool calls.
//!
//! Like the rest of the shell these are pure clients of the daemon's HTTP API
//! and of the gateway at `/mcp`. Nothing here reimplements supervisor or
//! gateway behaviour. The parts that *are* logic (parsing `K=V` pairs, merging
//! a catalog entry with overrides into an add payload, rendering a tool result)
//! are separated out as pure functions so they can be unit-tested without a
//! running daemon.

use serde_json::{Map, Value, json};
use std::io::Read;
use std::process::ExitCode;

use crate::api::{self, RegistryEntry};
use crate::{AutostartAction, Command, CredAction, SecretAction, ServerAction, ShortcutAction};

/// Parse only the small, safe subset of curated install instructions that can
/// be executed without invoking a shell. URLs, prose, and shell syntax remain
/// manual instructions.
pub fn parse_curated_install(command: &str) -> Option<Vec<String>> {
    let trimmed = command.trim();
    if trimmed.is_empty()
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.split_whitespace().count() == 0
    {
        return None;
    }
    const META: [char; 13] = ['|', '&', ';', '<', '>', '$', '`', '(', ')', '{', '}', '\'', '"'];
    if trimmed
        .chars()
        .any(|c| c == '\\' || c == '\n' || c == '\r' || META.contains(&c))
    {
        return None;
    }
    let mut argv = Vec::new();
    for word in trimmed.split_whitespace() {
        if word.starts_with("http://") || word.starts_with("https://") {
            return None;
        }
        argv.push(word.to_string());
    }
    let program = argv.first()?;
    let known_launcher = [
        "npm", "npx", "pnpm", "yarn", "bun", "brew", "pipx", "pip", "winget", "scoop", "choco", "cargo",
    ];
    if !known_launcher.contains(&program.as_str())
        || !program
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'))
    {
        return None;
    }
    Some(argv)
}

fn width(values: impl Iterator<Item = usize>, minimum: usize) -> usize {
    values.max().unwrap_or(minimum).max(minimum)
}

pub fn agents_human() -> Result<ExitCode, String> {
    let value = api::agents()?;
    let rows = value.as_array().ok_or("unexpected agent response")?;
    if rows.is_empty() {
        println!("No connected agents.");
        return Ok(ExitCode::SUCCESS);
    }
    let id_w = width(rows.iter().filter_map(|v| v["id"].as_str()).map(str::len), 2);
    let name_w = width(rows.iter().filter_map(|v| v["name"].as_str()).map(str::len), 4);
    println!(
        "{:<id_w$}  {:<name_w$}  {:<24}  CREATED",
        "ID",
        "NAME",
        "SCOPE",
        id_w = id_w,
        name_w = name_w
    );
    for row in rows {
        let scope = match &row["servers"] {
            Value::String(s) => s.clone(),
            Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(","),
            _ => "—".into(),
        };
        println!(
            "{:<id_w$}  {:<name_w$}  {:<24}  {}",
            row["id"].as_str().unwrap_or("?"),
            row["name"].as_str().unwrap_or(""),
            scope,
            row["createdAt"]
                .as_str()
                .or_else(|| row["created"].as_str())
                .unwrap_or("—"),
            id_w = id_w,
            name_w = name_w
        );
    }
    Ok(ExitCode::SUCCESS)
}

// ── the credential vault ─────────────────────────────────────────────────────

pub fn cred_ls_human() -> Result<ExitCode, String> {
    let value = api::credentials()?;
    let rows = value.as_array().ok_or("unexpected credential response")?;
    if rows.is_empty() {
        println!("No credentials stored. `hypergate cred guide` shows where to get them.");
        return Ok(ExitCode::SUCCESS);
    }
    let id_w = width(rows.iter().filter_map(|v| v["id"].as_str()).map(str::len), 2);
    let env_w = width(rows.iter().filter_map(|v| v["envVar"].as_str()).map(str::len), 3);
    println!(
        "{:<id_w$}  {:<env_w$}  {:<12}  {:<8}  USED BY",
        "ID",
        "ENV",
        "HINT",
        "STORAGE",
        id_w = id_w,
        env_w = env_w
    );
    for row in rows {
        let servers = row["usedBy"]["servers"].as_array().map(Vec::len).unwrap_or(0);
        let agents = row["usedBy"]["agents"].as_array().map(Vec::len).unwrap_or(0);
        println!(
            "{:<id_w$}  {:<env_w$}  {:<12}  {:<8}  {} server(s), {} agent(s)",
            row["id"].as_str().unwrap_or("?"),
            row["envVar"].as_str().unwrap_or("—"),
            row["hint"].as_str().unwrap_or("—"),
            row["storage"].as_str().unwrap_or("?"),
            servers,
            agents,
            id_w = id_w,
            env_w = env_w
        );
    }
    Ok(ExitCode::SUCCESS)
}

/// Store a value from stdin. The key resolves in this order: an existing
/// credential id (roll it in place), a guide service (create it with the
/// guide's name and env var), else a new custom credential named by the key.
pub fn cred_set(key: &str, env_override: Option<&str>) -> Result<ExitCode, String> {
    let mut value = String::new();
    std::io::stdin()
        .read_to_string(&mut value)
        .map_err(|e| format!("could not read the value from stdin: {e}"))?;
    let value = value.trim();
    if value.is_empty() {
        return Err("no value on stdin — pipe the credential in, e.g. `pbpaste | hypergate cred set fly`".into());
    }

    let existing = api::credentials()?
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["id"].as_str() == Some(key)).cloned());
    if let Some(row) = existing {
        let rolled = api::roll_credential(key, value)?;
        let restarted = rolled["restarted"].as_array().map(Vec::len).unwrap_or(0);
        println!(
            "Rolled {} ({} server(s) restarted onto the new value)",
            row["name"].as_str().unwrap_or(key),
            restarted
        );
        return Ok(ExitCode::SUCCESS);
    }

    let guides = api::credential_guides()?;
    let guide = guides.as_array().and_then(|rows| {
        rows.iter()
            .find(|g| g["service"].as_str() == Some(&key.to_lowercase()))
            .cloned()
    });
    let created = match &guide {
        Some(g) => api::add_credential(
            g["name"].as_str().unwrap_or(key),
            value,
            g["service"].as_str(),
            env_override.or(g["envVar"].as_str()),
        )?,
        None => api::add_credential(key, value, None, env_override)?,
    };
    println!(
        "Stored {} as {} ({})",
        created["name"].as_str().unwrap_or(key),
        created["id"].as_str().unwrap_or("?"),
        created["storage"].as_str().unwrap_or("?"),
    );
    if let Some(env) = created["envVar"].as_str() {
        println!("Injected as {env} by `hypergate run` and credentialRefs.");
    }
    Ok(ExitCode::SUCCESS)
}

/// Above this many guides, a bare `cred guide` summarises instead of dumping
/// every field of every entry. Eight (the v1.7.0 catalog) still prints in full.
const SUMMARY_THRESHOLD: usize = 12;

pub fn cred_guide_human(service: Option<&str>) -> Result<ExitCode, String> {
    let value = api::credential_guides()?;
    let rows = value.as_array().ok_or("unexpected guide response")?;
    let filtered: Vec<&Value> = match service {
        Some(s) => rows
            .iter()
            .filter(|g| g["service"].as_str() == Some(&s.to_lowercase()))
            .collect(),
        None => rows.iter().collect(),
    };
    if filtered.is_empty() {
        return Err(format!(
            "no guide for `{}` — store it anyway with `hypergate cred set <name> --env VAR`",
            service.unwrap_or("?")
        ));
    }
    // Bare `cred guide` used to print eight entries in full. The catalog is now
    // 54, and six lines each is a screenful of scrollback for a command someone
    // ran to look one thing up, so an unfiltered listing is one line per guide
    // and the detail stays behind naming a service.
    if service.is_none() && filtered.len() > SUMMARY_THRESHOLD {
        let width = filtered
            .iter()
            .filter_map(|g| g["service"].as_str().map(str::len))
            .max()
            .unwrap_or(12);
        for g in &filtered {
            println!(
                "{:<width$}  {:<28}  {}{}",
                g["service"].as_str().unwrap_or("?"),
                g["envVar"].as_str().unwrap_or(""),
                g["name"].as_str().unwrap_or("?"),
                if g["storedId"].is_string() { "  ✓ stored" } else { "" },
                width = width,
            );
        }
        println!(
            "\n{} guides. `hypergate cred guide <service>` shows where to get one.",
            filtered.len()
        );
        return Ok(ExitCode::SUCCESS);
    }
    for g in filtered {
        println!(
            "{}  ({})",
            g["name"].as_str().unwrap_or("?"),
            g["service"].as_str().unwrap_or("?")
        );
        if let Some(env) = g["envVar"].as_str() {
            println!("  env      {env}");
        }
        if let Some(url) = g["createUrl"].as_str() {
            println!("  create   {url}");
        }
        if let Some(cmd) = g["createCommand"].as_str() {
            println!("  command  {cmd}");
        }
        if let Some(url) = g["manageUrl"].as_str() {
            println!("  manage   {url}");
        }
        if let Some(id) = g["storedId"].as_str() {
            println!("  stored   ✓ as {id}");
        } else {
            println!(
                "  store    <paste> | hypergate cred set {}",
                g["service"].as_str().unwrap_or("?")
            );
        }
        if let Some(note) = g["note"].as_str() {
            println!("  note     {note}");
        }
        println!();
    }
    Ok(ExitCode::SUCCESS)
}

pub fn cred_json(action: &CredAction) -> Result<Value, String> {
    Ok(match action {
        CredAction::Ls => api::credentials()?,
        CredAction::Guide { service } => {
            let all = api::credential_guides()?;
            match service {
                Some(s) => json!(
                    all.as_array()
                        .map(|rows| rows
                            .iter()
                            .filter(|g| g["service"].as_str() == Some(&s.to_lowercase()))
                            .cloned()
                            .collect::<Vec<_>>())
                        .unwrap_or_default()
                ),
                None => all,
            }
        }
        CredAction::Rm { id } => api::delete_credential(id)?,
        CredAction::Allow { agent, id } => api::set_agent_credential(agent, id, true)?,
        CredAction::Deny { agent, id } => api::set_agent_credential(agent, id, false)?,
        // Set reads stdin and prints its own confirmation; keep it human-only
        // rather than inventing a JSON stdin protocol nothing consumes yet.
        CredAction::Set { .. } => return Err("`cred set` does not support --json".into()),
    })
}

/// Run a command with vault credentials in its env. The values ride only in
/// the child's environment: never argv, never printed, never logged.
pub fn run_with_credentials(agent: Option<&str>, with: &[String], argv: &[String]) -> Result<ExitCode, String> {
    let resolved = api::resolve_credentials(agent, with)?;
    let env = resolved["env"].as_object().cloned().unwrap_or_default();
    let used = resolved["used"].as_array().map(Vec::len).unwrap_or(0);
    let (program, rest) = argv
        .split_first()
        .ok_or("nothing to run — pass the command after `--`")?;
    // Name the count, never the contents: this line may end up in a CI log.
    eprintln!("hypergate run: injecting {used} credential(s) into `{program}`");
    let mut child = std::process::Command::new(program);
    child.args(rest);
    for (k, v) in &env {
        if let Some(val) = v.as_str() {
            child.env(k, val);
        }
    }
    let status = child.status().map_err(|e| format!("could not run `{program}`: {e}"))?;
    Ok(match status.code() {
        Some(0) => ExitCode::SUCCESS,
        Some(code) => ExitCode::from(u8::try_from(code.clamp(0, 255)).unwrap_or(1)),
        None => ExitCode::from(1),
    })
}

pub fn targets_human() -> Result<ExitCode, String> {
    let value = api::connect_targets()?;
    let rows = value["targets"].as_array().ok_or("unexpected targets response")?;
    println!("{:<20}  {:<10}  RUNNABLE", "TARGET", "DETECTED");
    for row in rows {
        println!(
            "{:<20}  {:<10}  {}",
            row["id"].as_str().unwrap_or("?"),
            if row["found"].as_bool().unwrap_or(false) {
                "yes"
            } else {
                "no"
            },
            if row["runnable"].as_bool().unwrap_or(false) {
                "yes"
            } else {
                "no"
            }
        );
    }
    Ok(ExitCode::SUCCESS)
}

pub fn cli_ls_human() -> Result<ExitCode, String> {
    let rows = api::cli_status()?;
    let rows = rows.as_array().ok_or("unexpected CLI catalog response")?;
    println!("{:<18}  {:<18}  NAME", "COMMAND", "VERSION");
    for row in rows {
        println!(
            "{:<18}  {:<18}  {}",
            row["command"].as_str().unwrap_or("?"),
            row["version"]
                .as_str()
                .or_else(|| row["detectedVersion"].as_str())
                .unwrap_or("not found"),
            row["name"].as_str().unwrap_or("")
        );
    }
    Ok(ExitCode::SUCCESS)
}

pub fn cli_search_human(query: &str) -> Result<ExitCode, String> {
    let rows = api::cli_search(query)?;
    println!("{:<24}  {:<18}  {:<10}  POPULARITY", "NAME", "COMMAND", "CHANNEL");
    for row in rows.as_array().ok_or("unexpected CLI search response")? {
        println!(
            "{:<24}  {:<18}  {:<10}  {}",
            row["name"].as_str().unwrap_or(""),
            row["command"].as_str().unwrap_or(""),
            row["channel"].as_str().unwrap_or(""),
            row["downloads"]
                .as_u64()
                .or_else(|| row["popularity"].as_u64())
                .map(|n| n.to_string())
                .unwrap_or_else(|| "—".into())
        );
    }
    Ok(ExitCode::SUCCESS)
}

pub fn cli_check_human(command: &str) -> Result<ExitCode, String> {
    let row = api::cli_check(command)?;
    println!(
        "{}: {}",
        command,
        if row["installed"]
            .as_bool()
            .or_else(|| row["found"].as_bool())
            .unwrap_or(false)
        {
            row["version"].as_str().unwrap_or("detected")
        } else {
            "not found"
        }
    );
    Ok(ExitCode::SUCCESS)
}

pub fn cli_install_human(id: &str, run: bool) -> Result<ExitCode, String> {
    let catalog = api::cli_catalog()?;
    let entry = catalog
        .as_array()
        .and_then(|a| a.iter().find(|v| v["id"].as_str() == Some(id)))
        .ok_or_else(|| format!("`{id}` is not in the curated CLI catalog"))?;
    let instruction = entry["install"]
        .as_str()
        .ok_or_else(|| format!("no curated install instruction is available for `{id}`"))?;
    if !run {
        println!("{instruction}");
        println!("(run it with `--run` when it is a plain command; otherwise follow this manual instruction)");
        return Ok(ExitCode::SUCCESS);
    }
    let argv = parse_curated_install(instruction);
    let Some(argv) = argv else {
        println!("{instruction}");
        println!("This is a manual install instruction and was not executed.");
        return Ok(ExitCode::SUCCESS);
    };
    let status = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .status()
        .map_err(|e| format!("could not run curated installer: {e}"))?;
    println!("Installer exited with {}", status.code().unwrap_or(1));
    Ok(if status.success() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    })
}

pub fn usage_human() -> Result<ExitCode, String> {
    let value = api::analytics_value()?;
    println!("Calls     {}", value["totalCalls"].as_u64().unwrap_or(0));
    println!("Errors    {}", value["totalErrors"].as_u64().unwrap_or(0));
    if let Some(rows) = value["servers"].as_array() {
        println!("\nSERVER                 CALLS  ERRORS");
        for row in rows {
            println!(
                "{:<22}  {:>5}  {:>6}",
                row["server"].as_str().unwrap_or(""),
                row["calls"].as_u64().unwrap_or(0),
                row["errors"].as_u64().unwrap_or(0)
            );
        }
    }
    Ok(ExitCode::SUCCESS)
}

pub fn doctor_human(report: &Value) -> Result<ExitCode, String> {
    const LABELS: [&str; 10] = [
        "Daemon",
        "Token",
        "Keychain",
        "Authentication",
        "Allowed hosts",
        "Agents",
        "Servers",
        "Data",
        "VERDICT",
        "Action",
    ];
    let label_width = LABELS.iter().map(|label| label.len()).max().unwrap_or(0) + 1;
    println!(
        "{:<label_width$}{}",
        "Daemon",
        if report["daemon"]["running"].as_bool().unwrap_or(false) {
            format!(
                "running v{} on port {}",
                report["daemon"]["version"].as_str().unwrap_or("?"),
                report["daemon"]["port"]
            )
        } else {
            "not running".into()
        }
    );
    println!(
        "{:<label_width$}{}",
        "Token",
        report["auth"]["tokenSource"].as_str().unwrap_or("none")
    );
    println!(
        "{:<label_width$}{}",
        "Keychain",
        if report["auth"]["keychainAvailable"].as_bool().unwrap_or(false) {
            "available"
        } else {
            "unavailable"
        }
    );
    println!(
        "{:<label_width$}{}",
        "Authentication",
        if report["auth"]["disabled"].as_bool().unwrap_or(false) {
            "DISABLED"
        } else {
            "enabled"
        }
    );
    println!(
        "{:<label_width$}{}",
        "Allowed hosts",
        report["auth"]["allowedHosts"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("none")
    );
    println!(
        "{:<label_width$}{}",
        "Agents",
        report["agents"]["count"].as_u64().unwrap_or(0)
    );
    println!(
        "{:<label_width$}{}",
        "Servers",
        report["servers"].as_array().map(Vec::len).unwrap_or(0)
    );
    println!(
        "{:<label_width$}{}",
        "Data",
        report["dataDirectory"].as_str().unwrap_or("")
    );
    if report["problems"].as_bool().unwrap_or(false) {
        println!("{:<label_width$}NOT READY", "VERDICT");
        if !report["daemon"]["running"].as_bool().unwrap_or(false) {
            println!("{:<label_width$}run `hypergate start`.", "Action");
        }
        if report["auth"]["disabled"].as_bool().unwrap_or(false) {
            println!("{:<label_width$}unset HYPERGATE_NO_AUTH.", "Action");
        }
        if report["auth"]["tokenSource"] == "file" && report["auth"]["keychainAvailable"].as_bool().unwrap_or(false) {
            println!("{:<label_width$}move the master token into the OS keychain.", "Action");
        }
        Ok(ExitCode::from(1))
    } else {
        println!("{:<label_width$}READY (warnings may apply)", "VERDICT");
        Ok(ExitCode::SUCCESS)
    }
}

pub fn start_json(open: bool, shortcut: bool, desktop: bool) -> Result<Value, String> {
    let _ = (open, shortcut, desktop);
    if !api::is_up() {
        let _ = crate::secrets::adopt_gateway_token();
        let pid = crate::daemon::spawn_detached()?;
        if !crate::daemon::wait_until_up(std::time::Duration::from_secs(20)) {
            return Err(format!("daemon (pid {pid}) did not answer /health within 20s"));
        }
    }
    Ok(json!({ "running": api::is_up(), "url": api::ui_url() }))
}

pub fn restart_json() -> Result<Value, String> {
    let _ = crate::daemon::stop();
    let _ = crate::secrets::adopt_gateway_token();
    let pid = crate::daemon::spawn_detached()?;
    if crate::daemon::wait_until_up(std::time::Duration::from_secs(20)) {
        Ok(json!({ "running": true, "pid": pid }))
    } else {
        Err(format!("daemon (pid {pid}) did not answer /health within 20s"))
    }
}

pub fn management_json(command: &Command) -> Result<Value, String> {
    match command {
        Command::Add {
            target,
            id,
            name,
            connection,
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
            let custom = command.is_some() || url.is_some() || image.is_some();
            let entry = if custom { None } else { find_entry(target)? };
            if entry.is_none() && !custom {
                return Err(format!("no catalog entry called `{target}`"));
            }
            let mut options = AddOptions {
                id: id.clone(),
                name: name.clone(),
                connection: connection.clone(),
                command: command.clone(),
                args: args.clone(),
                env: env.clone(),
                secrets: secrets.clone(),
                runtime: runtime.clone(),
                image: image.clone(),
                url: url.clone(),
                cwd: cwd.clone(),
                start: !no_start,
            };
            let entry = resolve_add_entry(entry, &mut options)?;
            let config = build_add_config(entry.as_ref(), &options, &|k| std::env::var(k).ok())?;
            api::add_server(&config)
        }
        Command::Rm { id } => {
            api::remove_server(id)?;
            Ok(json!({ "removed": id }))
        }
        Command::Server { action } => {
            match action {
                ServerAction::Start { id } => api::start_server(id)?,
                ServerAction::Stop { id } => api::stop_server(id)?,
                ServerAction::Restart { id } => api::restart_server(id)?,
            }
            Ok(
                json!({ "server": match action { ServerAction::Start{id} | ServerAction::Stop{id} | ServerAction::Restart{id} => id } }),
            )
        }
        Command::McpHeaders { agent, create } => {
            serde_json::from_str(&mcp_headers(agent, *create)?).map_err(|e| e.to_string())
        }
        Command::Secret { action } => match action {
            SecretAction::Check => Ok(json!({ "available": crate::secrets::available() })),
            SecretAction::Get { key } => Ok(json!({ "key": key, "value": crate::secrets::get(key)? })),
            SecretAction::Set { key } => {
                let mut value = String::new();
                std::io::stdin()
                    .read_to_string(&mut value)
                    .map_err(|e| format!("could not read the value from stdin: {e}"))?;
                crate::secrets::set(key, &value)?;
                Ok(json!({ "key": key, "stored": true }))
            }
            SecretAction::Delete { key } => {
                crate::secrets::delete(key)?;
                Ok(json!({ "deleted": key }))
            }
        },
        Command::Shortcut { action } => match action {
            ShortcutAction::Status => Ok(json!(
                crate::shortcut::status()?
                    .into_iter()
                    .map(|e| json!({"label": e.label, "exists": e.exists(), "path": e.path}))
                    .collect::<Vec<_>>()
            )),
            ShortcutAction::Install { desktop } => Ok(
                json!({"created": crate::shortcut::install(*desktop)?.into_iter().map(|p| p.display().to_string()).collect::<Vec<_>>() }),
            ),
            ShortcutAction::Uninstall => Ok(
                json!({"removed": crate::shortcut::uninstall()?.into_iter().map(|p| p.display().to_string()).collect::<Vec<_>>() }),
            ),
        },
        Command::Autostart { action } => match action {
            AutostartAction::Status => Ok(json!({"enabled": crate::autostart::is_enabled()})),
            AutostartAction::On => {
                crate::autostart::enable()?;
                Ok(json!({"enabled": true}))
            }
            AutostartAction::Off => {
                crate::autostart::disable()?;
                Ok(json!({"enabled": false}))
            }
        },
        _ => Err("unsupported management command".into()),
    }
}

pub fn agent_token(id: &str) -> Result<Value, String> {
    let agents = api::agents()?;
    agents
        .as_array()
        .and_then(|a| a.iter().find(|v| v.get("id").and_then(Value::as_str) == Some(id)))
        .and_then(|v| v.get("token"))
        .cloned()
        .ok_or_else(|| format!("agent `{id}` not found"))
}

pub fn cli_json(action: &crate::CliAction) -> Result<Value, String> {
    match action {
        crate::CliAction::Ls => api::cli_status(),
        crate::CliAction::Search { query } => api::cli_search(query),
        crate::CliAction::Check { command } => api::cli_check(command),
        crate::CliAction::Install { id, run, yes } => install_cli_json(id, *run || *yes),
    }
}

pub fn install_cli_json(id: &str, run: bool) -> Result<Value, String> {
    let catalog = api::cli_catalog()?;
    let entry = catalog
        .as_array()
        .and_then(|a| a.iter().find(|v| v.get("id").and_then(Value::as_str) == Some(id)))
        .ok_or_else(|| format!("`{id}` is not in the curated CLI catalog"))?;
    let option = entry["install"]
        .as_str()
        .ok_or_else(|| format!("no curated install instruction is available for `{id}`"))?;
    if !run {
        return Ok(json!({ "id": id, "command": option, "executed": false }));
    }
    let Some(argv) = parse_curated_install(option) else {
        return Ok(json!({ "id": id, "command": option, "executed": false, "manual": true }));
    };
    let status = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .status()
        .map_err(|e| format!("could not run curated installer: {e}"))?;
    Ok(json!({ "id": id, "command": option, "executed": true, "exitCode": status.code().unwrap_or(1) }))
}

pub fn doctor_json() -> Result<Value, String> {
    let health = api::health();
    let keychain = crate::secrets::available();
    let token_source = if crate::secrets::get("gateway-token").ok().flatten().is_some() {
        "keychain"
    } else if crate::paths::token_file().is_file() {
        "file"
    } else {
        "none"
    };
    let agents = api::agents().unwrap_or_else(|_| json!([]));
    let (mut wildcard, mut scoped) = (0_u64, 0_u64);
    if let Some(items) = agents.as_array() {
        for item in items {
            if item["servers"].as_str() == Some("*") {
                wildcard += 1;
            } else {
                scoped += 1;
            }
        }
    }
    let h = health.as_ref().ok();
    let path_notice = crate::shortcut::path_notice();
    let problems = h.is_none()
        || std::env::var("HYPERGATE_NO_AUTH").ok().as_deref() == Some("1")
        || (keychain && token_source == "file");
    Ok(json!({
        "daemon": { "running": h.is_some(), "version": h.map(|v| v.version.clone()), "port": crate::paths::port() },
        "auth": { "tokenSource": token_source, "keychainAvailable": keychain, "disabled": std::env::var("HYPERGATE_NO_AUTH").ok().as_deref() == Some("1"), "allowedHosts": std::env::var("HYPERGATE_ALLOWED_HOSTS").unwrap_or_default() },
        "agents": { "count": agents.as_array().map(Vec::len).unwrap_or(0), "wildcard": wildcard, "scoped": scoped },
        "servers": api::servers_value().unwrap_or_else(|_| json!([])),
        "update": api::update().ok(),
        "autostart": { "enabled": crate::autostart::is_enabled() },
        "shortcut": crate::shortcut::status().ok().map(|items| items.into_iter().map(|item| json!({ "label": item.label, "exists": item.exists(), "path": item.path })).collect::<Vec<_>>()).unwrap_or_default(),
        "pathNotice": path_notice,
        "dataDirectory": crate::paths::data_dir(),
        "problems": problems
    }))
}

/// Everything `hypergate add` can override on top of a catalog entry.
#[derive(Debug, Default, Clone)]
pub struct AddOptions {
    pub id: Option<String>,
    pub name: Option<String>,
    pub connection: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<String>,
    pub secrets: Vec<String>,
    pub runtime: Option<String>,
    pub image: Option<String>,
    pub url: Option<String>,
    pub cwd: Option<String>,
    pub start: bool,
}

pub fn resolve_registry_connection(
    entry: &RegistryEntry,
    connection_id: Option<&str>,
) -> Result<RegistryEntry, String> {
    if entry.connections.is_empty() {
        if let Some(id) = connection_id {
            return Err(format!(
                "entry `{}` has no connection options; remove `--connection {id}`",
                entry.id
            ));
        }
        return Ok(entry.clone());
    }
    let connection = match connection_id {
        Some(id) => entry.connections.iter().find(|c| c.id == id),
        None => entry.connections.first(),
    }
    .ok_or_else(|| {
        let ids = entry
            .connections
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "unknown connection `{}` for `{}`; choose one of: {}",
            connection_id.unwrap_or(""),
            entry.id,
            ids
        )
    })?;

    let mut resolved = entry.clone();
    resolved.runtime = connection.runtime.clone();
    resolved.command = connection.command.clone().unwrap_or_default();
    resolved.args = connection.args.clone().unwrap_or_default();
    resolved.image = connection.image.clone();
    resolved.url = connection.url.clone();
    resolved.transport = connection.transport.clone();
    resolved.auth = connection.auth.clone();
    resolved.client_id = connection.client_id.clone();
    resolved.scope = connection.scope.clone();
    resolved.requires = connection.requires.clone().unwrap_or_default();
    resolved.note = connection.note.clone();
    resolved.connections.clear();
    Ok(resolved)
}

/// Split a `KEY=VALUE` pair. The value may contain `=`; the key may not, which
/// is also what the OS enforces for environment variables.
pub fn parse_kv(raw: &str) -> Result<(String, String), String> {
    let (key, value) = raw
        .split_once('=')
        .ok_or_else(|| format!("expected KEY=VALUE, got `{raw}`"))?;
    let key = key.trim();
    if key.is_empty() {
        return Err(format!("missing key in `{raw}`"));
    }
    Ok((key.to_string(), value.to_string()))
}

fn kv_map(pairs: &[String]) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for pair in pairs {
        let (k, v) = parse_kv(pair)?;
        out.insert(k, Value::String(v));
    }
    Ok(out)
}

/// Build the `POST /api/servers` payload from an optional catalog entry plus
/// command-line overrides.
///
/// `lookup_env` supplies values for a catalog entry's `requires` keys that the
/// user didn't pass explicitly. It is injected rather than read directly so this
/// stays a pure function. Anything sourced that way is treated as a secret,
/// because that is what `requires` keys are in practice (API tokens).
pub fn build_add_config(
    entry: Option<&RegistryEntry>,
    opts: &AddOptions,
    lookup_env: &dyn Fn(&str) -> Option<String>,
) -> Result<Value, String> {
    if entry.is_none() && opts.connection.is_some() {
        return Err("--connection only applies to catalog entries".into());
    }
    let resolved_entry = entry
        .map(|e| resolve_registry_connection(e, opts.connection.as_deref()))
        .transpose()?;
    let entry = resolved_entry.as_ref();
    let id = opts
        .id
        .clone()
        .or_else(|| entry.map(|e| e.id.clone()))
        .ok_or("a server id is required")?;
    if id.trim().is_empty() {
        return Err("a server id is required".into());
    }

    let runtime = opts
        .runtime
        .clone()
        .or_else(|| entry.map(|e| e.runtime.clone()))
        .unwrap_or_else(|| "process".into());
    if !matches!(runtime.as_str(), "process" | "docker" | "remote") {
        return Err(format!(
            "unknown runtime `{runtime}` (expected process, docker or remote)"
        ));
    }

    let command = opts
        .command
        .clone()
        .or_else(|| entry.map(|e| e.command.clone()))
        .unwrap_or_default();
    let image = opts.image.clone().or_else(|| entry.and_then(|e| e.image.clone()));
    let url = opts.url.clone().or_else(|| entry.and_then(|e| e.url.clone()));

    // Mirror the daemon's own validation so a mistake is caught before we make
    // a round trip, and the message can name the flag that would fix it.
    match runtime.as_str() {
        "remote" if url.is_none() => return Err("a remote server needs --url".into()),
        "docker" if image.is_none() && command.is_empty() => {
            return Err("a docker server needs --image (or --command)".into());
        }
        "process" if command.is_empty() => return Err("a process server needs --command".into()),
        _ => {}
    }

    let env = kv_map(&opts.env)?;
    let mut secrets = kv_map(&opts.secrets)?;

    // Fill a catalog entry's declared requirements from the environment, and
    // say plainly which ones are still missing rather than starting a server
    // that will immediately fail its own auth check.
    let mut missing = Vec::new();
    for key in entry.map(|e| e.requires.as_slice()).unwrap_or(&[]) {
        if env.contains_key(key) || secrets.contains_key(key) {
            continue;
        }
        match lookup_env(key) {
            Some(v) if !v.is_empty() => {
                secrets.insert(key.clone(), Value::String(v));
            }
            _ => missing.push(key.clone()),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "{} needs {}. Pass --secret KEY=VALUE (or set it in your environment).",
            entry.map(|e| e.name.as_str()).unwrap_or(id.as_str()),
            missing.join(", ")
        ));
    }

    let args: Vec<String> = if opts.args.is_empty() {
        entry.map(|e| e.args.clone()).unwrap_or_default()
    } else {
        opts.args.clone()
    };

    let mut cfg = Map::new();
    cfg.insert("id".into(), json!(id));
    cfg.insert(
        "name".into(),
        json!(
            opts.name
                .clone()
                .or_else(|| entry.map(|e| e.name.clone()))
                .unwrap_or_else(|| id.clone())
        ),
    );
    cfg.insert("runtime".into(), json!(runtime));
    cfg.insert("command".into(), json!(command));
    cfg.insert("args".into(), json!(args));
    cfg.insert("enabled".into(), json!(opts.start));
    if !env.is_empty() {
        cfg.insert("env".into(), Value::Object(env));
    }
    if !secrets.is_empty() {
        cfg.insert("secrets".into(), Value::Object(secrets));
    }
    if let Some(image) = image {
        cfg.insert("image".into(), json!(image));
    }
    if let Some(url) = url {
        cfg.insert("url".into(), json!(url));
    }
    if let Some(cwd) = &opts.cwd {
        cfg.insert("cwd".into(), json!(cwd));
    }
    if runtime == "remote"
        && let Some(entry) = entry
    {
        if let Some(t) = &entry.transport {
            cfg.insert("transport".into(), json!(t));
        }
        if let Some(a) = &entry.auth {
            cfg.insert("auth".into(), json!(a));
        }
        if let Some(c) = &entry.client_id {
            cfg.insert("clientId".into(), json!(c));
        }
        if let Some(s) = &entry.scope {
            cfg.insert("scope".into(), json!(s));
        }
    }
    Ok(Value::Object(cfg))
}

/// Merge a positional JSON object with repeated `--arg key=value` pairs into
/// the `arguments` of a `tools/call`. A `--arg` value that parses as JSON is
/// used as JSON (so numbers and booleans work); anything else stays a string,
/// which is what a shell user means by `--arg path=/tmp/x`.
pub fn parse_tool_args(json_body: Option<&str>, pairs: &[String]) -> Result<Value, String> {
    let mut out = match json_body {
        Some(raw) if !raw.trim().is_empty() => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => map,
            Ok(_) => return Err("tool arguments must be a JSON object".into()),
            Err(e) => return Err(format!("could not parse the arguments as JSON: {e}")),
        },
        _ => Map::new(),
    };
    for pair in pairs {
        let (k, v) = parse_kv(pair)?;
        let value = serde_json::from_str::<Value>(&v).unwrap_or(Value::String(v));
        out.insert(k, value);
    }
    Ok(Value::Object(out))
}

/// Render an MCP `tools/call` result the way a terminal wants it: text parts
/// joined as-is, anything else as pretty JSON so nothing is silently dropped.
pub fn render_tool_result(result: &Value) -> String {
    let mut chunks: Vec<String> = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for part in content {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => chunks.push(part.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
                _ => chunks.push(serde_json::to_string_pretty(part).unwrap_or_default()),
            }
        }
    }
    if chunks.is_empty()
        && let Some(structured) = result.get("structuredContent")
    {
        chunks.push(serde_json::to_string_pretty(structured).unwrap_or_default());
    }
    if chunks.is_empty() {
        return serde_json::to_string_pretty(result).unwrap_or_default();
    }
    chunks.join("\n")
}

/// Truncate to a column budget on a character boundary, for table output.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", head.trim_end())
}

fn print_entries(entries: &[RegistryEntry]) {
    let id_w = entries.iter().map(|e| e.id.len()).max().unwrap_or(2).max(2);
    println!("{:<id_w$}  {:<8}  {:<3}  DESCRIPTION", "ID", "RUNTIME", "", id_w = id_w);
    for e in entries {
        let marks = format!(
            "{}{}",
            if e.recommended == Some(true) { "★" } else { " " },
            if e.official == Some(true) { "✓" } else { " " }
        );
        let description = if e.connections.len() > 1 {
            format!(
                "connections: {} · {}",
                e.connections
                    .iter()
                    .map(|c| c.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
                e.description,
            )
        } else {
            e.description.clone()
        };
        println!(
            "{:<id_w$}  {:<8}  {:<3}  {}",
            e.id,
            e.runtime,
            marks,
            clip(&description, 72),
            id_w = id_w
        );
    }
    println!("\n★ recommended · ✓ official   Add one with: hypergate add <id>");
}

// ── commands ─────────────────────────────────────────────────────────────────

pub fn catalog(filter: Option<&str>) -> Result<(), String> {
    let needle = filter.map(str::to_lowercase);
    let entries: Vec<RegistryEntry> = api::registry()?
        .into_iter()
        .filter(|e| match &needle {
            None => true,
            Some(n) => {
                e.id.to_lowercase().contains(n)
                    || e.name.to_lowercase().contains(n)
                    || e.description.to_lowercase().contains(n)
            }
        })
        .collect();
    if entries.is_empty() {
        println!("Nothing in the curated catalog matches. Try: hypergate search <query>");
        return Ok(());
    }
    print_entries(&entries);
    Ok(())
}

pub fn search(query: &str) -> Result<(), String> {
    let entries = api::search_registry(query)?;
    if entries.is_empty() {
        println!("No servers in the official registry match `{query}`.");
        return Ok(());
    }
    print_entries(&entries);
    Ok(())
}

/// Search terms to try when looking an id up in the official registry.
///
/// Registry ids are slugified reverse-DNS names (`io-github-dave-london-pare-npm`)
/// but the registry's own search only matches a single term, so feeding it the
/// whole id finds nothing and `hypergate add <id>` would reject an id that
/// `hypergate search` had just printed. Try the id itself, then its most
/// distinctive segments: longest first, skipping the namespace boilerplate that
/// would match half the registry.
pub fn search_terms(id: &str) -> Vec<String> {
    const NOISE: [&str; 12] = [
        "io", "com", "net", "org", "ai", "dev", "app", "github", "gitlab", "mcp", "server", "tools",
    ];
    let mut terms = vec![id.to_string()];
    let mut segments: Vec<&str> = id.split('-').filter(|s| s.len() >= 3 && !NOISE.contains(s)).collect();
    // Longest first: the distinctive part of a name is rarely its shortest word.
    segments.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for s in segments {
        if !terms.iter().any(|t| t == s) {
            terms.push(s.to_string());
        }
    }
    // Bounded: each term is a network round trip through the daemon.
    terms.truncate(4);
    terms
}

/// Find `id` in the curated catalog, falling back to an exact-id hit in the
/// official registry so anything `hypergate search` prints is addable by id.
fn find_entry(id: &str) -> Result<Option<RegistryEntry>, String> {
    if let Some(hit) = api::registry()?.into_iter().find(|e| e.id == id) {
        return Ok(Some(hit));
    }
    for term in search_terms(id) {
        if let Some(hit) = api::search_registry(&term)
            .unwrap_or_default()
            .into_iter()
            .find(|e| e.id == id)
        {
            return Ok(Some(hit));
        }
    }
    Ok(None)
}

fn resolve_add_entry(entry: Option<RegistryEntry>, opts: &mut AddOptions) -> Result<Option<RegistryEntry>, String> {
    let connection = opts.connection.clone();
    let resolved = entry
        .map(|e| resolve_registry_connection(&e, connection.as_deref()))
        .transpose()?;
    if resolved.is_some() {
        opts.connection = None;
    }
    Ok(resolved)
}

pub fn add(target: &str, opts: &AddOptions) -> Result<(), String> {
    // An explicit launch spec means the user is defining a custom server and
    // the positional is its id; otherwise we look the positional up as a
    // catalog entry.
    let custom = opts.command.is_some() || opts.url.is_some() || opts.image.is_some();
    let entry = if custom { None } else { find_entry(target)? };
    if entry.is_none() && !custom {
        return Err(format!(
            "no catalog entry called `{target}`. Browse with `hypergate catalog`, search the official \
             registry with `hypergate search {target}`, or define one with `hypergate add {target} --command <cmd>`."
        ));
    }
    let mut opts = opts.clone();
    if custom && opts.id.is_none() {
        opts.id = Some(target.to_string());
    }
    let entry = resolve_add_entry(entry, &mut opts)?;
    if let Some(e) = &entry {
        if e.runnable == Some(false) {
            return Err(format!(
                "`{}` is registry-listed but has no runnable local config{}",
                e.id,
                e.note.as_deref().map(|n| format!(" ({n})")).unwrap_or_default()
            ));
        }
        if let Some(note) = &e.note {
            println!("note: {note}");
        }
    }

    let config = build_add_config(entry.as_ref(), &opts, &|k| std::env::var(k).ok())?;
    let id = config.get("id").and_then(Value::as_str).unwrap_or(target).to_string();
    let reply = api::add_server(&config)?;

    // A remote OAuth server comes back with a sign-in URL instead of a state.
    if let Some(auth_url) = reply.get("authUrl").and_then(Value::as_str) {
        println!("{id} needs a browser sign-in. Opening:\n  {auth_url}");
        if open::that_detached(auth_url).is_err() {
            println!("(could not open a browser, so paste the URL above)");
        }
        println!("Run `hypergate list` once you're done to confirm it connected.");
        return Ok(());
    }

    match reply.get("state").and_then(Value::as_str) {
        Some("ready") => {
            let n = reply.get("tools").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            println!("Added {id}: ready, {n} tool(s) aggregated into the gateway.");
            Ok(())
        }
        Some("errored") => Err(format!(
            "added {id}, but it failed to start: {}. See `hypergate logs {id}`.",
            reply.get("error").and_then(Value::as_str).unwrap_or("unknown error")
        )),
        Some(state) => {
            println!("Added {id}: state {state}.");
            Ok(())
        }
        None => {
            println!("Added {id}.");
            Ok(())
        }
    }
}

pub fn remove(id: &str) -> Result<(), String> {
    api::remove_server(id)?;
    println!("Removed {id}");
    Ok(())
}

pub fn tools(server: Option<&str>) -> Result<(), String> {
    let result = api::mcp("tools/list", json!({}))?;
    let all = result
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let prefix = server.map(|s| format!("{s}__"));
    let tools: Vec<&Value> = all
        .iter()
        .filter(|t| match &prefix {
            None => true,
            Some(p) => t.get("name").and_then(Value::as_str).is_some_and(|n| n.starts_with(p)),
        })
        .collect();
    if tools.is_empty() {
        match server {
            Some(s) => println!("No tools from `{s}` on the gateway. Is it running? (`hypergate list`)"),
            None => println!("The gateway exposes no tools yet. Add a server: hypergate catalog"),
        }
        return Ok(());
    }
    let name_w = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .map(str::len)
        .max()
        .unwrap_or(4);
    for t in &tools {
        let name = t.get("name").and_then(Value::as_str).unwrap_or("?");
        let desc = t.get("description").and_then(Value::as_str).unwrap_or("");
        let first_line = desc.lines().next().unwrap_or("");
        println!("{name:<name_w$}  {}", clip(first_line, 90));
    }
    println!(
        "\n{} tool(s). Call one with: hypergate call <tool> '{{\"key\":\"value\"}}'",
        tools.len()
    );
    Ok(())
}

/// Returns false when the tool itself reported an error, so the CLI can exit
/// non-zero: a failed tool call must not look like a successful one in a script.
pub fn call(tool: &str, json_body: Option<&str>, pairs: &[String]) -> Result<bool, String> {
    let arguments = parse_tool_args(json_body, pairs)?;
    let result = api::mcp("tools/call", json!({ "name": tool, "arguments": arguments }))?;
    let text = render_tool_result(&result);
    let failed = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    if failed {
        crate::diagnostic!("{text}");
    } else {
        println!("{text}");
    }
    Ok(!failed)
}

// ── `hypergate start`: the one command that turns Hypergate on ───────────────

/// What `start` should do beyond bringing the daemon up.
pub struct StartOptions {
    /// Open the manager UI in a browser.
    pub open: bool,
    /// Create the launcher, if this is the first run.
    pub shortcut: bool,
    /// Also put an icon on the desktop, now rather than only on the first run.
    pub desktop: bool,
}

/// Is this a machine where opening a browser or making a desktop icon is wrong?
///
/// Pure, with the environment injected, so every case is testable: setting real
/// env vars in a test would race the other tests in the same process.
///
/// `HYPERGATE_HEADLESS` decides outright when it is set, because no heuristic
/// covers every container, remote desktop and CI runner, and a user who is told
/// "we guessed wrong" needs something to say back.
pub fn is_headless(platform: &str, var: impl Fn(&str) -> Option<String>) -> bool {
    match var("HYPERGATE_HEADLESS").as_deref() {
        Some("1") => return true,
        Some("0") => return false,
        _ => {}
    }
    let set = |k: &str| var(k).is_some_and(|v| !v.is_empty());
    // An SSH session or a CI runner has a user, but not one who can see a window.
    if set("CI") || set("SSH_CONNECTION") || set("SSH_TTY") {
        return true;
    }
    // Windows and macOS always have a session to draw on; Linux may not.
    platform == "linux" && !set("DISPLAY") && !set("WAYLAND_DISPLAY")
}

/// `hypergate start`: bring the daemon up, and on a desktop make it usable in
/// the same breath — a launcher to click next time, and the manager on screen.
///
/// This is the whole install story after `npm install -g hypergated`, which is
/// why it does three things instead of one: a user who has just installed a
/// manager wants to see it, not to be told the next two commands to type. The
/// pieces stay available separately (`shortcut install`, `open`) and every one
/// of them can be turned off here, so the scripted and headless uses that only
/// want a daemon still get exactly that.
pub fn start(opts: &StartOptions) -> Result<(), String> {
    use std::time::Duration;

    use crate::{daemon, paths, secrets, shortcut};

    let headless = is_headless(std::env::consts::OS, |k| std::env::var(k).ok());

    // 1. The daemon. Keychain first, so it inherits HYPERGATE_TOKEN and never
    //    writes the token to disk in the clear.
    if api::is_up() {
        println!("Daemon    already running at {}", paths::base_url());
    } else {
        let _ = secrets::adopt_gateway_token();
        let pid = daemon::spawn_detached()?;
        if !daemon::wait_until_up(Duration::from_secs(20)) {
            return Err(format!("daemon (pid {pid}) did not answer /health within 20s"));
        }
        println!("Daemon    started (pid {pid}) at {}", paths::base_url());
    }

    // 2. The launcher. Once, unless asked again: someone who deleted the icon
    //    on purpose should not find it back after the next start.
    if opts.shortcut && !headless {
        let made = if opts.desktop {
            shortcut::install(true)
        } else {
            shortcut::install_once(false)
        };
        match made {
            Ok(paths) if paths.is_empty() => {}
            Ok(paths) => {
                for path in &paths {
                    println!("Launcher  {}", path.display());
                }
                if let Some(note) = shortcut::path_notice() {
                    println!("PATH      {note}");
                }
            }
            // Never fatal: the daemon is up, which is what was asked for.
            Err(e) => println!("Launcher  could not be created ({e})"),
        }
    }

    // 3. The manager.
    let url = api::ui_url();
    if opts.open && !headless {
        match open::that_detached(&url) {
            Ok(()) => println!("Manager   opened at {url}"),
            Err(e) => println!("Manager   {url}  (couldn't open a browser: {e})"),
        }
    } else {
        println!("Manager   {url}");
    }

    // 4. Whatever the daemon already knew about updates. Cached by definition:
    //    `/api/update` never fetches, so this cannot slow a start down or make
    //    one fail on a machine with no network.
    if let Ok(info) = api::update()
        && info.update_available
        && let Some(latest) = info.latest.as_deref()
    {
        println!("Update    v{latest} available — run `hypergate update --apply`");
    }
    Ok(())
}

// ── mcp-headers: the credential a client fetches instead of storing ─────────
//
// A harness that supports a headers helper (Claude Code's `headersHelper`) runs
// a command at every connection and sends whatever JSON it prints. That turns
// the gateway token from something copied into a config file once — and stale
// the moment it rotates — into something resolved fresh each time, so a token
// change, a re-created agent, or a moved port costs a reconnect rather than a
// silent "failed to connect" the user has to go diagnose.
//
// This is the command they run. Its whole contract is: one JSON object of
// headers on stdout, nothing else, ever.

/// The JSON object a headers helper writes to stdout.
///
/// Built with `serde_json` rather than `format!` so a token that somehow
/// contained a quote produces valid JSON instead of a parse error at the far end.
pub fn headers_json(token: &str) -> String {
    json!({ "Authorization": format!("Bearer {token}") }).to_string()
}

/// Resolve `key` to an agent and print its headers.
///
/// Errors go to stderr and a non-zero exit, never to stdout: the caller parses
/// stdout as JSON, so an explanation printed there would be read as a header.
pub fn mcp_headers(key: &str, create: bool) -> Result<String, String> {
    if !api::is_up() {
        return Err(format!(
            "no daemon is answering at {} — start one with `hypergate start`",
            api::ui_url()
        ));
    }
    let agent = api::resolve_client(key, create).map_err(|e| explain_resolve(key, &e))?;
    // Minting a credential is not something to do silently. stderr, because
    // stdout belongs to the client parsing this.
    if agent.created {
        crate::diagnostic!(
            "hypergate: created connected agent \"{}\" ({}), with access to every server",
            agent.name,
            agent.id
        );
    }
    Ok(headers_json(&agent.token))
}

/// Turn the daemon's machine-readable refusal into the sentence that says what
/// to do about it. The status codes come from `/api/clients/resolve`.
fn explain_resolve(key: &str, err: &str) -> String {
    if err.contains("not_found") {
        format!("no connected agent matches \"{key}\" — connect one in the manager, or pass --create to make it now")
    } else if err.contains("ambiguous") {
        format!("\"{key}\" matches more than one connected agent — name the one you mean by its id")
    } else {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> RegistryEntry {
        serde_json::from_value(json!({
            "id": "kotrain",
            "name": "Kotrain",
            "description": "Drive the local agent",
            "runtime": "process",
            "command": "kotrain",
            "args": ["mcp"],
            "official": true,
            "recommended": true,
        }))
        .unwrap()
    }

    fn opts() -> AddOptions {
        AddOptions {
            start: true,
            ..Default::default()
        }
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    /// An environment built from pairs, for the headless heuristic.
    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k: &str| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| (*v).to_string())
    }

    #[test]
    fn a_desktop_is_not_headless_but_ci_and_ssh_are() {
        for os in ["windows", "macos"] {
            assert!(!is_headless(os, no_env), "{os} always has a session to draw on");
        }
        assert!(is_headless("linux", no_env), "no DISPLAY, no window");
        assert!(!is_headless("linux", env(&[("DISPLAY", ":0")])));
        assert!(!is_headless("linux", env(&[("WAYLAND_DISPLAY", "wayland-0")])));

        for remote in ["CI", "SSH_CONNECTION", "SSH_TTY"] {
            assert!(is_headless("windows", env(&[(remote, "1")])), "{remote}");
            // Even with a display: an X server on the far end of an SSH session
            // is not somewhere to pop a browser tab.
            assert!(
                is_headless("linux", env(&[(remote, "1"), ("DISPLAY", ":0")])),
                "{remote}"
            );
        }
        // An empty value is how CI vars often arrive when they mean "not set".
        assert!(!is_headless("macos", env(&[("CI", "")])));
    }

    #[test]
    fn the_headless_override_wins_in_both_directions() {
        assert!(is_headless("macos", env(&[("HYPERGATE_HEADLESS", "1")])));
        assert!(!is_headless("linux", env(&[("HYPERGATE_HEADLESS", "0"), ("CI", "1")])));
        // Anything else is not an answer, so the heuristic still decides.
        assert!(is_headless("linux", env(&[("HYPERGATE_HEADLESS", "yes")])));
    }

    #[test]
    fn parses_key_value_pairs_including_values_with_equals() {
        assert_eq!(parse_kv("A=1").unwrap(), ("A".into(), "1".into()));
        assert_eq!(parse_kv("URL=a=b").unwrap(), ("URL".into(), "a=b".into()));
        assert_eq!(parse_kv("EMPTY=").unwrap(), ("EMPTY".into(), String::new()));
        assert!(parse_kv("NOPE").is_err());
        assert!(parse_kv("=1").is_err());
    }

    #[test]
    fn builds_a_catalog_entry_verbatim() {
        let cfg = build_add_config(Some(&entry()), &opts(), &no_env).unwrap();
        assert_eq!(cfg["id"], json!("kotrain"));
        assert_eq!(cfg["name"], json!("Kotrain"));
        assert_eq!(cfg["command"], json!("kotrain"));
        assert_eq!(cfg["args"], json!(["mcp"]));
        assert_eq!(cfg["runtime"], json!("process"));
        assert_eq!(cfg["enabled"], json!(true));
    }

    #[test]
    fn overrides_beat_the_catalog_entry() {
        let o = AddOptions {
            id: Some("kotrain-dev".into()),
            name: Some("Kotrain (dev)".into()),
            command: Some("node".into()),
            args: vec!["cli.js".into(), "mcp".into()],
            env: vec!["LOG=debug".into()],
            ..opts()
        };
        let cfg = build_add_config(Some(&entry()), &o, &no_env).unwrap();
        assert_eq!(cfg["id"], json!("kotrain-dev"));
        assert_eq!(cfg["command"], json!("node"));
        assert_eq!(cfg["args"], json!(["cli.js", "mcp"]));
        assert_eq!(cfg["env"]["LOG"], json!("debug"));
    }

    #[test]
    fn required_keys_come_from_flags_or_the_environment() {
        let mut e = entry();
        e.requires = vec!["FLY_API_TOKEN".into()];

        let err = build_add_config(Some(&e), &opts(), &no_env).unwrap_err();
        assert!(err.contains("FLY_API_TOKEN"), "{err}");

        let from_flag = AddOptions {
            secrets: vec!["FLY_API_TOKEN=abc".into()],
            ..opts()
        };
        let cfg = build_add_config(Some(&e), &from_flag, &no_env).unwrap();
        assert_eq!(cfg["secrets"]["FLY_API_TOKEN"], json!("abc"));

        let cfg = build_add_config(Some(&e), &opts(), &|k| {
            (k == "FLY_API_TOKEN").then(|| "from-env".into())
        })
        .unwrap();
        assert_eq!(cfg["secrets"]["FLY_API_TOKEN"], json!("from-env"));
        // Sourced credentials are secrets, so they're injected at launch and
        // never echoed back by the API.
        assert!(cfg.get("env").is_none());
    }

    #[test]
    fn rejects_configs_the_daemon_would_reject() {
        let custom = AddOptions {
            id: Some("mine".into()),
            ..opts()
        };
        assert!(
            build_add_config(None, &custom, &no_env)
                .unwrap_err()
                .contains("--command")
        );

        let remote = AddOptions {
            id: Some("mine".into()),
            runtime: Some("remote".into()),
            ..opts()
        };
        assert!(build_add_config(None, &remote, &no_env).unwrap_err().contains("--url"));

        let docker = AddOptions {
            id: Some("mine".into()),
            runtime: Some("docker".into()),
            ..opts()
        };
        assert!(
            build_add_config(None, &docker, &no_env)
                .unwrap_err()
                .contains("--image")
        );

        let bogus = AddOptions {
            id: Some("mine".into()),
            command: Some("x".into()),
            runtime: Some("vm".into()),
            ..opts()
        };
        assert!(
            build_add_config(None, &bogus, &no_env)
                .unwrap_err()
                .contains("unknown runtime")
        );
    }

    #[test]
    fn carries_remote_oauth_fields_from_the_entry() {
        let e: RegistryEntry = serde_json::from_value(json!({
            "id": "context7",
            "name": "Context7",
            "runtime": "remote",
            "command": "",
            "url": "https://mcp.context7.com/mcp/oauth",
            "transport": "http",
            "auth": "oauth",
        }))
        .unwrap();
        let cfg = build_add_config(Some(&e), &opts(), &no_env).unwrap();
        assert_eq!(cfg["url"], json!("https://mcp.context7.com/mcp/oauth"));
        assert_eq!(cfg["transport"], json!("http"));
        assert_eq!(cfg["auth"], json!("oauth"));
    }

    #[test]
    fn resolves_a_grouped_connection_without_leaking_defaults() {
        let e: RegistryEntry = serde_json::from_value(json!({
            "id": "github",
            "name": "GitHub",
            "runtime": "remote",
            "command": "",
            "url": "https://api.githubcopilot.com/mcp/",
            "transport": "http",
            "auth": "oauth",
            "connections": [
                {
                    "id": "oauth",
                    "label": "Auto-connect",
                    "runtime": "remote",
                    "url": "https://api.githubcopilot.com/mcp/",
                    "transport": "http",
                    "auth": "oauth"
                },
                {
                    "id": "local",
                    "label": "Run locally",
                    "runtime": "process",
                    "command": "npx",
                    "args": ["-y", "server-github"]
                }
            ]
        }))
        .unwrap();
        let cfg = build_add_config(
            Some(&e),
            &AddOptions {
                connection: Some("local".into()),
                ..opts()
            },
            &no_env,
        )
        .unwrap();
        assert_eq!(cfg["runtime"], json!("process"));
        assert_eq!(cfg["command"], json!("npx"));
        assert_eq!(cfg["args"], json!(["-y", "server-github"]));
        assert!(cfg.get("url").is_none());
        assert!(cfg.get("auth").is_none());
        assert!(cfg.get("transport").is_none());
    }

    #[test]
    fn unknown_grouped_connection_lists_available_ids() {
        let e: RegistryEntry = serde_json::from_value(json!({
            "id": "github",
            "runtime": "remote",
            "connections": [
                {"id": "oauth", "label": "Auto-connect", "runtime": "remote"},
                {"id": "token", "label": "API key or token", "runtime": "remote"}
            ]
        }))
        .unwrap();
        let err = build_add_config(
            Some(&e),
            &AddOptions {
                connection: Some("pat".into()),
                ..opts()
            },
            &no_env,
        )
        .unwrap_err();
        assert!(err.contains("oauth, token"), "{err}");
    }

    #[test]
    fn rejects_connection_flag_for_ungrouped_entry() {
        let err = build_add_config(
            Some(&entry()),
            &AddOptions {
                connection: Some("local".into()),
                ..opts()
            },
            &no_env,
        )
        .unwrap_err();
        assert_eq!(
            err,
            "entry `kotrain` has no connection options; remove `--connection local`"
        );
    }

    #[test]
    fn resolves_then_builds_grouped_entry_once() {
        let entry = || {
            serde_json::from_value::<RegistryEntry>(json!({
                "id": "github",
                "name": "GitHub",
                "runtime": "remote",
                "url": "https://api.githubcopilot.com/mcp/",
                "auth": "oauth",
                "connections": [
                    {"id": "oauth", "runtime": "remote", "url": "https://api.githubcopilot.com/mcp/", "auth": "oauth"},
                    {"id": "token", "runtime": "remote", "url": "https://api.githubcopilot.com/mcp/", "auth": "token"}
                ]
            }))
            .unwrap()
        };

        let mut token_opts = AddOptions {
            connection: Some("token".into()),
            ..opts()
        };
        let token_entry = resolve_add_entry(Some(entry()), &mut token_opts).unwrap().unwrap();
        let token_cfg = build_add_config(Some(&token_entry), &token_opts, &no_env).unwrap();
        assert!(token_opts.connection.is_none());
        assert_eq!(token_cfg["auth"], json!("token"));

        let mut default_opts = opts();
        let default_entry = resolve_add_entry(Some(entry()), &mut default_opts).unwrap().unwrap();
        let default_cfg = build_add_config(Some(&default_entry), &default_opts, &no_env).unwrap();
        assert_eq!(default_cfg["auth"], json!("oauth"));
    }

    #[test]
    fn explicit_flags_override_the_selected_connection() {
        let e: RegistryEntry = serde_json::from_value(json!({
            "id": "github",
            "runtime": "remote",
            "connections": [
                {
                    "id": "local",
                    "label": "Run locally",
                    "runtime": "process",
                    "command": "npx"
                }
            ]
        }))
        .unwrap();
        let cfg = build_add_config(
            Some(&e),
            &AddOptions {
                connection: Some("local".into()),
                runtime: Some("docker".into()),
                image: Some("ghcr.io/example/server".into()),
                ..opts()
            },
            &no_env,
        )
        .unwrap();
        assert_eq!(cfg["runtime"], json!("docker"));
        assert_eq!(cfg["image"], json!("ghcr.io/example/server"));
    }

    #[test]
    fn no_start_leaves_the_server_disabled() {
        let o = AddOptions { start: false, ..opts() };
        let cfg = build_add_config(Some(&entry()), &o, &no_env).unwrap();
        assert_eq!(cfg["enabled"], json!(false));
    }

    #[test]
    fn merges_json_and_kv_tool_arguments() {
        let args = parse_tool_args(Some(r#"{"text":"nyaa"}"#), &["count=3".into(), "path=/tmp/a".into()]).unwrap();
        assert_eq!(args["text"], json!("nyaa"));
        assert_eq!(args["count"], json!(3)); // JSON-parsable → typed
        assert_eq!(args["path"], json!("/tmp/a")); // not JSON → string
        assert_eq!(parse_tool_args(None, &[]).unwrap(), json!({}));
        assert!(parse_tool_args(Some("[1]"), &[]).is_err());
        assert!(parse_tool_args(Some("{oops"), &[]).is_err());
    }

    #[test]
    fn renders_text_content_and_falls_back_to_json() {
        let text = render_tool_result(&json!({ "content": [{ "type": "text", "text": "hello" }] }));
        assert_eq!(text, "hello");

        let structured = render_tool_result(&json!({ "content": [], "structuredContent": { "n": 1 } }));
        assert!(structured.contains("\"n\": 1"));

        let unknown = render_tool_result(&json!({ "weird": true }));
        assert!(unknown.contains("weird"));
    }

    #[test]
    fn derives_usable_search_terms_from_a_registry_id() {
        // The registry matches one term at a time, so the whole id finds
        // nothing and the distinctive segments have to be tried too.
        let terms = search_terms("io-github-dave-london-pare-npm");
        assert_eq!(terms[0], "io-github-dave-london-pare-npm");
        assert!(terms.contains(&"london".to_string()));
        assert!(terms.contains(&"pare".to_string()));
        // Namespace boilerplate would match half the registry.
        assert!(!terms.iter().any(|t| t == "io" || t == "github"));
        assert!(terms.len() <= 4, "each term is a round trip: {terms:?}");

        // Longest segment first.
        let terms = search_terms("io-github-nekzus-npm-sentinel-mcp");
        assert_eq!(terms[1], "sentinel");
        assert!(!terms.iter().any(|t| t == "mcp"));

        // A plain id is just itself.
        assert_eq!(search_terms("kotrain"), vec!["kotrain"]);
    }

    #[test]
    fn clips_on_character_boundaries() {
        assert_eq!(clip("hello", 10), "hello");
        assert_eq!(clip("hello world", 8), "hello w…");
        assert_eq!(clip("日本語テスト", 4), "日本語…");
    }

    #[test]
    fn headers_json_is_one_object_a_client_can_parse() {
        let out = headers_json("deadbeef");
        let parsed: Value = serde_json::from_str(&out).expect("valid JSON");
        assert_eq!(parsed["Authorization"], "Bearer deadbeef");
        // Exactly one key: anything else would be sent as a header too.
        assert_eq!(parsed.as_object().unwrap().len(), 1);
        // Single line, so a helper's output is never split across records.
        assert!(!out.contains('\n'));
    }

    #[test]
    fn headers_json_escapes_rather_than_breaking() {
        let parsed: Value = serde_json::from_str(&headers_json("we\"ird\\")).expect("valid JSON");
        assert_eq!(parsed["Authorization"], "Bearer we\"ird\\");
    }

    #[test]
    fn resolve_failures_say_what_to_do_next() {
        let miss = explain_resolve("claude-code", "/api/clients/resolve failed (404): not_found");
        assert!(miss.contains("--create"), "{miss}");
        assert!(miss.contains("claude-code"), "{miss}");

        let twins = explain_resolve("claude-code", "/api/clients/resolve failed (409): ambiguous");
        assert!(twins.contains("more than one"), "{twins}");

        // Anything else is passed through rather than guessed at.
        let other = explain_resolve("claude-code", "connection refused");
        assert_eq!(other, "connection refused");
    }

    #[test]
    fn curated_install_parser_only_accepts_known_plain_launchers() {
        assert_eq!(
            parse_curated_install("npm install -g wrangler").unwrap(),
            vec!["npm", "install", "-g", "wrangler"]
        );
        for instruction in [
            "https://bun.sh",
            "Build from github.com/nekko-labs/kotrain",
            "Comes with Node.js",
            "curl https://example.test/install.sh | sh",
        ] {
            assert!(parse_curated_install(instruction).is_none(), "{instruction}");
        }
    }
}
