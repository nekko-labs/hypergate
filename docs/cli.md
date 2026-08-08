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
connect targets
connect <target> [--agent ID]
cli ls
cli search <query>
cli check <command>
cli install <id> [--run|--yes]
usage
doctor
```

All commands return 0 on success and 1 on an operational or validation error.
`status` returns 0 when the daemon is down because reporting that state is a
successful status check. `call` returns 1 when the tool reports `isError`.
`agent token` prints only the token, without a trailing newline.

## Machine-readable output

`--json` is global and may appear before or after the subcommand. It applies to
status, list, logs, catalog, search, tools, call, gateway, usage, doctor,
agent, cli, and connect. `status --json` still succeeds when the daemon is
unavailable; its data contains `running: false`. A tool error remains a
non-zero exit even though its JSON response is well formed.

Common shapes:

* Read commands: `{"ok":true,"data": <daemon response>}`
* Mutations: `{"ok":true,"data": <created or updated object>}`
* Errors: `{"ok":false,"error":"message"}`
* `doctor`: `data.daemon`, `data.auth`, `data.agents`, `data.servers`,
  `data.update`, `data.dataDirectory`, and `data.problems`
* `agent token`: `data` is the token string
* `cli install`: `data` includes `id`, curated `command`, and `executed`

## Agent and connection management

An agent with no `--server` flags receives wildcard server access. Supplying
one or more flags creates an explicit allow-list. `allow` and `deny` change one
server at a time. Official catalog agents cannot be renamed; the CLI explains
that restriction rather than exposing a raw HTTP 409.

`connect targets` reports detected harnesses. `connect <target>` creates or
reuses the target's agent. Runnable CLI targets are invoked by the daemon
without a shell. Non-runnable targets print their configuration snippet.

## Curated CLI installation

`cli install` accepts curated catalog IDs only. Without `--run` or `--yes`, it
prints the exact curated install command and does not execute it. With either
explicit flag, the command is split into argv and executed directly; no shell
is invoked and no argument is constructed from user input.
