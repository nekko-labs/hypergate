# Privacy Policy

**Hypergate** (Nekko Labs) — last updated 2 August 2026.

Hypergate is a local-first application. It runs on your machine, stores its data
on your machine, and needs no account. There is no telemetry or analytics service. The optional Nekko Cloud employee preview is described below.

## What we collect

If you choose to sign in to Nekko Cloud, your work email is used for authentication. Only when you publish a setup does Cloud store your start-minimized and window-close choices, recognized catalog server IDs, and their enabled flags under your account. The console can read this setup; it is not an end-to-end encrypted backup. It never includes keys, commands, URLs, environment values, account grants, or activity logs.

## What Hypergate stores, and where

Local data lives under `~/.hypergate` on your own machine (`%USERPROFILE%\.hypergate`
on Windows), plus your operating system's keychain:

| Data | Where | Why |
| --- | --- | --- |
| The MCP servers you configure | `~/.hypergate/servers.json` | So your servers are still there after a restart |
| Usage history: which tool was called, by which client, when, how long it took, how many bytes moved, and the error message if it failed | `~/.hypergate/hypergate.db` (SQLite) | The activity view in the manager. Tool *arguments and results are not stored* — only their sizes |
| Server logs (stdout/stderr of the servers you run) | `~/.hypergate/hypergate.db` | Diagnosing a server that won't start |
| Connected agents and their gateway tokens | OS keychain, else `~/.hypergate/clients.json` | So a client can authenticate to your local gateway |
| OAuth grants for remote servers you sign in to | OS keychain, else `~/.hypergate/oauth/` | So you don't sign in again every launch |
| Settings and update state | `~/.hypergate/settings.json`, `update.json` | Preferences, and when we last checked for a release |

Deleting `~/.hypergate` (and the `hypergate*` entries in your keychain) removes
the local data, not a previously published Cloud setup. Removing a server deletes its stored OAuth grant with it.

## When Hypergate uses the network

Network actions include:

- **Nekko Cloud preview**: sign-in, publishing, refreshing, and applying a reviewed setup are explicit actions. Cloud stores only the latest revision and its timestamp.

- **Registry search** — while you type a query into the catalog search, against
  the official MCP registry.
- **Catalog popularity** — npm download counts and GitHub stars, fetched when you
  open the catalog and cached for a day.
- **Update check** — the npm registry (or the GitHub releases feed) when you open
  the manager or press the button, cached for a day. It sends nothing about your
  installation; it is a lookup, not a report.
- **The remote MCP servers you add** — their endpoint, plus the OAuth sign-in and
  token exchange for the ones that need it. Those services have their own privacy
  policies; Nekko Labs is not a party to that traffic.

The daemon binds to localhost. Nothing listens on an external interface.

## Third parties

Hypergate runs MCP servers *you* choose, including ones published by other
people. Once running, a server can do whatever its own code does with the data
you send it. Hypergate isolates them (sandboxed processes or containers, secrets
injected at launch, per-client permissions) but it cannot vet their behaviour.
Review a server before you add it, exactly as you would any other software.

## Data retention

Usage history is kept for 90 days and server logs for 14, pruned on every boot
and once a day after that (`HYPERGATE_RETAIN_USAGE_DAYS` and
`HYPERGATE_RETAIN_LOG_DAYS` change or disable those windows). You can clear the
lot at any time by deleting the database. Usage history and server logs are not synced. The latest published portable setup stays in Cloud until replaced or the Cloud account is deleted.

## Children

Hypergate is a developer tool and is not directed at children under 13.

## Changes

Material changes to this policy will be reflected in this file, whose history is
public in the repository.

## Contact

privacy@nekkolabs.com · <https://github.com/nekko-labs/hypergate/issues>
