# Hypergate

![Hypergate: run MCP servers securely; one gateway for every agent](docs/splash.png)

**Local-first runtime and manager for MCP servers.** Run MCP servers securely, supervise them, and expose **one gateway endpoint** any agent harness (Claude Code, Cursor, [Kotrain](https://github.com/nekko-labs/kotrain), Codex) can use. Not just a connector list: a proper server runtime.

> Open source · MIT · [nekko-labs](https://github.com/nekko-labs) · [hypergate.app](https://hypergate.app)

## Why
Kotrain and Claude Code are MCP *clients*. Hypergate is the piece they need: a secure local *server runtime/manager*, a supervisor plus an aggregating gateway. Add servers from a catalog (or custom), pick how they're isolated, start them, and paste one URL/command into your agent.

## Isolation: your choice (the tradeoff, plainly)

| Runtime | Isolation | Pros | Cons |
|---|---|---|---|
| **Process sandbox** (default, no deps) | Scrubbed/allow-listed env, injected secrets only, restricted CWD/limits, no shell | Zero dependencies, instant, cross-platform | Weaker than a container (shared kernel) |
| **Docker** (opt-in) | Container-per-server (`docker run -i`, dropped caps, no-new-privileges) | Strong isolation + reproducibility | Requires Docker; heavier/slower cold start |
| **Remote** (hosted) | No local process at all: the gateway holds an authenticated HTTP client to the provider's hosted MCP endpoint | Nothing to install; official first-party servers; one-click OAuth sign-in | Trusts the provider; needs network |

For local runtimes the isolation model reduces to *"what command do we spawn over stdio"*: process = the server's own command; Docker = `docker run -i … image`. Remote skips the spawn entirely and connects out. Set it at setup, override per server.

## Catalog: find and add servers

- **Curated catalog** with the official first-party servers people actually reach for (Kotrain, Context7, Supabase, Linear, Figma, GitHub, Atlassian, AWS, Azure, GCP, Cloudflare, Fly.io, …), each with a verified launch config. Hypergate's recommended set is pinned first; the rest is ordered by real popularity (npm downloads / GitHub stars, fetched lazily and cached, never on boot).
- **✓ Official / Community trust chips** on every entry, so you can see at a glance whether a server is published by the vendor or the community.
- **One-click OAuth servers**: remote first-party servers (GitHub, Context7, …) add with a single button that opens the provider's browser login. No token to paste; tokens persist locally under `~/.hypergate/oauth/`.
- **Registry search** over the official open-source MCP registry (`registry.modelcontextprotocol.io`), mapped into add-ready entries.
- **Command-line tools radar**: a section that detects which CLIs the servers depend on (node/npx, uv/uvx, docker, flyctl, cloud CLIs, …), with version + path when present and an install hint when missing. Fully local, shell-free PATH scan.

## Architecture

```
packages/shared   types + daemon API contract
packages/core     RuntimeAdapter (Process | Docker | Remote) · Supervisor · aggregating Gateway · registry
apps/daemon       hypergated: one localhost port serving the web UI, the management API,
                  and the streamable-HTTP MCP gateway at /mcp (+ a `--stdio` mode)
apps/web          the management UI (served by the daemon at /)
apps/site         the hypergate.app marketing one-pager (static Vite, deployed on Vercel)
```

- **Supervisor** launches each server through its `RuntimeAdapter`, connects an MCP client, tracks state/tools/logs (secrets never logged).
- **Gateway** merges every ready server's tools (namespaced `server__tool`) into one MCP server and routes calls. Exposed over **streamable HTTP** at `/mcp` (bearer-token auth, token auto-generated and shown in the UI) and over **stdio** (`hypergated --stdio`).

## Develop

```bash
npm install
npm run build
npm test            # spawns a real stdio MCP server → aggregates it via the gateway → calls a tool
npm run smoke:http  # boots the daemon → speaks MCP over plain HTTP → 401 without the token

npm run daemon                           # UI + API + /mcp gateway on http://localhost:7777
node apps/daemon/dist/index.js --stdio   # the aggregated gateway over stdio
```

The desktop shell is Rust, so it builds separately (needs a Rust toolchain):

```bash
npm run shell:build   # cargo build --release → apps/shell/target/release/hypergate
npm run shell:test    # unit + integration tests for the tray, CLI and sandbox launcher
npm run smoke:shell   # daemon ↔ shell bridge: keychain, autostart, sandbox-exec, CLI
```

### Run it as a desktop app (Windows, macOS, Linux)

```bash
npm run build && npm run shell:build && npm run tray
```

`hypergate tray` puts a tray icon in the notification area (menu bar on macOS, StatusNotifierItem on Linux) and keeps the daemon running. The menu has a live status line, **Open manager**, **Start/Stop all servers**, **Restart daemon**, **Start at login**, and **Quit**. Interaction is menu-only on every platform, because Linux's StatusNotifierItem delivers no click events and a click gesture would silently not exist there.

"Open manager" opens the web UI in your **default browser**. There is deliberately no bundled webview: you already have a better browser than any embedded one, and it avoids a hard `webkit2gtk` dependency on Linux.

The daemon stays independently runnable, so headless Linux, WSL and containers need no shell at all: run `npm run daemon` (or a systemd user unit) and skip the tray.

### The CLI

The same binary is the CLI, talking to the daemon over its HTTP API:

```bash
hypergate start          # start the daemon in the background
hypergate status         # daemon, servers, usage, keychain and autostart state
hypergate list           # managed servers and their state
hypergate logs <id>      # a server's logs
hypergate gateway        # the endpoint + token to paste into a harness
hypergate open           # the manager UI in your browser
hypergate autostart on   # login item: HKCU Run key / LaunchAgent / XDG autostart
hypergate secret check   # is an OS keychain available here?
```

The manager's **Settings** tab exposes the same service options:

- **Run on startup**: a real login item on all three platforms (`HKCU\…\Run`, a LaunchAgent, or an XDG autostart entry), so it reflects reality even if you change it outside the app.
- **Start minimized**: on launch, stay in the tray instead of opening the manager.

### Where things are stored

Everything is local, under `~/.hypergate/` (override with `HYPERGATE_DIR`):

| What | Where |
| --- | --- |
| Server configs, agent tokens, settings | `servers.json`, `clients.json`, `settings.json` |
| Usage history + server logs | `hypergate.db` (SQLite, WAL). Retention: 90 days of usage, 14 days of logs (`HYPERGATE_RETAIN_USAGE_DAYS` / `_LOG_DAYS`, `0` = forever) |
| Gateway token, OAuth grants | The **OS keychain** (Credential Manager / Keychain / Secret Service), falling back to files here where no keychain exists |

`npm run dev` runs the daemon + web UI together and opens the site in your browser once Vite is ready (set `HYPERGATE_OPEN=0` to skip).

### Use it from your agent

One endpoint for all your servers. HTTP (recommended, the daemon keeps supervising):

```bash
claude mcp add -t http hypergate http://localhost:7777/mcp -H "Authorization: Bearer <token>"
```

or stdio: `{ "mcpServers": { "hypergate": { "command": "hypergated", "args": ["--stdio"] } } }`

**Scoped agents.** The master token above sees every server. To hand a specific client a narrower token, add a **connected agent** in the UI (or `POST /api/clients`), pick which servers it may use, and give it that agent's token. It will only see and call the servers you allowed, and its calls show up under its name in Analytics.

**Kotrain** auto-detects a running daemon: Settings → MCP servers → **Connect gateway** (one click), plus an **Open manager** button that opens this UI in a workbench pane.

## Analytics: visibility for free
Because every tool call fans through the one gateway, Hypergate records it: server, tool, caller (from the MCP handshake), success/error, latency, and bytes in/out. The web UI's **Analytics** tab turns that into headline metrics, a 24h call-volume sparkline, usage-by-server, a who's-calling breakdown, and a live recent-calls feed, served from `/api/analytics` and persisted across restarts. It's a private audit trail with nothing to wire up and no data leaving your machine.

## Status
Kicked off 2026-06-28. **v0.7** is the rename era: NekkoMCP became **Hypergate**, with the [hypergate.app](https://hypergate.app) marketing site (WebGL warp-gate hero, real app screenshots) shipped from `apps/site`. On the way here: **v0.6** added the expanded official catalog, ✓ Official / Community trust chips, recommended + popularity ordering, and CLI detection; **v0.5** added the **remote runtime** and one-click OAuth servers (GitHub, Context7) built on the MCP OAuth spec; **v0.4** added connected agents (scoped tokens), registry search, the tool inspector, and analytics persistence; **v0.3** the analytics engine and the list-first redesign; earlier versions the core: process + Docker runtimes, supervisor, aggregating gateway over stdio and streamable HTTP, daemon-served web UI, curated catalog, and Kotrain one-click integration. Next: resources/prompts aggregation, crash backoff, keychain secrets, registry background sync, Electron shell. See `SPEC.md`/`TASKS.md`.
