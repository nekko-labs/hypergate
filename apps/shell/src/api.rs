//! A thin client for the daemon's existing HTTP management API.
//!
//! The CLI and the tray are both *clients* of the daemon, never a second
//! implementation of it. Everything here is a call the web UI already makes, so
//! there is exactly one place where server lifecycle logic lives.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::paths;

/// Short timeout: every call is to localhost, so a slow reply means trouble,
/// not latency, and a tray menu must never hang on a wedged daemon.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Adding a server can spawn `npx`, pull a Docker image, or reach a remote
/// endpoint, so it gets a far longer budget than a status poll. Same for tool
/// calls, which run whatever the managed server does.
const SLOW_TIMEOUT: Duration = Duration::from_secs(180);

/// A call the daemon may answer only after an OS consent prompt (credential
/// lockdown): a person has to notice it, read it, and answer it. The daemon
/// gives the prompt 120 seconds; this outlasts that so the daemon's own answer,
/// not a client timeout, is what the user sees.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(150);

#[derive(Debug, Deserialize, Serialize)]
pub struct Health {
    pub ok: bool,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub servers: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub runtime: String,
    pub state: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub stdio_command: String,
    #[serde(default)]
    pub ui_url: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Logs {
    #[serde(default)]
    pub logs: Vec<String>,
}

/// One connected agent: a scoped gateway token with a name. Only the fields the
/// CLI needs; the daemon owns the rest.
#[derive(Debug, Deserialize, Serialize)]
pub struct AgentClient {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub token: String,
    /// Set when this call is what brought the agent into existence.
    #[serde(default)]
    pub created: bool,
}

/// A catalog entry, curated or from a registry search. Only the fields the CLI
/// prints or copies into an add payload; the daemon owns the full shape.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub runtime: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub official: Option<bool>,
    #[serde(default)]
    pub recommended: Option<bool>,
    #[serde(default)]
    pub runnable: Option<bool>,
    #[serde(default)]
    pub connections: Vec<RegistryConnection>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConnection {
    pub id: String,
    pub runtime: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub requires: Option<Vec<String>>,
    #[serde(default)]
    pub note: Option<String>,
}

/// `/api/update`: the daemon's view of versions, and what updating takes here.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub update_available: bool,
    /// npm · installer · repo · unknown (see `detectInstallChannel` in core).
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub can_apply: bool,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub release_url: Option<String>,
}

/// What the manager window's close button should do.
///
/// `Ask` is the first-run state: we put the question in the window rather than
/// guessing, because one answer throws away a running gateway and the other
/// leaves it running when the user meant to stop it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CloseAction {
    #[default]
    Ask,
    Tray,
    Quit,
}

impl CloseAction {
    fn parse(s: &str) -> Self {
        match s {
            "tray" => Self::Tray,
            "quit" => Self::Quit,
            _ => Self::Ask,
        }
    }
}

/// `/api/settings`. Only the fields the shell acts on; the daemon owns the rest.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub close_action: String,
    #[serde(default)]
    pub start_minimized: bool,
}

/// The close-button preference, or `Ask` when the daemon can't be reached — the
/// safe default, since asking never destroys anything.
pub fn close_action() -> CloseAction {
    get::<Settings>("/api/settings")
        .map(|s| CloseAction::parse(&s.close_action))
        .unwrap_or_default()
}

/// Should a login-time launch stay in the tray rather than open the manager?
/// Defaults to yes: a window appearing unbidden at every sign-in is the worse
/// thing to do when we cannot ask.
pub fn start_minimized() -> bool {
    get::<Settings>("/api/settings")
        .map(|s| s.start_minimized)
        .unwrap_or(true)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    #[serde(default)]
    pub total_calls: u64,
    #[serde(default)]
    pub total_errors: u64,
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        // Read the body ourselves on 4xx/5xx: the daemon answers with a useful
        // `{"error":…}`, and turning the status into an opaque transport error
        // would throw it away.
        .http_status_as_error(false)
        .build()
        .into()
}

/// Turn a daemon reply into either its body or the message it explains itself
/// with, so the CLI can say "id_exists" rather than "HTTP status 409".
fn check(status: u16, body: String, path: &str, authenticated: bool) -> Result<String, String> {
    if authenticated && status == 401 {
        // A daemon can rotate its master token while the shell is alive. Drop
        // the cached answer before reporting the rejection so the next call
        // gets a chance to recover from the keychain.
        crate::secrets::forget_gateway_token();
    }
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str().map(str::to_string)))
        .unwrap_or_else(|| body.trim().chars().take(200).collect());
    Err(if detail.is_empty() {
        format!("{path} failed ({status})")
    } else {
        format!("{path} failed ({status}): {detail}")
    })
}

/// GET and deserialize. The bearer token is attached when we have one; the
/// management API only requires it for `/mcp`, but sending it is harmless and
/// keeps this uniform if that tightens later.
fn get_inner<T: for<'de> Deserialize<'de>>(path: &str, authenticate: bool) -> Result<T, String> {
    let url = format!("{}{}", paths::base_url(), path);
    let mut req = agent(TIMEOUT).get(&url);
    if authenticate && let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let mut res = req.call().map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let body = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    let body = check(status, body, path, authenticate)?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from {path}: {e}"))
}

fn get<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    get_inner(path, true)
}

/// POST with no body, discarding the response. Used for the lifecycle actions.
fn post(path: &str) -> Result<(), String> {
    send(path, None, TIMEOUT).map(|_| ())
}

/// POST an optional JSON body and return the raw reply. One place for every
/// mutating call, so status handling and auth can't drift between them.
fn send(path: &str, body: Option<&serde_json::Value>, timeout: Duration) -> Result<String, String> {
    let url = format!("{}{}", paths::base_url(), path);
    let mut req = agent(timeout).post(&url);
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let mut res = match body {
        Some(b) => req.send_json(b).map_err(|e| format!("{e}"))?,
        None => req.send_empty().map_err(|e| format!("{e}"))?,
    };
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    check(status, text, path, true)
}

fn delete(path: &str) -> Result<(), String> {
    let url = format!("{}{}", paths::base_url(), path);
    let mut req = agent(TIMEOUT).delete(&url);
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let mut res = req.call().map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    check(status, text, path, true).map(|_| ())
}

fn patch(path: &str, body: &serde_json::Value) -> Result<String, String> {
    let url = format!("{}{}", paths::base_url(), path);
    let mut req = agent(TIMEOUT).patch(&url);
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let mut res = req.send_json(body).map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    check(status, text, path, true)
}

/// DELETE with a JSON body, returning the raw reply (the plain `delete` above
/// discards it).
fn delete_json(path: &str, body: &serde_json::Value) -> Result<String, String> {
    let url = format!("{}{}", paths::base_url(), path);
    let mut req = agent(TIMEOUT).delete(&url).force_send_body();
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let mut res = req.send_json(body).map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    check(status, text, path, true)
}

/// Which harnesses have a Hypergate block in their global instructions. Local
/// file reads only, so `hypergate start` can afford to ask.
pub fn instructions_status() -> Result<serde_json::Value, String> {
    get(&instructions_status_path(&crate::commands::instruction_homes()))
}

/// `/api/instructions`, carrying the same config-home overrides a write sends,
/// so status describes the files `install` and `remove` would touch.
pub fn instructions_status_path(homes: &serde_json::Map<String, serde_json::Value>) -> String {
    let query: Vec<String> = homes
        .iter()
        .filter_map(|(k, v)| v.as_str().map(|v| format!("{k}={}", pct(v))))
        .collect();
    if query.is_empty() {
        "/api/instructions".into()
    } else {
        format!("/api/instructions?{}", query.join("&"))
    }
}

/// Percent-encode a query value (RFC 3986 unreserved characters pass through).
fn pct(v: &str) -> String {
    v.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// The route for one harness id (or `all`). Ids are plain slugs, checked here
/// so nothing else can ride into the path.
fn instructions_path(harness: &str) -> Result<String, String> {
    if harness.is_empty()
        || !harness
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "`{harness}` is not a harness id (see `hypergate instructions status`)"
        ));
    }
    Ok(format!("/api/instructions/{harness}"))
}

pub fn install_instructions(harness: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let path = instructions_path(harness)?;
    let text = send(&path, Some(body), TIMEOUT)?;
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from {path}: {e}"))
}

pub fn remove_instructions(harness: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let path = instructions_path(harness)?;
    let text = delete_json(&path, body)?;
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from {path}: {e}"))
}

pub fn health() -> Result<Health, String> {
    // The daemon deliberately leaves this probe unauthenticated. Apart from
    // being sufficient to answer "is it alive?", keeping it token-free means
    // startup readiness never has to touch a potentially blocking keychain.
    get_inner("/health", false)
}

/// Is a daemon already serving on our port?
pub fn is_up() -> bool {
    health().map(|h| h.ok).unwrap_or(false)
}

pub fn servers() -> Result<Vec<ServerStatus>, String> {
    get("/api/servers")
}

pub fn gateway() -> Result<GatewayInfo, String> {
    get("/api/gateway")
}

pub fn analytics() -> Result<Analytics, String> {
    get("/api/analytics")
}

pub fn analytics_value() -> Result<serde_json::Value, String> {
    get("/api/analytics")
}

pub fn servers_value() -> Result<serde_json::Value, String> {
    get("/api/servers")
}

pub fn logs_value(id: &str) -> Result<serde_json::Value, String> {
    get(&format!("/api/servers/{id}/logs"))
}

pub fn agents() -> Result<serde_json::Value, String> {
    get("/api/clients")
}

pub fn add_agent(name: &str, servers: &[String], target: Option<&str>) -> Result<serde_json::Value, String> {
    let scope = if servers.is_empty() {
        serde_json::Value::String("*".into())
    } else {
        serde_json::Value::Array(servers.iter().cloned().map(serde_json::Value::String).collect())
    };
    let body = send(
        "/api/clients",
        Some(&serde_json::json!({ "name": name, "servers": scope, "target": target })),
        TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from /api/clients: {e}"))
}

pub fn remove_agent(id: &str) -> Result<(), String> {
    delete(&format!("/api/clients/{id}"))
}

pub fn set_agent_credential(id: &str, credential: &str, allowed: bool) -> Result<serde_json::Value, String> {
    let body = send(
        &format!("/api/clients/{id}/credentials/{credential}"),
        Some(&serde_json::json!({ "allowed": allowed })),
        // Under lockdown, a grant waits on an OS prompt.
        PROMPT_TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from credential permission update: {e}"))
}

pub fn set_agent_server(id: &str, server: &str, allowed: bool) -> Result<serde_json::Value, String> {
    let body = send(
        &format!("/api/clients/{id}/servers/{server}"),
        Some(&serde_json::json!({ "allowed": allowed })),
        TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from agent permission update: {e}"))
}

pub fn rename_agent(id: &str, name: &str) -> Result<serde_json::Value, String> {
    let body = patch(&format!("/api/clients/{id}"), &serde_json::json!({ "name": name }))?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from agent rename: {e}"))
}

pub fn rotate_agent(id: &str) -> Result<serde_json::Value, String> {
    let body = send(&format!("/api/clients/{id}/token"), None, TIMEOUT)?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from agent rotation: {e}"))
}

pub fn connect_targets() -> Result<serde_json::Value, String> {
    get("/api/connect/targets")
}

pub fn connect_agent(id: &str, target: &str) -> Result<serde_json::Value, String> {
    let body = send(
        &format!("/api/clients/{id}/connect"),
        Some(&serde_json::json!({ "target": target })),
        SLOW_TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from connect: {e}"))
}

pub fn agent_connect_info(id: &str) -> Result<serde_json::Value, String> {
    get(&format!("/api/clients/{id}/connect"))
}

pub fn cli_status() -> Result<serde_json::Value, String> {
    get("/api/clis")
}

pub fn cli_catalog() -> Result<serde_json::Value, String> {
    get("/api/clis/catalog")
}

pub fn cli_search(query: &str) -> Result<serde_json::Value, String> {
    let encoded: String = query
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            other => format!("%{other:02X}"),
        })
        .collect();
    get(&format!("/api/clis/search?q={encoded}"))
}

pub fn cli_check(command: &str) -> Result<serde_json::Value, String> {
    get(&format!("/api/clis/check?name={command}"))
}

/// Find the connected agent a key names, optionally creating it.
///
/// The key is an agent id, its display name, or the stem of an id that no longer
/// exists — the daemon owns that resolution (see `matchAgents` in core) so the
/// CLI and the web UI can never disagree about which agent a config meant.
pub fn resolve_client(key: &str, create: bool) -> Result<AgentClient, String> {
    let body = send(
        "/api/clients/resolve",
        Some(&serde_json::json!({ "key": key, "create": create })),
        TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from /api/clients/resolve: {e}"))
}

// ── the credential vault ─────────────────────────────────────────────────────
// Every mutation needs the master token, which `send`/`delete` already attach.
// Reads return metadata + masked hints; values only ever come back through
// `resolve_credentials`, which exists so `hypergate run` can inject them into
// a child's env without printing them.

pub fn credentials() -> Result<serde_json::Value, String> {
    get("/api/credentials")
}

/// Logins kept outside the vault, as the daemon's sweep finds them (masked).
pub fn ambient() -> Result<serde_json::Value, String> {
    get("/api/ambient")
}

/// Move one ambient login into the vault. Finding ids are `rule-hex`, so they
/// go into the path as they are; anything else is refused before the request.
pub fn ambient_import(id: &str) -> Result<serde_json::Value, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("`{id}` is not a finding id; `hypergate cred sweep` lists them"));
    }
    let path = format!("/api/ambient/{id}/import");
    let text = send(&path, None, SLOW_TIMEOUT)?;
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from {path}: {e}"))
}

pub fn credential_guides() -> Result<serde_json::Value, String> {
    get("/api/credentials/guides")
}

pub fn add_credential(
    name: &str,
    value: &str,
    service: Option<&str>,
    env_var: Option<&str>,
) -> Result<serde_json::Value, String> {
    let body = send(
        "/api/credentials",
        Some(&serde_json::json!({ "name": name, "value": value, "service": service, "envVar": env_var })),
        // Under lockdown, adding a key waits on an OS prompt.
        PROMPT_TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from /api/credentials: {e}"))
}

pub fn roll_credential(id: &str, value: &str) -> Result<serde_json::Value, String> {
    let body = send(
        &format!("/api/credentials/{id}/roll"),
        Some(&serde_json::json!({ "value": value })),
        // Rolling restarts every server that references the credential.
        SLOW_TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from credential roll: {e}"))
}

pub fn delete_credential(id: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/credentials/{id}", paths::base_url());
    // Under lockdown, deleting a key waits on an OS prompt.
    let mut req = agent(PROMPT_TIMEOUT).delete(&url);
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let mut res = req.call().map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    let body = check(status, text, "/api/credentials", true)?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from credential delete: {e}"))
}

/// The body of a resolve call. `program` is the absolute path `hypergate run` is
/// about to start and `args` its arguments: under credential lockdown the daemon
/// checks both (the program must be the real one and bound to the credential,
/// and the arguments must not be a token-printing subcommand). Outside lockdown
/// the daemon ignores them, so sending them always is harmless.
pub fn resolve_body(
    agent_key: Option<&str>,
    ids: &[String],
    program: Option<&str>,
    args: &[String],
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    if let Some(a) = agent_key {
        body.insert("agent".into(), serde_json::Value::String(a.into()));
    }
    if !ids.is_empty() {
        body.insert(
            "ids".into(),
            serde_json::Value::Array(ids.iter().cloned().map(serde_json::Value::String).collect()),
        );
    }
    if let Some(p) = program {
        body.insert("program".into(), serde_json::Value::String(p.into()));
        body.insert(
            "args".into(),
            serde_json::Value::Array(args.iter().cloned().map(serde_json::Value::String).collect()),
        );
    }
    serde_json::Value::Object(body)
}

/// Resolve allowed credentials into env vars. `agent` narrows the master scope
/// to one agent's allow-list (and attributes the fetch to it); `ids` narrows to
/// specific credentials. The values are in the reply: hand them straight to a
/// child process's env and nowhere else.
pub fn resolve_credentials(
    agent_key: Option<&str>,
    ids: &[String],
    program: Option<&str>,
    args: &[String],
) -> Result<serde_json::Value, String> {
    let text = send(
        "/api/credentials/resolve",
        Some(&resolve_body(agent_key, ids, program, args)),
        // Under lockdown a bare-master resolve waits on an OS prompt.
        PROMPT_TIMEOUT,
    )?;
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from credential resolve: {e}"))
}

// ── credential lockdown ──────────────────────────────────────────────────────

pub fn lockdown_status() -> Result<serde_json::Value, String> {
    get("/api/lockdown")
}

/// Turn lockdown on or off. Off waits on an OS prompt when lockdown is on.
pub fn set_lockdown(enabled: bool) -> Result<serde_json::Value, String> {
    let body = send(
        "/api/lockdown",
        Some(&serde_json::json!({ "enabled": enabled })),
        PROMPT_TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from /api/lockdown: {e}"))
}

/// The body of a programs update: a list binds exactly those, `None` restores
/// the guide default.
pub fn programs_body(programs: Option<&[String]>) -> serde_json::Value {
    match programs {
        Some(list) => serde_json::json!({ "programs": list }),
        None => serde_json::json!({ "programs": serde_json::Value::Null }),
    }
}

/// Bind a credential to programs. Waits on an OS prompt under lockdown.
pub fn set_credential_programs(id: &str, programs: Option<&[String]>) -> Result<serde_json::Value, String> {
    let body = send(
        &format!("/api/credentials/{id}/programs"),
        Some(&programs_body(programs)),
        PROMPT_TIMEOUT,
    )?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from credential programs update: {e}"))
}

/// What the daemon last knew about updates. Never hits the network.
pub fn update() -> Result<UpdateInfo, String> {
    get("/api/update")
}

/// Ask the daemon to check the feed now (it caches for a day unless forced).
pub fn update_check() -> Result<UpdateInfo, String> {
    let body = send("/api/update/check", None, SLOW_TIMEOUT)?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from /api/update/check: {e}"))
}

/// Stop the daemon through its own API (needs the master token, which `get`/`send`
/// already attach). Used by the updater when there is no tray to quit.
pub fn shutdown() -> Result<(), String> {
    post("/api/shutdown")
}

pub fn logs(id: &str) -> Result<Logs, String> {
    get(&format!("/api/servers/{id}/logs"))
}

pub fn start_server(id: &str) -> Result<(), String> {
    post(&format!("/api/servers/{id}/start"))
}

pub fn stop_server(id: &str) -> Result<(), String> {
    post(&format!("/api/servers/{id}/stop"))
}

pub fn restart_server(id: &str) -> Result<(), String> {
    post(&format!("/api/servers/{id}/restart"))
}

/// The curated catalog the UI shows (no network: it's compiled into the daemon).
pub fn registry() -> Result<Vec<RegistryEntry>, String> {
    get("/api/registry")
}

/// Search the official MCP registry through the daemon (the one outbound call,
/// and only because the user asked for it).
pub fn search_registry(query: &str) -> Result<Vec<RegistryEntry>, String> {
    let encoded: String = query
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            other => format!("%{other:02X}"),
        })
        .collect();
    get(&format!("/api/registry/search?q={encoded}"))
}

/// Add a managed server. Returns the daemon's reply verbatim: it may carry a
/// `state`, an `authUrl` for a remote server awaiting sign-in, or an `error`.
pub fn add_server(config: &serde_json::Value) -> Result<serde_json::Value, String> {
    let body = send("/api/servers", Some(config), SLOW_TIMEOUT)?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from /api/servers: {e}"))
}

pub fn remove_server(id: &str) -> Result<(), String> {
    delete(&format!("/api/servers/{id}"))
}

/// One JSON-RPC round trip against the aggregating gateway at `/mcp`.
///
/// The gateway is stateless (a fresh transport + gateway per POST), so this is
/// a plain request/response with no session to keep. Going through `/mcp`
/// rather than an internal shortcut is the point: `hypergate tools` and
/// `hypergate call` exercise exactly what a connected agent would.
pub fn mcp(method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let gw = gateway()?;
    let url = if gw.url.is_empty() {
        format!("{}/mcp", paths::base_url())
    } else {
        gw.url.clone()
    };
    let mut res = agent(SLOW_TIMEOUT)
        .post(&url)
        .header("Authorization", &format!("Bearer {}", gw.token))
        .header("Accept", "application/json, text/event-stream")
        .send_json(serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    let body = check(status, text, "/mcp", true)?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("the gateway returned a non-JSON reply: {e}"))?;
    if let Some(err) = value.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        return Err(format!("gateway error: {msg}"));
    }
    Ok(value.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

/// The manager UI, which the daemon serves at `/` on the same port.
///
/// `HYPERGATE_UI_URL` swaps in another one, which is how `npm run dev` puts
/// the Vite dev server (hot reload) in the native window instead of the
/// daemon's built copy. Loopback only: the window hands its page an IPC
/// channel, and that is not something to give a page from elsewhere.
pub fn ui_url() -> String {
    std::env::var("HYPERGATE_UI_URL")
        .ok()
        .and_then(|url| loopback_url(&url))
        .unwrap_or_else(|| format!("{}/", paths::base_url()))
}

/// `url` when it is plain http on this machine (`localhost`, `127.0.0.1`,
/// `[::1]`), else `None`.
fn loopback_url(url: &str) -> Option<String> {
    let url = url.trim();
    let rest = url.strip_prefix("http://")?;
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // No credentials: `http://localhost@evil.example` is a host of evil.example.
    if host_port.contains('@') {
        return None;
    }
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next().map(|h| format!("[{h}]"))?,
        None => host_port.split(':').next().unwrap_or_default().to_string(),
    };
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]").then(|| url.to_string())
}

#[cfg(test)]
mod ui_url_tests {
    use super::loopback_url;

    #[test]
    fn accepts_loopback_http() {
        for url in [
            "http://localhost:5180/",
            "http://127.0.0.1:5180",
            "http://[::1]:5180/",
            "http://LocalHost/",
        ] {
            assert_eq!(loopback_url(url).as_deref(), Some(url), "{url}");
        }
    }

    #[test]
    fn refuses_everything_else() {
        for url in [
            "https://localhost:5180/",
            "http://localhost.evil.example/",
            "http://localhost@evil.example/",
            "http://evil.example/?localhost",
            "file:///C:/x.html",
            "",
        ] {
            assert_eq!(loopback_url(url), None, "{url}");
        }
    }
}
