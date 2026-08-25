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

## Keys, without asking you to paste one

Hypergate also holds this machine's API keys and access tokens, and Claude Code can
use them without a secret ever passing through the conversation. Every session is
told so: the gateway advertises the vault when Claude Code connects.

When a command needs a key, Claude Code calls `hypergate__credentials_list` to see
what exists, then `hypergate__credential_env` to fetch one it has been granted and
set it on the process that needs it (or runs the command through
`hypergate run -- <command>`, which injects it).

Keys are **deny-by-default**: a new agent gets none. When Claude Code needs one it
has not been granted, it calls `hypergate__credential_request` with a short reason,
which files a request in the manager and returns a link. Open the link, press
**Approve**, and Claude Code's next attempt succeeds. Nothing is granted by the
request itself, and every fetch, refusal and reveal shows up in Analytics.

Claude Code can see the *names* of keys it has not been granted, so that it can ask
for them by name. It never sees a value, or even the masked hint. Turn off **Agents
can see credential names** in Settings if you would rather it saw only what you have
already handed over.

## Command-line tools, with you in the loop

The same shape covers CLIs. Claude Code calls `hypergate__clis_list` to see which
tools this machine has (with versions), and can pass a query to search the
installable catalog. When a tool is missing, it calls `hypergate__cli_install_request`
with the tool and a short reason; a badge appears on **CLI tools** in the manager,
and **Install & approve** runs the install there, log on screen. Claude Code never
installs anything itself, and **Deny** runs nothing.

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
