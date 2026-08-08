---
name: testing-hypergate
description: How to bring up the Hypergate daemon, CLI and manager UI on a Linux box and end-to-end test the CLI surface, agent tokens over /mcp, and the management-API security controls.
---

# Testing Hypergate end-to-end

## Bring-up

```bash
nvm use 24                 # node 22 breaks the daemon's node:sqlite analytics
npm install && npm run build
cargo build --release --manifest-path apps/shell/Cargo.toml
node apps/daemon/dist/index.js &        # binds 127.0.0.1:7777, serves /api, /mcp and the built manager UI
```

The built daemon serves the manager at `http://localhost:7777/` — you do not need
`npm run dev` (vite :5180) unless you are testing un-built web changes.

CLI binary: `apps/shell/target/release/hypergate`.
Master token: `hypergate gateway --token-only`. On boxes with no Secret Service the
token falls back to `~/.hypergate` and `doctor` reports `Keychain unavailable` —
that is expected on CI/VM boxes, not a bug.

## Getting real managed servers

```bash
hypergate add filesystem --secret ALLOWED_DIR=/tmp                 # 14 tools
hypergate add memory --command npx --arg=-y --arg @modelcontextprotocol/server-memory   # 9 tools
```

`hypergate add <catalog-id>` fails with a clear message if a required secret is missing.
Note the `--arg` repetition syntax (`--arg=-y` for args starting with `-`).

## Gotchas

- `hypergate stop` refuses to stop a daemon it did not start
  (`a daemon is running but this shell did not start it`). For daemon-down tests use
  `pkill -f 'daemon/dist/index.js'` and restart manually.
- Agents/servers persist in `~/.hypergate`, so state carries across daemon restarts.
- Catalog entries whose install instruction is a URL or prose (`node`, `bun`, `kotrain`)
  are the right adversarial inputs for `hypergate cli install --run` safety tests.

## Testing management-API security

Mutating `/api` requests require a loopback `Origin` and a same-origin/none
`Sec-Fetch-Site`; `Host` must be loopback or in `HYPERGATE_ALLOWED_HOSTS`.

```bash
curl -i -H 'Host: evil.example' http://127.0.0.1:7777/api/servers        # 403 {"error":"invalid_host"}
curl -i -X POST -H 'Origin: http://127.0.0.1:8123' -H 'Sec-Fetch-Site: cross-site' \
     -H 'Content-Type: application/json' -d '{"name":"x","servers":"*"}' \
     http://localhost:7777/api/clients                                    # 403 {"error":"cross_origin"}
curl -i -X OPTIONS http://127.0.0.1:7777/mcp                              # ACAO: * — intentional
```

For a real browser cross-origin test, serve a page from a second port
(`python3 -m http.server 8123`) that fetches `http://localhost:7777/api/...`; the
browser reports `TypeError: Failed to fetch` because no CORS headers are sent on `/api`.

## Testing agent tokens over /mcp

`POST /mcp` with `Authorization: Bearer <agent token>` and a JSON-RPC `tools/list`;
an agent scoped to one server sees only that server's `<server>__*` tools. After
`hypergate agent rotate <id>` the old token must return 401 and name/allow-list must survive.
Send `Accept: application/json, text/event-stream` or the MCP transport rejects the request.

## Devin Secrets Needed

None — everything runs locally on loopback.
