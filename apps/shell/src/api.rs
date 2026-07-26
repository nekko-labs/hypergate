//! A thin client for the daemon's existing HTTP management API.
//!
//! The CLI and the tray are both *clients* of the daemon, never a second
//! implementation of it. Everything here is a call the web UI already makes, so
//! there is exactly one place where server lifecycle logic lives.

use serde::Deserialize;
use std::time::Duration;

use crate::paths;

/// Short timeout: every call is to localhost, so a slow reply means trouble,
/// not latency, and a tray menu must never hang on a wedged daemon.
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
pub struct Health {
    pub ok: bool,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub servers: u32,
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    pub url: String,
    pub token: String,
    #[serde(default)]
    pub stdio_command: String,
    #[serde(default)]
    pub ui_url: String,
}

#[derive(Debug, Deserialize)]
pub struct Logs {
    #[serde(default)]
    pub logs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    #[serde(default)]
    pub total_calls: u64,
    #[serde(default)]
    pub total_errors: u64,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .build()
        .into()
}

/// GET and deserialize. The bearer token is attached when we have one; the
/// management API only requires it for `/mcp`, but sending it is harmless and
/// keeps this uniform if that tightens later.
fn get<T: for<'de> Deserialize<'de>>(path: &str) -> Result<T, String> {
    let url = format!("{}{}", paths::base_url(), path);
    let mut req = agent().get(&url);
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    let body = req
        .call()
        .map_err(|e| format!("{e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("{e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from {path}: {e}"))
}

/// POST with no body, discarding the response. Used for the lifecycle actions.
fn post(path: &str) -> Result<(), String> {
    let url = format!("{}{}", paths::base_url(), path);
    let mut req = agent().post(&url);
    if let Some(token) = crate::secrets::gateway_token() {
        req = req.header("Authorization", &format!("Bearer {token}"));
    }
    req.send_empty().map_err(|e| format!("{e}"))?;
    Ok(())
}

pub fn health() -> Result<Health, String> {
    get("/health")
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

pub fn logs(id: &str) -> Result<Logs, String> {
    get(&format!("/api/servers/{id}/logs"))
}

pub fn start_server(id: &str) -> Result<(), String> {
    post(&format!("/api/servers/{id}/start"))
}

pub fn stop_server(id: &str) -> Result<(), String> {
    post(&format!("/api/servers/{id}/stop"))
}

/// The manager UI, which the daemon serves at `/` on the same port.
pub fn ui_url() -> String {
    format!("{}/", paths::base_url())
}
