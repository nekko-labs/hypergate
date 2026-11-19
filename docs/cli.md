# Hypergate CLI

`hypergate` is a thin client for the local daemon. It never replaces daemon
policy or server lifecycle logic.

## If you are an agent

Start with:

1. `hypergate doctor --json`
2. `hypergate mcp-headers <agent> --create` when a client needs credentials
3. `hypergate agent add <name>` followed by `hypergate agent allow <id> <server>`
4. `hypergate tools --json`
5. `hypergate call <tool> --json <arguments>`

Use `--json` for automation. The success envelope is
`{"ok":true,"data":...}`. Errors are printed to stdout as
`{"ok":false,"error":"..."}` and return a non-zero status.

## Commands

Flat command reference:

```
app
tray
start [--no-open] [--no-shortcut] [--desktop]
stop
restart
update [--apply]
status
list
logs <server>
catalog [filter]
search <query>
add <id> [--id ID] [--name NAME] [--connection ID] [--command CMD] [--arg ARG]... [--env KEY=VALUE]... [--secret KEY=VALUE]... [--runtime RUNTIME] [--image IMAGE] [--url URL] [--cwd DIR] [--no-start]
rm <server>
server start|stop|restart <server>
tools [--server ID]
call <tool> [args] [--arg KEY=VALUE]...
open
gateway [--token-only]
mcp-headers <agent> [--create]
icon <path>
shortcut install|uninstall|status [--desktop]
autostart on|off|status
secret get|set|delete|check <key>
sandbox-exec [--mem MB] [--cpu PERCENT] [--nofile COUNT] [--strict] -- <program> [args...]
agent ls
agent add <name> [--server ID]... [--target TARGET]
agent rm <id>
agent allow <id> <server>
agent deny <id> <server>
agent rename <id> <name>
agent token <id>
agent rotate <id>
targets
connect <target> [--agent ID]
cli ls
cli search <query>
cli check <command>
cli install <id> [--run|--yes]
instructions status
instructions install <harness>|--all
instructions remove <harness>|--all
usage
doctor
```

All commands return 0 on success and 1 on an operational or validation error.
`status` returns 0 when the daemon is down because reporting that state is a
successful status check. `call` returns 1 when the tool reports `isError`.
`doctor` returns 1 when the daemon is down, authentication is disabled, or a
plaintext token is used while a keychain is available. `secret check` returns
1 when no usable keychain exists. `agent token` prints only the token, without
a trailing newline. `cli install` returns 0 when it prints a manual instruction
without executing it; a failed executed installer returns 1.

## Machine-readable output

`--json` is global and may appear before or after the subcommand. It applies to
status, list, logs, catalog, search, tools, call, gateway, usage, doctor,
agent, cli, instructions, targets, connect, start, stop, restart, update, add, rm,
server start|stop|restart, mcp-headers, secret check, shortcut status, and
autostart status. `app`, `tray`, `open`, `icon`, and `sandbox-exec` deliberately
remain human/interactive-only. `status --json` still succeeds when the daemon is
unavailable; its data contains `running: false`. A tool error remains a
non-zero exit even though its JSON response is well formed.

Common shapes:

* Read commands: `{"ok":true,"data": <daemon response or rendered read model>}`
* Mutations: `{"ok":true,"data": <created, updated, or action result>}`
* Errors: `{"ok":false,"error":"message"}`
* `doctor`: `data.daemon`, `data.auth`, `data.agents`, `data.servers`,
  `data.update`, `data.dataDirectory`, and `data.problems`
* `agent token`: `data` is the token string
* `targets`: `data.targets` contains detected and runnable harness rows
* `usage`: `data` contains total calls/errors and server analytics
* `start`/`restart`: `data.running`, URL, and (for restart) PID
* `stop`: `data.stopped` and current running state
* `update`: update information, or `{"applied":true}` with `--apply`
* `server` actions: the affected server id and completed action
* `secret check`: `data.available`; `shortcut status`: launcher rows;
  `autostart status`: `data.enabled`
* `cli install`: `data` includes `id`, curated instruction, and `executed`;
  prose/URL instructions are never executed

## Agent and connection management

An agent with no `--server` flags receives wildcard server access. Supplying
one or more flags creates an explicit allow-list. `allow` and `deny` change one
server at a time. Official catalog agents cannot be renamed; the CLI explains
that restriction rather than exposing a raw HTTP 409.

`targets` reports detected harnesses. `connect <target>` creates or
reuses the target's agent. Runnable CLI targets are invoked by the daemon
without a shell. Non-runnable targets print their configuration snippet.

## Agent instruction files

`instructions` puts a short Hypergate block into each agent harness's global
instruction file: Claude Code (`~/.claude/CLAUDE.md`, or under
`CLAUDE_CONFIG_DIR`), Codex (`~/.codex/AGENTS.md`, or under `CODEX_HOME`),
Gemini CLI and Antigravity (`~/.gemini/GEMINI.md`), OpenCode
(`~/.config/opencode/AGENTS.md`, or the Claude Code file it falls back to), and
Devin Desktop (`~/.devin/global_rules.md`). The block tells every session that
keys come from the vault through `hypergate run`, that keys are never written
down or pasted, and that a missing key, CLI or server is requested rather than
worked around, whichever model the harness runs on.

The block sits between `<!-- hypergate:begin vN -->` and
`<!-- hypergate:end -->`; nothing outside the markers changes. `install` is
idempotent and upgrades an older block in place. `--all` installs for every
harness whose config directory exists, and removes from every file that has a
block. Before Hypergate first changes an existing file, the original is copied
to `~/.hypergate/instructions-backup/`. A file with a begin marker and no end
marker is reported and left alone. `hypergate start` suggests
`instructions install --all` when it finds harnesses with no block, and never
writes on its own. `install` and `remove` exit 1 if any file could not be
written.

## Curated CLI installation

`cli install` accepts curated catalog IDs only. Without `--run` or `--yes`, it
prints the exact curated install instruction and does not execute it. With
either explicit flag, only a plain argv-like instruction is executed directly;
URLs, prose, and shell syntax are reported as manual instructions. No shell is
invoked and no argument is constructed from user input.

## JSON examples

The envelope is stable even when the daemon reports an error:

```json
{"ok":true,"data":{"running":true,"version":"1.0.2","servers":2,"port":7777}}
{"ok":false,"error":"GET /api/servers failed (503): daemon unavailable"}
```

`agent ls`, `cli ls`, `cli search`, and `cli check` return their corresponding
daemon rows in `data`; `tools` returns tool rows; `call` returns the MCP result;
`logs` returns `{ "logs": [...] }`; `list` returns server rows; `catalog` and
`search` return registry rows; and `gateway` returns URL/token/stdio fields.
`agent add`, `allow`, `deny`, `rename`, `rotate`, and `connect` return the
daemon's resulting agent or connection object. `agent rm` and `rm` return the
removed id. `mcp-headers` returns the parsed headers object.
