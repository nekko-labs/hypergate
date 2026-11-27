# #140 · Desktop manager usage reporting

Settings was captured at the same route, viewport, theme and simulated daemon state before and after. The before build is a clean Hypergate `7ddfc1d`; the after build uses the real `packages/browser-analytics/index.ts`. The 420 px captures show a narrow manager window, not a native mobile app.

| Surface | Before | After |
| --- | --- | --- |
| Desktop · dark | [Settings](manager-before-desktop-dark.png) | [Off by default](manager-after-desktop-dark.png) · [Enabled](manager-after-desktop-dark-enabled.png) |
| Desktop · light | [Settings](manager-before-desktop-light.png) | [Off by default](manager-after-desktop-light.png) |
| Narrow · dark | [Settings](manager-before-mobile-dark.png) | [Off by default](manager-after-mobile-dark.png) |
| Narrow · light | [Settings](manager-before-mobile-light.png) | [Off by default](manager-after-mobile-light.png) |

[Toggle on, then withdraw (GIF)](manager-consent-toggle.gif). The nine PNGs were decoded and inspected, including theme contrast, the usage-report title and privacy link, and the changed panel region compared with baseline. The desktop enabled image and motion frames were checked for the rendered off/on/off switch states. Desktop is 1200 × 820 at 2×, narrow is 420 × 844 at 1×, and motion is 900 × 620 at 1×.

## Verification results

- Both isolated manager production builds passed. The configured Chromium flow asserted 15 exact request payloads across opt-in, views, successful actions, reload, and re-grant; these were browser attempts intercepted locally, not live events. Event values and keys matched the closed schema. No server or agent names, commands, tokens, output, URLs, cookies, or referrer headers were in the reports.
- Verified default-off, keyboard opt-in, the four allowed views and duplicate-view suppression, successful start/stop/restart/add/connect, no reports on fixture failures, persistence across reload, withdrawal with ID removal, and a new UUIDv4 on re-grant. Failed collector fetches were swallowed without breaking the UI.
- A normal server action and view navigation remained usable but sent no reports before opt-in, after withdrawal, with both config variables empty (even with a saved grant), with Global Privacy Control or Do Not Track, in an unmarked browser page, or in a marked iframe. The unmarked case models what the app sees in the Nekko Electron guest; the Electron app itself was not exercised.

## Reproduce in isolation

Use a clean baseline on port 4530 for captures, a configured preview on 4531, and an unconfigured preview on 4532. Use fresh scratch directories without `.env` files or production credentials. Prepare the workspace dependencies including `packages/shared`, then run from each isolated working copy’s `apps/web`:

```sh
VITE_HYPERGATE_POSTHOG_KEY=phc_test140 VITE_HYPERGATE_POSTHOG_HOST=https://us.i.posthog.com npm run build -- --outDir dist-test-on
VITE_HYPERGATE_POSTHOG_KEY= VITE_HYPERGATE_POSTHOG_HOST= npm run build -- --outDir dist-test-off
# Run each preview in its own terminal.
npm run preview -- --outDir dist-test-on --host 127.0.0.1 --port 4531 --strictPort
npm run preview -- --outDir dist-test-off --host 127.0.0.1 --port 4532 --strictPort
```

From the repository root with Playwright and Chromium installed:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright node apps/web/scripts/verify-usage-reports.mjs
```

Set `MANAGER_EVIDENCE_DIR` for PNGs, and additionally `MANAGER_VIDEO_FRAMES_DIR` for the motion sequence. The harness intercepts daemon routes and the exact US collector URL; it blocks other external routes and configures Chromium not to resolve non-loopback names. Do not browse the configured preview outside the intercepted harness.

## Unfinished work / release limits

The manager ran in Chromium with an injected macOS shell marker and simulated daemon responses. No native OS title bar/traffic lights, WebView, native-shell actions, real server or client operations, live analytics delivery, or production configuration were verified. macOS `CGPreflightScreenCaptureAccess()` returned `false` on recheck. The installed app is v1.34.0, not this PR; it was not launched or manipulated for testing. Once capture is authorized, use a disposable build with separate home, data directory, loopback port, and synthetic fixtures. Capture the actual Settings window and verify native consent persistence and withdrawal without contacting the live collector. See the [website report](../../docs/site-changes/2026-11-27-consent/README.md) for the separate website integration gap.
