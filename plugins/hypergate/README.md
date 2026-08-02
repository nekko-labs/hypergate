# Hypergate for Claude Code

Connects Claude Code to the [Hypergate](https://hypergate.app) gateway running on
this machine: one MCP endpoint that fans out to every server Hypergate manages,
with per-agent permissions and full local visibility into every call.

## Install

```bash
claude plugin marketplace add nekko-labs/hypergate
```

```bash
claude plugin install hypergate@nekko-labs
```

Then make sure the daemon is up:

```bash
hypergate start
```

That is the whole setup. There is no token to copy: the plugin's MCP entry names
a command (`hypergate mcp-headers claude-code --create`), and Claude Code runs it
at every connection to fetch the credential. On the first run it creates a
connected agent called **Claude Code** in the manager, and tells you it did.

## What you get

Every tool from every running server, namespaced `server__tool` — so a Postgres
server's `query` arrives as `postgres__query`. Which servers this agent may reach
is yours to set, per agent, in the manager at <http://localhost:7777> under
**Connected agents**. Turning a server off there hides its tools from Claude Code
on the very next request.

## Requirements

- Hypergate installed, with `hypergate` on your `PATH` (`npm i -g hypergated`, or
  one of the installers from the [releases page](https://github.com/nekko-labs/hypergate/releases)).
- The daemon running (`hypergate start`, or the tray/desktop app).

If the daemon is not running, the helper says so and the server shows as failed
in `/mcp` rather than hanging. Start the daemon and reconnect.

## Notes

- **A different port**: set `HYPERGATE_PORT` and the plugin follows it — the
  entry's URL is `http://localhost:${HYPERGATE_PORT:-7777}/mcp`.
- **Rotating tokens are fine.** Because the credential is fetched rather than
  stored, rotating the gateway token, deleting and re-creating the agent, or
  moving the daemon costs a reconnect and nothing else. Claude Code re-runs the
  helper automatically when a call comes back `401`.
- **Removing it**: `claude plugin uninstall hypergate@nekko-labs`. The connected
  agent stays in the manager until you delete it there, which also revokes its
  token.
