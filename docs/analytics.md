# Hypergate analytics operator guide

Use these three signals side by side. They answer different questions; **none counts completed installs**. Keep each metric labeled with its source and coverage.

| Signal | What to count | What it does not show |
| --- | --- | --- |
| **Website install intent** | `hypergate_site_download_clicked` by installer platform and `hypergate_site_install_command_copied` for the shell command. Compare them with opted-in home and release-note page views if you want context on recent site activity. | A click can be canceled; a copy may never be run. Repeats are separate actions. Direct GitHub links, other install channels, visitors who decline, and blocked requests are outside this measure. |
| **GitHub release-asset downloads** | GitHub's aggregate `download_count`, per asset for a release. This is the source for actual GitHub asset download activity, not PostHog clicks. | GitHub's counter is not a verification of a complete transfer or install. Repeated downloads, automated jobs, update requests and multiple assets from one install can count. Mirrors and package registry downloads do not appear here. |
| **Opted-in native Manager activity** | `hypergate_manager_manager_opened` for an eligible document (including enabling reports while already open), plus `hypergate_manager_view_opened` and `hypergate_manager_feature_used` for instrumented views and actions. | A report is not an install or a first-ever launch. The same installation can open multiple documents. Reopening a still-live window may not produce a new open event. Headless installs, normal browsers, the Nekko Agent embed, non-consenting users and failed sends are absent. A connection action does not prove the agent went on to use the gateway. |

The website events tell us whether visitors find and choose an installer route.
GitHub counts asset requests from more than the website. Manager reports tell us
whether consenting desktop users open the app and try specific features. Don't
join these into a personal funnel, divide one population by another to claim an
install conversion rate, or add the counts together. The website and Manager
use separate random IDs, not installation or person IDs. Clearing storage or
withdrawing consent can reset an ID. Treat a distinct-ID count as a count of
observed IDs only.

## Check GitHub downloads

Use an authenticated GitHub CLI (through the approved Hypergate connection where
required). To list the published download counts for the latest release:

```sh
gh api repos/nekko-labs/hypergate/releases/latest \
  --jq '.assets[] | [.name, .download_count] | @tsv'
```

For a fixed release, use `releases/tags/<tag>` instead of `releases/latest`.
The result is cumulative, not a time series. For a window, record timestamped
snapshots for the same release and asset IDs and compare the counters. Select
installer files deliberately: the output also includes aliases, standalone
binaries, shell packages and checksum files. Summing all rows overstates
installer download activity, and even installer-only counts are not unique
people or completed installs.

## Know what was verified

`packages/browser-analytics/index.ts` is the allowlist and transport; [SPEC
§3.14](../SPEC.md#314-optional-adoption-analytics-140) lists the event names and
properties. The website and Manager checks in
[`apps/site/scripts/verify-consent.mjs`](../apps/site/scripts/verify-consent.mjs)
and [`apps/web/scripts/verify-usage-reports.mjs`](../apps/web/scripts/verify-usage-reports.mjs)
inspect intercepted requests. Those checks can show the outgoing shape and lack
of sends at the gates they exercise. They don't verify delivery to the release
project. A browser harness with a native marker exercises the frontend guard;
it isn't a native webview test. Screenshots show controls, not network silence.

Before calling collection live, confirm that each intended build uses the
approved PostHog project and host; confirm the actual project retention and IP
handling rather than assuming settings from another project. Verify the expected
events from controlled, opt-in checks on the deployed site and an actual packaged
native Manager, and confirm that decline, withdrawal and applicable privacy
signals prevent future sends. Keep test activity separate from adoption reports.
A successful request alone does not prove the event appeared in the intended
project. With no valid destination configured, reporting is off; a zero count
then tells you nothing about adoption.

## Build destination

Production builds use the dedicated **Hypergate** project (US, ID `772266`). The checked-in `phc_` value is a public ingestion token, never a personal API key. The website default requires the exact production origin; previews and development do not inherit it. The Manager requires the native shell marker and a production build. For isolated tests explicitly set both `VITE_HYPERGATE_POSTHOG_KEY` and `VITE_HYPERGATE_POSTHOG_HOST` to a test destination; setting either to the empty string disables reporting. The only accepted hosts are the US and EU PostHog ingestion origins. Always intercept collector traffic in UI tests.
