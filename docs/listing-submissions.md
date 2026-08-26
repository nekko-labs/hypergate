# Getting Hypergate listed

Where Hypergate can be listed in Claude's own surfaces, what each one needs,
and which steps only a human with an account can do.

Read the short version first, because it decides everything below: **the
Connectors Directory is not one of the doors.** Hypergate is listable in three
places, and the one most people mean by "an official Claude connector" is the
one it cannot use.

## Why the Connectors Directory is closed to us

The Connectors Directory takes **internet-hosted remote MCP servers only**:

- a publicly reachable `https://` endpoint, conventionally ending `/mcp`
- Streamable HTTP transport (SSE is no longer accepted)
- OAuth 2.1 with PKCE and the 401 discovery contract
- every tool carrying a title and the applicable `readOnlyHint`/`destructiveHint`
- a public privacy policy — a missing one is an immediate rejection

Claude reaches a submitted server by dialling **out** to it from Anthropic's own
IP ranges. Hypergate serves `http://localhost:7777/mcp` on the user's machine.
There is no address for Anthropic to dial, and giving them one would mean
running a gateway of ours on the public internet — which is the opposite of the
promise in [PRIVACY.md](../PRIVACY.md), that nothing leaves the machine because
there is no server of ours to leave it to.

So the directory is not a gap in our paperwork. It is a different product. If we
ever want it, it is a hosted-gateway decision first and a submission second.

Worth keeping: we already meet the parts of that bar that are about quality
rather than hosting. Tool titles and behavioural hints survive the gateway hop
(`packages/core/src/gateway.ts`), and the privacy policy is public.

## The three doors that are open

| Surface | What it lists | Metadata source | State |
| --- | --- | --- | --- |
| Claude Code plugin directory | the `hypergate` plugin | `.claude-plugin/marketplace.json`, `plugins/hypergate/.claude-plugin/plugin.json` | manifests complete, needs submitting |
| Claude Desktop extensions | `hypergate.mcpb` | `packaging/mcpb/manifest.json` | icon wired, needs signing + submitting |
| MCP registry | the npm package | `server.json` | committed, needs publishing |

### 1. Claude Code plugin directory

Both manifests are complete and version-locked by `npm run version:check`, so
there is nothing to write. Submit at `clau.de/plugin-directory-submission`.

Two destinations sit behind that one form:

- the **community marketplace** (`anthropics/claude-plugins-community`), which
  runs automated validation and safety screening — this is the one to expect
- the **official directory** (`anthropics/claude-plugins-official`), curated by
  Anthropic with no public application; you do not apply, you get picked

Until then the marketplace installs directly from the repo, which already works
and needs nobody's permission:

```bash
claude plugin marketplace add nekko-labs/hypergate
claude plugin install hypergate@nekko-labs
```

### 2. Claude Desktop extensions

`npm run build:mcpb` produces `dist-mcpb/hypergate.mcpb`. The manifest now
carries `icon`/`icons`, copied into the archive from the same gate mark the site
and the PWA use, because a bundle has no network at install time and the
submission form wants an icon.

Signing is wired on the same secret-gated terms as every other artifact (see
[signing.md](signing.md)):

```bash
npm run build:mcpb -- --self-signed   # local check, not for release
MCPB_SIGNING_CERT=cert.pem MCPB_SIGNING_KEY=key.pem \
  npm run build:mcpb -- --sign        # release
```

Unsigned, Desktop installs it behind an "unverified" warning. A signing
certificate is the one blocking item here, and it is the same procurement
problem as the dormant Windows Authenticode account in `signing.md` — not a
code change.

### 3. MCP registry

`server.json` is committed, and `mcp-publisher` reads it:

```bash
mcp-publisher login github     # as the nekko-labs org
mcp-publisher publish
```

The registry checks two things that are easy to get wrong, so both are wired
rather than remembered:

- **`mcpName` must match.** The published `hypergated` package carries
  `mcpName`, and `scripts/build-npm.mjs` reads it out of `server.json` so the
  two cannot drift.
- **Versions must agree.** `server.json` states the version twice (its own and
  the npm package's); `scripts/bump-version.mjs` moves both, and
  `npm run version:check` fails on drift.

There is a nice wrinkle in the namespace choice. `server.json` currently claims
`io.github.nekko-labs/hypergate`, which is verified by GitHub org ownership and
needs no DNS work. But Hypergate's own trust logic —
`officialFromNamespace()` in `packages/core/src/registry-search.ts` — reads a
reverse-DNS namespace as domain-verified and an `io.github.*` one as community.
Publishing as `app.hypergate/hypergate` instead would earn the **✓ Official**
chip, including inside Hypergate's own catalog. It costs a DNS TXT record on
`hypergate.app` and a matching `mcpName` bump. Worth doing, deliberately, rather
than by accident.

## What still needs a human

| Step | Blocked on |
| --- | --- |
| Submit the plugin | an account at `clau.de/plugin-directory-submission` |
| Submit the `.mcpb` | the desktop-extension form, plus a signing certificate |
| `mcp-publisher publish` | a GitHub login as `nekko-labs` |
| Domain namespace (optional) | a TXT record on `hypergate.app` |

Everything a repo can carry is in the repo. What is left is accounts and a
certificate.
