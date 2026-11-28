# Privacy Policy

**Hypergate** — last updated 27 November 2026.

Hypergate is local-first. No account or hosted control plane is required. The
local gateway’s activity history is not shared with Nekko Labs or PostHog.
This policy covers the app and [hypergate.app](https://hypergate.app/). The
[website privacy policy](https://hypergate.app/privacy/) also describes the
website’s service providers and privacy controls.

## Who controls this data

Nekko Labs LLC is the controller for Hypergate’s website and optional usage
reports. We are a Wyoming company at 30 North Gould Street, Suite N, Sheridan,
WY 82801, United States. Contact us at <hello@nekkoagent.com> for privacy questions
or requests. Do not post private data in a public issue.

## Optional analytics

We use analytics to understand how people find Hypergate and which desktop
Manager features they use. The two choices are independent, off by default and
based on your consent. Declining does not limit the site or app.

| Where | What is sent if you opt in | How to change your choice |
| --- | --- | --- |
| **Website** | Visits to the home, release notes, privacy and terms pages; supported installer-link clicks by platform (macOS, Windows, Linux or a portable archive); successful copies of the shell install command. These actions measure interest, not downloads or completed installations. | **Privacy choices** in the footer |
| **Native Hypergate desktop Manager** | The Manager becoming active for reporting in the current document, which of its four views you open (Servers, People, Analytics or Settings), and reports of adding, starting, stopping or restarting a server, or connecting an agent, through the Manager. No device, server or agent names are sent. The browser-based Manager, Nekko Agent's embedded Manager, the background tray, the daemon and CLI commands do not send these events. | **Settings → Share usage reports** |

Each report uses a fixed event and value, the Hypergate product and the reporting
surface, and a random identifier for that surface. The website and desktop
Manager have separate identifiers; neither is linked to a Hypergate account.
The site and native Manager webview remember their respective choices in local
storage and create an analytics ID only after opt-in. The analytics transport
uses no SDK or analytics cookies and does not collect full URLs, referrers,
clipboard contents, tool calls, tool inputs or outputs, credentials, logs or
local gateway history. Location enrichment and person profiles are disabled for
these events. There is no session replay. PostHog receives standard connection
metadata such as your IP address when your device sends a report.

When your browser or desktop webview exposes **Do Not Track (DNT)** or **Global
Privacy Control (GPC)**, that signal blocks reporting and counts as turning analytics
off: a previous opt-in is withdrawn and its local ID removed. Turning analytics off in the controls
stops future events and removes the local analytics ID, but does not erase
reports already sent.

We use PostHog to process the reports on our behalf. We keep event-level data
only as long as needed to understand adoption and feature use, subject to the
retention settings for the receiving PostHog project and any applicable legal
requirements. The local choice stays until you change it or clear that storage.
We do not sell personal data or share it for cross-context behavioral advertising.

## What Hypergate stores locally

The daemon’s data directory defaults to `~/.hypergate`
(`%USERPROFILE%\.hypergate` on Windows); secrets may live in your OS keychain.
The website and native Manager analytics choices described above are stored
separately in their respective browser and webview storage.

| Data | Where | Why |
| --- | --- | --- |
| The MCP servers you configure | `~/.hypergate/servers.json` | So your servers are still there after a restart |
| Usage history: which tool was called, by which client, when, how long it took, how many bytes moved, and the error message if it failed | `~/.hypergate/hypergate.db` (SQLite) | The activity view in the Manager. Tool arguments and results are not stored as such; their sizes are recorded |
| Server logs (stdout/stderr of the servers you run) | `~/.hypergate/hypergate.db` | Diagnosing a server that won't start |
| Connected agents and their gateway tokens | OS keychain, else `~/.hypergate/clients.json` | So a client can authenticate to your local gateway |
| OAuth grants for remote servers you sign in to | OS keychain, else `~/.hypergate/oauth/` | So you don't sign in again every launch |
| Settings and update state | `~/.hypergate/settings.json`, `update.json` | Preferences, and when we last checked for a release |

Usage history is kept for 90 days by default and server logs for 14, pruned on
boot and daily thereafter (`HYPERGATE_RETAIN_USAGE_DAYS` and
`HYPERGATE_RETAIN_LOG_DAYS` change or disable these windows). To clear the database,
stop Hypergate and delete its local database files. To remove local daemon data,
delete its data directory and its associated keychain entries. Removing a server
deletes its stored OAuth grant.

## When Hypergate uses the network

The daemon and CLI do not send analytics. Other requests serve the actions or
features you use:

- **Registry and CLI search** — while you type, against the MCP registry or the
  supported package indexes (such as npm and Homebrew).
- **Catalog popularity** — npm download counts and GitHub stars, fetched when you
  open the catalog and cached for a day.
- **Releases and updates** — lookups against the npm registry or GitHub when you
  open the Manager or check for an update, and downloads when you request them.
  These are not usage reports.
- **The remote MCP servers you add** — traffic to their endpoint, plus OAuth
  sign-in and token exchange where needed. Managed local servers can also make
  their own requests. Review the services and their privacy policies before
  giving them access.
- **Team access and alerts** — the management interface listens on loopback.
  An optional team listener lets authorized people reach the gateway on your
  network. If you configure a team webhook, Hypergate sends alert metadata such
  as host, user, tool, event type, location and time to your chosen destination;
  it does not send credential values or parts of them.

Vercel serves the website, and GitHub serves public release information and
installer assets. These requests work without analytics consent. Both services
receive the IP address and other standard request metadata needed to serve the
requests. GitHub also publishes aggregate release-asset download counts.

## Your privacy rights

Depending on where you live, your rights can include access, correction,
erasure, restriction, portability, objection and withdrawal of consent. You may
also complain to your local data protection authority. Withdrawing consent
stops future reports and does not affect processing that already occurred.

Email <hello@nekkoagent.com> to make a request. We do not use an account or email
address to identify analytics events and may not be able to locate them without
the relevant random identifier. If you want to make a request and are unsure
how to identify your reports, contact us for help before clearing local storage
or turning off analytics, which removes the ID.

## Children and changes

Hypergate is a developer tool and is not directed at children under 13. We will
update this policy and its date when it changes. The history of this file is
public in the repository.
