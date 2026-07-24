---
status: active
created: 2026-06-28
owner: Philip
type: code
---

# Execution Plan — NekkoMCP

> Converted from executionplan.md on 2026-06-29. ✅ = done per the prior plan; Part 1 below is the technical plan, Part 2 is the task checklist.

> **The plan + the build log, in one file.** The top half (Part 1) is the technical plan — how we build what `SPEC.md` describes. The bottom half (Part 2) is the task list — Now / Backlog / Shipped, recording how past features were built and how future ones will be. (Merged from the former `plan.md` + `tasks.md`.)

---

# Part 1 — Plan (how we build it)

> **How.** Stack, architecture, conventions, and the execution backlog. The *what & why* lives in [`SPEC.md`](SPEC.md).

## 1. Stack (decided — do not relitigate)

| Area | Choice | Why |
| --- | --- | --- |
| Language / repo | **TypeScript, npm workspaces** (Node ≥20; runnable with **bun**) | Matches the org stack (Nekko Notes, Open Paw) so `@nekko-mcp/ui` can be shared into Open Paw; no pnpm/yarn (duplicate-React breakage). |
| Daemon | Node/Bun long-running process (`nekko-mcpd`) — HTTP management API + MCP gateway + supervisor | A ToolHive rival needs a resident runtime to launch/supervise servers and hold the gateway. |
| MCP | `@modelcontextprotocol/sdk` (client per managed server, one aggregated server for the gateway) | Official SDK; same dep Open Paw + the Notes CLI already use. |
| UI | Vite + React + TS + Tailwind + Zustand (Nekko design tokens) | Consistent with Notes/Open Paw; the UI package embeds as an Open Paw pane. |
| Isolation | **RuntimeAdapter** interface: `ProcessRuntime` (default) + `DockerRuntime` (opt-in), user-selectable at setup | Don't force Docker; make the security tradeoff explicit (see spec §1). |
| Desktop (later) | Electron (reuse Open Paw's desktop pattern) | "Real app" shell; deferred past the web MVP. |
| Test/CI | Vitest (core units) + a daemon smoke/probe (spawn a stdio server through the gateway) + GitHub Actions | Same gate discipline as Notes. |

## 2. Repo Layout

```
nekko-mcp/                         GitHub: nekko-labs/nekko-mcp (public, MIT)
  packages/
    shared/   types + API/IPC contract (ManagedServer, RuntimeKind, ServerStatus,
              RegistryEntry, GatewayConfig, daemon API request/response types)
    core/     pure-ish engine: registry catalog, server-config validation,
              RuntimeAdapter interface + ProcessRuntime + DockerRuntime, Supervisor,
              gateway aggregation logic  (+ *.test.ts)
    ui/       @nekko-mcp/ui — shared React UI (embeds in Open Paw)
  apps/
    daemon/   nekko-mcpd — HTTP management API + MCP gateway (stdio + HTTP/SSE) + supervisor host
    web/      Vite React app (standalone UI) → talks to the daemon
    desktop/  Electron shell (later)
  docker-compose.yml · tsconfig.base.json
```

## 3. Architecture

- **Daemon (`nekko-mcpd`)** holds the `Supervisor` (a map of `ManagedServer` → running instance via a `RuntimeAdapter`). One localhost port (7777) exposes:
  - **Management API** (HTTP, localhost): `GET /api/servers`, `POST /api/servers` (add), `POST /api/servers/:id/start|stop|restart`, `DELETE /api/servers/:id`, `GET /api/servers/:id/logs`, `GET /api/registry`, `GET /api/gateway` (URL + token + HTTP/stdio client snippets + uiUrl).
  - **Gateway**: an aggregating MCP server. For each running managed server it holds an MCP **client**; it merges their `tools` (namespaced `server__tool`; resources/prompts planned) and routes calls to the owner. Exposed over **stdio** (`nekko-mcpd --stdio`) and **streamable HTTP** at `/mcp`: stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`, `enableJsonResponse: true`, a fresh transport+gateway per POST) so hand-rolled clients can speak plain JSON POSTs; bearer-token auth (token generated once into `~/.nekko-mcp/gateway-token`, checked with `timingSafeEqual`; `NEKKO_MCP_NO_AUTH=1` escape hatch).
  - **Web UI**: the built `apps/web` served at `/` (path-sanitized static handler, SPA fallback), so one URL does UI + API + gateway.
- **RuntimeAdapter** interface: `start(server): Promise<RunningServer>`, `stop`, `logs`, `health`. `ProcessRuntime` spawns a child (allow-listed env, injected secrets, restricted CWD, resource limits, no shell). `DockerRuntime` runs a container (image, caps, network, limits). Chosen by `server.runtime` (default from setup).
- **UI** (`@nekko-mcp/ui`) is transport-light: it calls the daemon's HTTP API. The standalone `apps/web` and the Open Paw tab both render it; only the base URL differs.

## 4. Conventions
- Pure logic in `packages/core` (unit-tested); the daemon wires IO. No secret ever logged. Local-first: no network egress from the daemon itself except what a managed server does.
- Build → verify → push to `main` (CI green). Conventional commits. Mock/test the supervisor with a trivial in-repo echo MCP server so tests need no external binaries.
- Every shipped feature → status + release in `SPEC.md`; new work broken down here first.

## 5. Execution Plan (backlog)

The epic-by-epic backlog lives in **Part 2 below** (single source of truth for task status; this section used to mirror it and drifted). Epics: 0 Scaffold · 1 Runtime & supervisor · 2 Gateway · 3 Registry & API · 4 UI · 5 Open Paw integration · 6 Distribution.

## 6. How We Work
Same as the org: spec is the product source of truth, plan is broken-down-first, build+verify+push to main, local-first + explicit-tradeoff invariants.

---

# Part 2 — Tasks (what's built and what's next)

Mirror of Part 1 §5. `[x]` = shipped per the prior plan · `[ ]` = open.

## Epic 0 — Scaffold
- [x] **Workspace project docs** — spec/plan/tasks/README/AGENTS/memory.
- [x] **Repo skeleton** — npm workspaces, tsconfig.base, build/test scripts. Repo live: github.com/nekko-labs/nekko-mcp (README splash).
- [x] **`packages/shared`** — core types + daemon API contract.
- [x] **Cross-project rename** — Nekko Notes CLI bin `nekko-mcp` → `nekko-vault-mcp`.

## Epic 1 — Runtime & supervisor (v0.1.0)
- [x] **`RuntimeAdapter` + `ProcessRuntime`** — sandboxed child, allow-listed env, log buffer. · [spec](SPEC.md#31-server-runtime--supervisor-shipped)
- [x] **`Supervisor`** — start/stop/restart/status, logs; e2e test vs an in-repo echo MCP server. · [spec](SPEC.md#31-server-runtime--supervisor-shipped)
- [x] **`DockerRuntime` (opt-in)** — + unit tests (spec only; needs Docker to run live). · [spec](SPEC.md#31-server-runtime--supervisor-shipped)
- [x] **`Supervisor.remove(id)`** — DELETE now drops the instance from the roster entirely (was leaving a ghost `stopped` entry in `list()` and the health count). · Done: 2026-07-04
- [x] **Analytics persistence on disk** — `Supervisor.snapshot()`/`hydrate()` serialize the aggregates + recent-event ring (Maps/Sets → arrays); an `onUsage` hook lets the daemon persist without coupling core to the filesystem. The daemon hydrates `~/.nekko-mcp/analytics.json` on boot and writes it debounced (2s) per call + flush on shutdown, so usage and the "since" start-time survive a restart. Stdio mode stays read-only so a transient spawn never clobbers the file. · [spec](SPEC.md#36-usage-analytics-shipped) · Done: 2026-07-21
- [x] **Remote runtime + MCP OAuth** — a third `RuntimeKind` (`remote`) connects to a hosted HTTP/SSE MCP endpoint instead of spawning a child. The supervisor builds a `StreamableHTTPClientTransport`/`SSEClientTransport` with an injected `authProviderFor` factory; `core/oauth.ts` adds a store-backed `NekkoOAuthProvider` (RFC 8414 discovery + RFC 7591 dynamic registration + OAuth 2.1 auth-code + PKCE, via the SDK's `auth()`), keeping core IO-free (the daemon supplies a file store under `~/.nekko-mcp/oauth/`). New `authorizing` server state + `markAuthorizing()` so a token-less remote server prompts sign-in instead of erroring. Providers without dynamic registration (GitHub) take a static `clientId` (config or `NEKKO_MCP_CLIENTID_<ID>`). Unit-tested (`oauth.test.ts`, in-memory store). · [spec](SPEC.md#31-server-runtime--supervisor-shipped) · Done: 2026-07-23
- [ ] **Crash backoff / auto-restart loop** — auto-restart a `ready` server whose process dies, with capped backoff. · [spec](SPEC.md#31-server-runtime--supervisor-shipped) · Added: 2026-06-29
- [ ] **Secrets in the OS keychain** — keytar-free (Credential Manager / Keychain / libsecret via CLI), file fallback. · [spec](SPEC.md#31-server-runtime--supervisor-shipped) · Added: 2026-06-29
- [ ] **Periodic health checks** — ping each ready server's client on an interval; flip to `errored` + surface in the UI when unresponsive. · Added: 2026-07-04

## Epic 2 — Gateway (v0.1.0 → v0.2.0)
- [x] **Aggregating MCP gateway** — client-per-server, namespaced `server__tool` merge, routing; proven end-to-end in tests. · [spec](SPEC.md#32-gateway-shipped)
- [x] **stdio transport** — `nekko-mcpd --stdio`. · [spec](SPEC.md#32-gateway-shipped)
- [x] **Streamable HTTP transport** — `/mcp` on the daemon port; stateless SDK transport with JSON responses (`enableJsonResponse`), fresh transport+gateway per request; `npm run smoke:http` boots the daemon and speaks raw MCP-over-fetch (initialize → tools/list → tools/call → 401 without token). · [spec](SPEC.md#32-gateway-shipped) · Done: 2026-07-04
- [x] **Gateway bearer token** — generated once to `~/.nekko-mcp/gateway-token`, `timingSafeEqual` check, exposed via `/api/gateway` + the UI (masked, reveal/copy); `NEKKO_MCP_NO_AUTH=1` opt-out. · [spec](SPEC.md#32-gateway-shipped) · Done: 2026-07-04
- [x] **Per-client tokens + per-server allow-list** — named **connected agents**, each with its own gateway token scoped to a per-server allow-list (`'*'` or specific server ids). `createGateway` gained an `allowServer` predicate that hides disallowed servers from `tools/list` and refuses their `tools/call`; the daemon resolves the bearer token to master (full access) or an agent (its scope + name as the analytics caller), persists agents to `~/.nekko-mcp/clients.json`, and serves CRUD at `/api/clients`. UI: a "Connected agents" section (masked token, connect snippet, allowed-servers chips, inline editor). Per-server granularity chosen over per-tool (user decision). · [spec](SPEC.md#32-gateway-shipped) · Done: 2026-07-21
- [ ] **Resources & prompts aggregation** — the gateway currently merges `tools` only; aggregate `resources` + `prompts` the same namespaced way. · Added: 2026-07-04
- [ ] **Live tool-change notifications** — forward `notifications/tools/list_changed` when a managed server starts/stops so connected clients refresh without a manual reconnect. · Added: 2026-07-04

## Epic 3 — Registry & API (v0.1.0)
- [x] **Curated catalog** — filesystem/github/fetch/postgres/nekko-vault + custom server config. · [spec](SPEC.md#33-registry--catalog-shipped)
- [x] **Fly.io catalog entry** — one-click add for the Fly.io MCP server (`flyctl mcp server`, stdio; prompts for `FLY_API_TOKEN`). Verified end to end: added → `ready` → 60 `fly-*` tools aggregated as `fly__*` through the gateway; a `fly__fly-apps-list` call routes to flyctl and returns the auth-required error until `flyctl auth login`. · [spec](SPEC.md#33-registry--catalog-shipped) · Done: 2026-07-21
- [x] **Daemon HTTP management API** — list/add/remove/start/stop/restart/logs/gateway + client-config export. · [spec](SPEC.md#32-gateway-shipped)
- [x] **Official MCP registry search** — `core/registry-search.ts` fetches `registry.modelcontextprotocol.io/v0/servers?search=` and maps each hit to a `RegistryEntry` (npm→`npx -y`, pypi→`uvx`, oci→docker image, env vars→prompts; remote-only flagged not-runnable). Daemon `GET /api/registry/search` (8s timeout, soft-fails to `[]`) is the one deliberate outbound call, only on user search. UI: a debounced search box in the Add-server area. Mapper unit-tested (fetch injected); verified live. · [spec](SPEC.md#33-registry--catalog-shipped) · Done: 2026-07-21
- [x] **One-click OAuth catalog + daemon flow** — GitHub (`https://api.githubcopilot.com/mcp/`) and Context7 (`https://mcp.context7.com/mcp/oauth`) added as `remote`/`oauth` catalog entries (GitHub-PAT kept as a `github-pat` fallback). Daemon: `POST /api/servers` kicks off `auth()` for remote+oauth and returns `authUrl`; `GET /oauth/callback` maps CSRF `state` → server, completes the exchange, and auto-connects (self-contained result page); `POST /api/servers/:id/authorize` (re-auth) + `/disconnect` (sign out, drop tokens). UI: OAuth badge + "🔐 Sign in & add" that opens the login popup, an `authorizing` server row with Sign in / Disconnect, `🌐 remote` chip + host. **Verified:** Context7 works end-to-end zero-config (real `authUrl` with dynamic client + PKCE); GitHub reaches the AS but has no dynamic registration, so it needs a pre-registered client id (surfaced as an actionable message + catalog note). · [spec](SPEC.md#33-registry--catalog-shipped) · Done: 2026-07-23
- [x] **Expanded official catalog + trust badges + recommended/popularity sort** — added verified first-party catalog entries (kotrain, supabase, linear, figma + Figma Dev Mode, atlassian, azure, aws, gcp-toolbox, cloudflare + docs, higgsfield, meta-ads); `RegistryEntry` gained `official`/`recommended`/`publisher`/`popularity`. `registry-search` derives `official`/`publisher` from the reverse-DNS namespace (domain-verified ⇒ first-party; `io.github.*` ⇒ community). New `sortRegistry` (recommended set fixed-first, then popularity desc, stable fallback) + `/api/registry/popularity` (npm downloads + GitHub stars, 8s budget, cached 24h to `~/.nekko-mcp/popularity.json`, soft-fail) fetched **lazily when the catalog opens** so nothing hits the network on boot. Framer/YouTube/Nano-Banana intentionally not curated (no runnable first-party config) — still reachable via registry search. · [spec](SPEC.md#33-registry--catalog-shipped) · Done: 2026-07-24
- [x] **CLIs section (detect + search command-line tools)** — `core/clis.ts` `KNOWN_CLIS` catalog (runtimes, package runners, docker, cloud CLIs, MCP bins); daemon `/api/clis` (shell-free PATH scan preferring real exts, bounded `--version` probe, 10s memo) + `/api/clis/check?name=` (charset-validated, injection-safe, existence + version). UI: a collapsible "Command-line tools" section on the Servers page with a detected-count, per-tool status/version/path/install-hint, and an ad-hoc availability search. · [spec](SPEC.md#33-registry--catalog-shipped) · Done: 2026-07-24
- [x] **Confidential-client (client_secret) support** — GitHub requires client auth at the token endpoint even with PKCE (it doesn't treat native apps as public clients), so a client id alone isn't enough. `NekkoOAuthProvider` now takes a `clientSecret`; when present it's returned in `clientInformation()` and `token_endpoint_auth_method` flips to `client_secret_post` (the SDK negotiates post/basic from the server's advertised methods). Daemon resolves it from config or `NEKKO_MCP_CLIENTSECRET_<ID>` (env-only, never the catalog). DCR providers (Context7) stay pure public clients, unchanged. Verified: with `NEKKO_MCP_CLIENTID_GITHUB`+`_CLIENTSECRET_` set, adding GitHub bypasses DCR and yields a real `github.com/login/oauth/authorize?client_id=…&code_challenge=…` URL. · [spec](SPEC.md#33-registry--catalog-shipped) · Done: 2026-07-24
- [ ] **Register + ship the NekkoMCP GitHub OAuth app** — create the app (org `nekko-labs`, callback `http://localhost:7777/oauth/callback`), then inject its id+secret at release (env, not source) so GitHub is one-click for every user like Context7. One shared app, not per-user. Needs Philip. · Added: 2026-07-23
- [ ] **Registry background sync / caching** — periodic snapshot sync + offline cache (beyond on-demand search). · Added: 2026-07-21
- [ ] **Import existing configs** — one-click import of `.mcp.json` / Claude Desktop / Cursor server configs into managed servers. · Added: 2026-07-04

## Epic 4 — UI
- [x] **`apps/web` standalone UI** — list/status/add-from-catalog-or-custom/start-stop/restart/logs/tools/runtime-picker/gateway copy. · [spec](SPEC.md#34-ui-shipped)
- [x] **Served by the daemon** — built UI served at `/` (path-sanitized static handler); one port for UI + API + gateway. · [spec](SPEC.md#34-ui-shipped) · Done: 2026-07-04
- [x] **Fresh competitive design** — violet→cyan Nekko brand (Open Paw palette era): sticky header with daemon-status pill, hero + stat chips, gateway card (endpoint copy, masked token reveal/copy, snippet tabs for Claude Code / `.mcp.json` / stdio / Open Paw), server cards with status pills + expandable tool chips + logs, catalog grid with requires-chips + custom-server card, isolation segmented control in the add form, empty states, light+dark via `prefers-color-scheme`. Verified headless (screenshot). · [spec](SPEC.md#34-ui-shipped) · Done: 2026-07-04
- [x] **Branded favicon** — `apps/web/public/favicon.svg` (violet→cyan rounded-square + white cat mark) replaces the 🐾 emoji data-URI; served by the daemon and copied into `dist/` by Vite. · [spec](SPEC.md#34-ui-shipped) · Done: 2026-07-21
- [x] **Tool inspector (list view)** — a server's tools now expand into a clickable list; each tool reveals its description + parameters (name/type/required) parsed from its `inputSchema`. `ServerStatus` gained `toolDetails: ToolInfo[]` (additive to the `tools` names), captured by the supervisor from `client.listTools()`. The add-server form also gained a Docker **image** field (and the daemon add-validation now accepts command *or* image). · [spec](SPEC.md#34-ui-shipped) · Done: 2026-07-21
- [ ] **Live log streaming** — stream logs (SSE or poll-tail) instead of a snapshot on click. · Added: 2026-07-04
- ~~**Extract `@nekko-mcp/ui`**~~ — parked: the Open Paw integration shipped natively against the daemon API (simpler than a cross-repo package); revisit only if a deeper embed is wanted. · Parked: 2026-07-04

## Epic 5 — Open Paw integration (v0.2.0)
- [x] **Open Paw ↔ NekkoMCP** — shipped in the open-paw repo (branch `feat/nekko-mcp-integration`): the Open Paw MCP client gained a **streamable-HTTP transport** (`McpServerConfig.url` + `token`, JSON/SSE reply parsing, session-id echo), a host-side `detectNekkoMcp()` probe (`mcp:nekko` channel through the five-touch chain), and a Settings card that shows a detected daemon with one-click **Connect gateway** + **Open manager** (workbench browser pane). Proven by `scripts/itest-mcp-http.mjs` (Open Paw host → gateway → echo server round trip + 401 on a bad token). · [spec](SPEC.md#35-integrations-shipped) · Done: 2026-07-04

## Epic 6 — Distribution (later)
- [x] **Windows tray launcher** — `scripts/nekko-tray.ps1` (+ `.cmd`, `npm run tray`): a system-tray/taskbar icon (GDI+ gradient-cat, no .ico asset shipped) that keeps the daemon running and offers Open manager / Restart / Quit (double-click opens the UI). Interim desktop presence before the Electron shell. Verified: parses + draws, launches detached and stays alive (message loop up), starts a healthy token-auth daemon, Fly auto-starts from persisted config. · [spec](SPEC.md#34-ui-shipped) · Done: 2026-07-21
- [ ] **npm publish `nekko-mcp` / `nekko-mcpd`** — so `npx nekko-mcp` starts the daemon (needs the user's npm login). · Added: 2026-07-04
- [ ] **Electron shell · docker-compose · signed releases · GitHub Actions CI** (paused like Notes until launch). · [spec](SPEC.md#34-ui-shipped) · Added: 2026-06-29
