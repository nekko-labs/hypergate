---
name: hypergate
description: How API keys, CLI logins and MCP servers work on a machine running Hypergate. Use whenever a command or API call needs a key or token, a CLI says it is not logged in, you are about to run a vendor login (gh auth login, aws configure, gcloud auth login, fly auth login, vercel login, npm login), you want to set or export an API key, or you need to install a CLI or MCP server.
---

# Hypergate: keys, CLIs and MCP servers on this machine

Hypergate (http://localhost:7777) manages the API keys, CLI logins and MCP servers agents use here. Follow these rules in every project:

- Keys live in Hypergate's vault. Run a command that needs one as `hypergate run --agent claude-code -- <command>` (add `--with <credential-id>` to pick one), or use the `hypergate__credentials_list` and `hypergate__credential_env` gateway tools.
- Never write a key, token or password into a file, `.env`, shell rc file, config, commit or chat, and never `export SOME_API_KEY=...`.
- Never sign a CLI in yourself (`gh auth login`, `aws configure`, `gcloud auth login`, `fly auth login`, `vercel login`, `npm login`, ...) and never ask the user to paste a key. If a key is missing or refused, request it with `hypergate__credential_request`, or tell the user which one to approve in Hypergate.
- Need a CLI or MCP server that is not installed? Check `hypergate__clis_list` or `hypergate__server_resolve`, then ask with `hypergate__cli_install_request` or `hypergate__server_install_request`. Do not install it yourself.
- If Hypergate's credential lockdown is on, refusals are expected. File a request and wait for approval instead of working around it.

A skill loads when a task looks like it needs it. For the same rules in every session, run `hypergate instructions install claude-code`, which adds them to your global `CLAUDE.md`.
