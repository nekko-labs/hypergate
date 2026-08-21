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
        TIMEOUT,
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
        TIMEOUT,
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
    let mut req = agent(TIMEOUT).delete(&url);
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let mut res = req.call().map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().map_err(|e| format!("{e}"))?;
    let body = check(status, text, "/api/credentials", true)?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from credential delete: {e}"))
}

/// Resolve allowed credentials into env vars. `agent` narrows the master scope
/// to one agent's allow-list (and attributes the fetch to it); `ids` narrows to
/// specific credentials. The values are in the reply: hand them straight to a
/// child process's env and nowhere else.
pub fn resolve_credentials(agent_key: Option<&str>, ids: &[String]) -> Result<serde_json::Value, String> {
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
    let text = send(
        "/api/credentials/resolve",
        Some(&serde_json::Value::Object(body)),
        TIMEOUT,
    )?;
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from credential resolve: {e}"))
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
pub fn ui_url() -> String {
    format!("{}/", paths::base_url())
}
