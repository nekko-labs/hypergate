---
status: active
created: 2026-06-28
owner: Philip
type: code
---

# NekkoMCP — Spec

> **Source of truth for *what* NekkoMCP is and *why*.** The *how* (stack, architecture, conventions, backlog) lives in [`TASKS.md`](TASKS.md). Living document: every shipped feature gets a status + release-version entry here; new work is broken down in `TASKS.md` first.

## 1. Vision & Positioning

**NekkoMCP** is an **open-source, local-first runtime and manager for MCP (Model Context Protocol) servers** — a ToolHive rival you actually own. It securely runs MCP servers, supervises them, and exposes them through a single gateway endpoint that any agent harness (Claude Code, Cursor, **Open Paw**, Codex, VS Code) can connect to.

It is **not just a connector list** — it is a proper MCP *server runtime*: it launches servers, isolates them, manages their secrets, watches their health, and aggregates them.

| It rivals | …and wins by |
| --- | --- |
| **ToolHive** (Stacklok) | Fully local-first and free, **no Docker requirement** (Docker is opt-in, not mandatory), with a beautiful built-in UI and a one-paste gateway URL. Self-host the registry/gateway; nothing phones home. |
| **Docker MCP Toolkit** | Doesn't require Docker Desktop; runs servers as sandboxed processes by default; cross-platform. |
| **MetaMCP / MCPHub** | A real supervisor with isolation + secrets + health, not just a proxy; first-class agent-harness integration; a polished UI. |

**Two faces, one engine:**
1. **Standalone app** — its own UI (served by the daemon; Electron later) to add, configure, run, and monitor MCP servers; rivals ToolHive's portal.
2. **First-class Open Paw integration** — Open Paw (already an MCP *client*) auto-detects the daemon, connects the gateway in one click, and opens this manager in a workbench pane. (Shipped natively in the open-paw repo against the daemon API; the `@nekko-mcp/ui` embeddable-package idea is parked unless a deeper embed is wanted.)

**The four feelings we sell:**
1. **Secure by choice** — pick your isolation at setup (containers *or* sandboxed processes); we make the tradeoff explicit, never force Docker.
2. **One endpoint** — run many servers, expose one gateway URL; paste it into any harness.
3. **Yours, local, free** — open source (MIT), nekko-labs org; runs on your machine, no account required.
4. **See everything** — routing through one gateway means a free, private audit trail: which tool, called by which client, how much data — visible in the Analytics tab, never leaving the machine.

### Isolation model (user-selectable at setup)

NekkoMCP lets the user choose the runtime per install (and per server override). We surface the tradeoffs plainly:

| Runtime | Isolation | Pros | Cons |
| --- | --- | --- | --- |
| **Process sandbox** (default, no deps) | Child process: scrubbed/allow-listed env, injected secrets only, restricted CWD, resource limits (cpu/mem/file-descriptor), optional network-egress allow-list, no shell | Zero dependencies, instant start, cross-platform, lightest; great for solo/local dev | Weaker boundary than a container (shares the kernel/user); a malicious server has more reach than in a container |
| **Docker container** (opt-in) | Container-per-server: image pinned, read-only rootfs where possible, dropped caps, network policy, CPU/mem limits, secrets via env/files | Strong isolation + reproducibility + audit; ToolHive-grade | Requires Docker installed/running; slower cold start; heavier on resources |
| **Remote** (hosted) | No local process at all: the gateway holds an HTTP/SSE client to a provider's hosted MCP endpoint, authenticated with OAuth. Isolation is the provider's problem; the credential is an OAuth token stored locally, never a spawned command | Nothing to install or sandbox; official first-party servers (GitHub, Context7, …); one-click browser sign-in | Trusts the provider; needs network; the server's behavior is out of our hands |

Default = **process sandbox** (works everywhere); **Docker** for container isolation; **Remote** for hosted first-party servers. The choice is a setup step and overridable per server.

### Scope boundaries (deliberate)
- **Local-first**: the runtime + gateway run on the user's machine; no account or cloud required. A hosted/team tier may come later. The daemon makes no outbound calls **on its own**; the only network traffic is user-initiated: **registry search** (while the user types a query, never on boot), **catalog popularity** (npm downloads + GitHub stars, fetched only when the user opens the catalog and cached 24h — never on boot), and **remote servers** the user adds — connecting to their hosted MCP endpoint plus the OAuth login/token exchange for those that need it. OAuth tokens are stored locally under `~/.nekko-mcp/oauth/` and nothing phones home. CLI detection is fully local (a shell-free PATH scan, no network).
- **Harness-agnostic**: we expose a standard MCP gateway (stdio + streamable HTTP/SSE) so *any* client works; we don't lock to Open Paw.
- Not a hosted SaaS registry (we ship a curated catalog + custom server config; community/registry sync is later).

## 2. Users & Core Journeys
- **Agent power-user / developer**: "I have 6 MCP servers (filesystem, github, postgres, my vault, …). I want them running safely and reachable from Claude Code via one URL — without hand-editing JSON per client."
- **Open Paw user**: "Manage my MCP servers in a tab, toggle them on/off, see their tools and logs, and have my agent use them."
- **Privacy/security-minded**: "Run untrusted community MCP servers in a container so they can't read my whole disk."

Journeys: add a server (from catalog or custom command/image) → choose runtime → start → see status/tools/logs → copy the gateway URL → the agent uses the aggregated tools. Toggle, restart, edit secrets, stop.

## 3. Feature Set

### 3.1 Server runtime & supervisor `[shipped]`
| Feature | Description | Status | Release |
| --- | --- | --- | --- |
| Process runtime | Spawn a stdio MCP server as a sandboxed child (allow-listed env, injected secrets, restricted CWD, resource limits); capture logs; health/restart | shipped | v0.1.0 |
| Docker runtime | Container-per-server (opt-in): pull/run image, env/secrets, caps/network/limits | shipped | v0.1.0 |
| Remote runtime | Connect to a hosted HTTP/SSE MCP endpoint (no child process). The supervisor holds a `StreamableHTTPClientTransport` (or SSE) with an OAuth provider that attaches + refreshes the bearer token; a token-less server sits in a new `authorizing` state instead of erroring | shipped | v0.5.0 |
| Supervisor | Start/stop/restart/remove, status (starting/ready/errored/stopped), structured logs ring-buffer | shipped | v0.1.0 |
| Crash backoff | Auto-restart with backoff when a running server dies | planned | v0.3.0 |
| Secrets | Per-server secrets stored locally (OS keychain when available), injected at launch, never logged | planned (file-based today, never logged/returned) | v0.3.0 |

### 3.2 Gateway `[shipped]`
| Feature | Description | Status | Release |
| --- | --- | --- | --- |
| Aggregating MCP gateway | One MCP endpoint that fans out to all running servers; tools namespaced `server__tool`; routes calls to the owning server | shipped | v0.1.0 |
| stdio transport | `nekko-mcpd --stdio` for direct client spawn | shipped | v0.1.0 |
| Streamable HTTP transport | `/mcp` on the daemon port (stateless, JSON responses); proven by an HTTP smoke test and the live Open Paw client | shipped | v0.2.0 |
| Gateway bearer token | Auto-generated, persisted, enforced on `/mcp` (401 otherwise), surfaced in the UI + `/api/gateway` | shipped | v0.2.0 |
| Per-client tokens + allow-list | Named **connected agents**, each with its own gateway token scoped to a per-server allow-list (`'*'` or specific servers). The gateway hides disallowed servers from `tools/list` and refuses their `tools/call`; the master token keeps full access. Calls are attributed to the agent's name in analytics. Managed at `/api/clients` + the UI's "Connected agents" section. Granularity is per-server (not per-tool) by design | shipped | v0.4.0 |
| Resources & prompts aggregation | Aggregate `resources`/`prompts` alongside tools | planned | v0.3.0 |

### 3.3 Registry / catalog `[shipped]`
| Feature | Description | Status | Release |
| --- | --- | --- | --- |
| Curated catalog | Built-in list of popular MCP servers (filesystem, github, postgres, fetch, **Fly.io** (`flyctl mcp server`), **nekko-vault-mcp**, …) with one-click add | shipped | v0.1.0 |
| Custom server | Add by command+args+env (process) or image (docker) | shipped | v0.1.0 |
| One-click OAuth servers | Remote first-party servers (**GitHub**, **Context7**, …) add with a single button that opens the provider's browser login — no token to paste. Built on the MCP OAuth spec (RFC 8414 metadata discovery + RFC 7591 dynamic client registration + OAuth 2.1 auth-code + PKCE), so one generic flow covers every compliant provider; adding another is a one-line catalog entry (name + url + `auth: 'oauth'`). Providers without dynamic registration (GitHub) take a pre-registered app via `NEKKO_MCP_CLIENTID_<ID>` (+ `NEKKO_MCP_CLIENTSECRET_<ID>` when the provider requires client auth at the token endpoint even under PKCE, as GitHub does) — one shared app baked into the distribution, so every user just authorizes it, no per-user registration. Tokens persist under `~/.nekko-mcp/oauth/`; a `/oauth/callback` route finishes the handshake and auto-connects | shipped | v0.5.0 |
| Registry search | Search the **official open-source MCP Registry** (`registry.modelcontextprotocol.io`) from the Add flow. The daemon fetches on-demand at `/api/registry/search` and maps each hit (npm→`npx`, pypi→`uvx`, oci→docker image, env vars→prompts) into an add-ready entry; remote-only servers are shown but flagged not-yet-runnable | shipped | v0.4.0 |
| Expanded official catalog | Curated first-party entries for the providers users actually reach for: **kotrain** (`kotrain mcp`), **Supabase**, **Linear**, **Figma** (hosted + local Dev Mode), **Jira/Confluence (Atlassian)**, **Azure**, **AWS** (suite flagship), **GCP MCP Toolbox**, **Cloudflare** (API + public Docs), **Higgsfield**, **Meta Ads** — each with a verified launch config. Providers with no runnable first-party server (Framer, YouTube, Nano Banana) are deliberately left to registry search rather than shipped as broken entries | shipped | v0.6.0 |
| Official / verified badge | `RegistryEntry.official` marks first-party servers (hand-set on curated entries from vendor docs; derived on registry-search hits from a **domain-verified reverse-DNS namespace** — `com.x/…`/`app.x/…` = verified publisher, `io.github.*` = community). The Add flow shows an **✓ Official** or **Community** chip so trust is visible at a glance | shipped | v0.6.0 |
| Recommended + popularity ordering | The catalog shows NekkoMCP's **recommended set** first in a fixed order (kotrain, context7, supabase, linear, figma), then the rest by **popularity** — npm monthly downloads, else GitHub stars — fetched **lazily when the catalog opens** (`/api/registry/popularity`, cached 24h to `~/.nekko-mcp/popularity.json`, soft-fails to stale/empty). Never fetched on boot, so the local-first invariant holds; a sensible static order ships as the instant/offline default | shipped | v0.6.0 |
| CLI detection & search | A **Command-line tools** section (on the Servers page) detects which CLIs are installed — the prerequisites MCP servers depend on (node/npx, uv/uvx, docker, flyctl, kotrain, cloud CLIs…) — showing version + path when present and an install hint when missing, plus an **ad-hoc search** to check any command (`/api/clis`, `/api/clis/check`). Fully local: a shell-free PATH scan + a bounded `--version` probe, injection-guarded | shipped | v0.6.0 |
| Registry sync | Background sync / caching of the registry snapshot (beyond on-demand search) | planned | later |

### 3.4 UI `[shipped]`
| Feature | Description | Status | Release |
| --- | --- | --- | --- |
| Web UI | Server list with status, add-from-catalog/custom, start/stop, logs viewer, tools inspector, copy gateway URL + per-client config snippets | shipped | v0.1.0 |
| Served by the daemon | The built UI is served at the daemon root, one port does UI + API + gateway | shipped | v0.2.0 |
| Fresh design | Violet→cyan Nekko brand (matches Open Paw's palette era), hero gateway card with endpoint + masked token + snippet tabs (Claude Code / .mcp.json / stdio / Open Paw), status pills, catalog grid, light+dark. Branded SVG favicon (gradient rounded-square + cat mark) | shipped | v0.2.0 |
| List-first, de-boxed redesign | **Medium** theme is the shipped default (calm mid-slate) with a topbar Light/Medium/Dark switch (persisted, no-flash). Active servers are the primary view as a clean list (hairline dividers, not per-card boxes); the gateway is a slim bar with the connect snippets behind a disclosure; the catalog moved behind **+ Add server**. Servers / Analytics tabs in the topbar | shipped | v0.3.0 |
| Tool inspector (list view) | A server's tools expand into a clickable list; clicking a tool reveals its description and parameters (name, type, required) parsed from its input schema, replacing the flat namespaced chips | shipped | v0.4.0 |
| Registry search box | The Add-server area gained a debounced search over the official MCP registry, mapped into add-ready catalog rows (with a `registry` tag + not-runnable notes); the curated list + custom card remain the default when the box is empty. The add form also gained a Docker **image** field | shipped | v0.4.0 |
| Connected agents section | Lists each scoped agent with its masked token (reveal/copy), a connect snippet, and its allowed servers as chips underneath; an inline editor (name + an all-servers toggle / per-server checklist) creates and edits agents | shipped | v0.4.0 |
| Catalog ordering + trust chips | The Add-server catalog renders the recommended set first (each with a ★), then the rest by popularity; every entry carries an **✓ Official** / **Community** chip. Popularity is fetched only when the catalog opens, so the ordering settles in without any boot-time work | shipped | v0.6.0 |
| Command-line tools section | A collapsible section on the Servers page with a detected-count summary (e.g. "12/22 detected"), a status pill + version + path per known CLI (install hint when missing), and a search box that checks any command's availability on PATH | shipped | v0.6.0 |
| Windows tray launcher | `scripts/nekko-tray.ps1` (+ `.cmd`, `npm run tray`): a system-tray/taskbar icon (GDI+ gradient cat, no .ico asset) that keeps the daemon running and offers Open manager / Restart / Quit. Interim desktop presence before the Electron shell | shipped | v0.2.0 |
| Electron shell | Standalone cross-platform desktop app wrapping the daemon + UI | planned | later |

### 3.5 Integrations `[shipped]`
| Feature | Description | Status | Release |
| --- | --- | --- | --- |
| Open Paw integration | Open Paw detects a running daemon (host-side probe), offers one-click **Connect gateway** (adds the HTTP gateway as an MCP server) and **Open manager** (this UI in a workbench browser pane). Implemented natively in the open-paw repo against the daemon API, instead of embedding `@nekko-mcp/ui` | shipped | v0.2.0 |
| Client config export | `.mcp.json` / client snippets for HTTP + stdio, via `/api/gateway` + the UI snippet tabs | shipped | v0.1.0 |
| Shared `@nekko-mcp/ui` package | The UI as an embeddable package (superseded for now by the native Open Paw integration; revisit if a deeper embed is wanted) | parked | later |

### 3.6 Usage analytics `[shipped]`
The gateway is the perfect vantage point: every tool call fans through it, so we get observability for free. This is a headline reason to route through NekkoMCP rather than wiring each server into each client by hand.

| Feature | Description | Status | Release |
| --- | --- | --- | --- |
| Call recording | The gateway records every routed tool call as a `UsageEvent` (server, tool, caller, ok/error incl. tool-level `isError`, duration, bytes in/out). Aggregated in the supervisor: per-server, per-tool, per-client totals + a capped recent-event ring buffer | shipped | v0.3.0 |
| Caller identity | Best-effort "who called" from the MCP handshake's `clientInfo` (captured on `initialize`, attributed to the calls that follow), falling back to an `X-Client-Name` header / User-Agent; stdio callers labelled `stdio (local)`. Local heuristic — the gateway is stateless so there's no session to correlate | shipped | v0.3.0 |
| Analytics API + tab | `/api/analytics` serves an `AnalyticsSummary`; the UI's **Analytics** tab shows headline metrics (calls, success rate, clients, data in/out), a 24h call-volume sparkline, usage-by-server (top tools, error count, latency, data), a who's-calling breakdown, and a live recent-calls feed | shipped | v0.3.0 |
| Persistence across restarts | Aggregates + the recent-event ring are persisted to `~/.nekko-mcp/analytics.json` (debounced writes, flush on shutdown) and re-hydrated on boot, so usage — and the "since" start time — survive a daemon restart | shipped | v0.4.0 |

## 4. Design System & Considerations
Nekko design language, current era: cool ink/paper neutrals, **indigo-violet accent + cyan `#22d3ee` secondary** into a violet→cyan brand gradient (matching Open Paw's palette refresh), calm/minimal, the paw/cat mark. Three themes selectable from the topbar and driven entirely by CSS custom properties on `<html data-theme>`: **Medium** (the shipped default — a calm mid-slate), **Dark** (near-black), **Light**; the choice is persisted and applied before paint (no flash). The look is deliberately de-boxed: hairline-divided lists over stacked bordered cards. The UI must read as a sibling of Open Paw and Nekko Notes. Status pills: ready=success, starting=warning, errored=danger, stopped=muted. Logs are monospace, capped ring-buffer.

## 5. Technical Architecture & Decisions (with the *why*)
See [`TASKS.md`](TASKS.md). Key decisions: TypeScript + npm workspaces (match the org stack so the UI can be shared with Open Paw); a long-running **daemon** (`nekko-mcpd`) as the runtime + management API + gateway; a **RuntimeAdapter** interface with `ProcessRuntime` (default) and `DockerRuntime` (opt-in) so isolation is pluggable + user-selectable; the gateway built on `@modelcontextprotocol/sdk` (client per managed server ↔ one aggregated server). Local-first, no account.
