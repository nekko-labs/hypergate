# Hypergate

**Local-first runtime and manager for MCP servers.** Run MCP servers securely, supervise them, and expose **one gateway endpoint** any agent harness (Claude Code, Cursor, Kotrain, Codex) can use.

> This is the installable package for [Hypergate](https://hypergate.app). Source: [nekko-labs/hypergate](https://github.com/nekko-labs/hypergate) · MIT

## Install

```bash
npm install -g hypergated
hypergate start
```

`hypergate start` is the whole setup: the daemon comes up in the background, you get a launcher to click next time (add `--desktop` for a desktop icon too), and the manager opens in your browser. `--no-open` and `--no-shortcut` turn either half off, and both are skipped automatically on CI, over SSH and on a display-less Linux box.

That gives you two commands:

- `hypergate`: the CLI, tray agent and sandbox launcher (a native binary, installed automatically for your platform)
- `hypergated`: the daemon on its own, for headless boxes, WSL and containers

Or run it without installing:

```bash
npx hypergated
```

## Use

```bash
hypergate start                 # daemon + launcher + manager, all at once
hypergate catalog               # browse servers you can add
hypergate add context7          # add one (browser sign-in where needed)
hypergate list                  # what's running
hypergate tools                 # what the gateway exposes
hypergate call ctx7__resolve-library-id '{"libraryName":"react"}'
hypergate gateway               # the endpoint + token to paste into your agent
hypergate open                  # the manager UI in your browser
hypergate tray                  # run it as a desktop tray app
hypergate autostart on          # start at login
```

## Updating

```bash
hypergate update                # what you have, what's out
hypergate update --apply        # install it and restart Hypergate
```

`--apply` stops Hypergate, installs the new packages, starts it again, and logs the lot to `~/.hypergate/update.log`. `hypergate status` says when there's something to take, and so does the manager: the version in the topbar turns into **Check for updates** on hover, then into the offer, with **Download & install**, **Download only** or **Skip** and a progress bar for the download.

Point an agent at the gateway:

```bash
claude mcp add -t http hypergate http://localhost:7777/mcp -H "Authorization: Bearer $(hypergate gateway --token-only)"
```

## Requirements

- **Node 20+** to run. Node **22.5+** is recommended: durable usage history and logs use the built-in `node:sqlite`, and on older runtimes Hypergate degrades to in-memory analytics rather than refusing to start.
- Nothing else. Docker is optional (opt-in per server), and there is no account, no cloud, and no telemetry.

## Where things are stored

Everything is local, under `~/.hypergate/` (override with `HYPERGATE_DIR`). Secrets live in the OS keychain (Credential Manager / Keychain / Secret Service), falling back to files there where no keychain exists.

Full documentation: <https://github.com/nekko-labs/hypergate>
