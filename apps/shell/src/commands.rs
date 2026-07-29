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

use crate::api::{self, RegistryEntry};

/// Everything `hypergate add` can override on top of a catalog entry.
#[derive(Debug, Default, Clone)]
pub struct AddOptions {
    pub id: Option<String>,
    pub name: Option<String>,
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
        println!(
            "{:<id_w$}  {:<8}  {:<3}  {}",
            e.id,
            e.runtime,
            marks,
            clip(&e.description, 72),
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
        eprintln!("{text}");
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
}
