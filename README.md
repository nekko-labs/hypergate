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

### Run it as a desktop app (Windows)

```bash
npm run build && npm run tray            # tray icon in the taskbar; keeps the daemon up
```

`scripts/hypergate-tray.cmd` launches a system-tray icon (right-click for **Open manager / Restart / Quit**, double-click opens the UI). A cross-platform Electron shell is planned; this is the lightweight interim.

The manager's **Settings** tab has the service options:

- **Run on startup**: launches the tray automatically at login (Windows: an `HKCU\…\Run` entry). No need to place a Startup-folder shortcut by hand.
- **Start minimized**: on launch, stay in the tray instead of opening the manager window.

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
