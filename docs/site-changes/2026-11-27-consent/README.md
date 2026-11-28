# #140 · Website analytics and privacy choices

## Reference and baseline

- The reference is the current [Nekko Agent privacy policy](https://nekkoagent.com/privacy) and the website’s `analytics.js` / `privacy-controls.css` at Nekko Agent `origin/main` (`247dad21e` when inspected). The shared patterns are plain-language scopes, equally prominent choices, and a persistent way back to preferences. Hypergate uses its own Midnight palette and sends fewer kinds of data. Nekko Agent’s public `/terms` returned 404, so Hypergate’s Terms points to its own MIT license rather than an unrelated policy.
- The baseline is a clean `git archive` of Hypergate `7ddfc1d`, built in a separate temporary directory. The refreshed release-notes comparison uses `1ca5c08` (the merge of #136) and the integrated build, both with the archive collapsed. Both previews use the same intercepted GitHub release fixture. Desktop is 1440 × 900 and phone is 390 × 844 (Chromium with touch and mobile UA); both use the same site theme. New legal and settings surfaces have no before state.

## Download and install intent inventory

| Surface | Counted | Not counted |
| --- | --- | --- |
| Home header, hero and Quick start | A visible primary link to a Hypergate release installer. | Generic `releases/latest` fallback (including unsupported Intel Mac), GitHub repo, scrolling to Quick start. |
| Linux picker on Home and Release notes | A followable DEB, RPM, or tarball option. | Opening the picker, unavailable options with no `href`, hidden controls. |
| Release-notes header and hero | A visible primary link to a Hypergate release installer. | GitHub repo and listing fallbacks. |
| Individual releases | Direct installer asset links and direct installer links in rendered release copy. | Full release on GitHub, checksums, and links to other repos or elsewhere. |
| Home install command | `install_command_copied=shell` after the clipboard write succeeds; the command and destination are not analytics data. | Failed copy; static npm/terminal instructions (no copy control); no claim that a command was executed. |
| Mobile | Individually linked release assets remain followable if displayed. | The existing mobile behavior hides the platform-specific primary controls and command. |

A download event measures a click, not a completed download or installation. The shared helper accepts `macos`, `windows`, `linux` and `other` (ZIP/TGZ). ZIP/TGZ links in release copy are counted when they point directly to a Hypergate release asset; they are not listed automatically in the installer chips. Keyboard and middle-click navigation are supported. The page event uses only the route’s fixed label, not the URL, title or host.

## Evidence

| Surface | Before | After |
| --- | --- | --- |
| Home · desktop | [Hero](before-home-desktop.png) · [Footer](before-home-footer-desktop.png) | [Hero / first choice](after-home-desktop.png) · [Footer](after-home-footer-desktop.png) |
| Home · mobile | [Hero](before-home-mobile.png) · [Footer](before-home-footer-mobile.png) | [Hero / first choice](after-home-mobile.png) · [Footer](after-home-footer-mobile.png) |
| Release notes · desktop | [Top](../2026-11-27-consent-release-highlights/before-releases-desktop.png) · [Footer](../2026-11-27-consent-release-highlights/before-releases-footer-desktop.png) | [Top / first choice](../2026-11-27-consent-release-highlights/after-releases-desktop.png) · [Footer](../2026-11-27-consent-release-highlights/after-releases-footer-desktop.png) |
| Release notes · mobile | [Top](../2026-11-27-consent-release-highlights/before-releases-mobile.png) · [Footer](../2026-11-27-consent-release-highlights/before-releases-footer-mobile.png) | [Top / first choice](../2026-11-27-consent-release-highlights/after-releases-mobile.png) · [Footer](../2026-11-27-consent-release-highlights/after-releases-footer-mobile.png) |
| Remote card · desktop | [Before](before-remote-desktop.png) | [After](after-remote-desktop.png) |
| Remote card · mobile | [Before](before-remote-mobile.png) | [After](after-remote-mobile.png) |
| Privacy choices | New | [Desktop](after-settings-desktop.png) · [Mobile](after-settings-mobile.png) |
| Privacy policy | New | Desktop: [first view](../2026-11-27-consent-release-highlights/after-privacy-desktop.png) · [full page](../2026-11-27-consent-release-highlights/after-privacy-full-desktop.png) / Mobile: [first view](../2026-11-27-consent-release-highlights/after-privacy-mobile.png) · [full page](../2026-11-27-consent-release-highlights/after-privacy-full-mobile.png) |
| Terms | New | Desktop: [first view](after-terms-desktop.png) · [full page](after-terms-full-desktop.png) / Mobile: [first view](after-terms-mobile.png) · [full page](after-terms-full-mobile.png) |

The legal pages were recaptured from the integrated source: first view with the choice prompt, full page after declining. For the Remote card the browser was scrolled to the same card position on both builds and the prompt was dismissed on the after build.

## Reproducing the checks

Run `npm --prefix apps/site test`. For the browser checks, use three isolated Vite production previews: the clean baseline on loopback port 4540 (captures only), the working build on 4521, and the working build with empty config on 4522. Build the working variants from the integrated source, including `packages/browser-analytics/{index,build-config}.ts`, in isolated directories with no `.env` files or inherited overrides. The first command uses a fake client token; the explicitly empty variables in the second override the production defaults:

```sh
# Run from apps/site in the isolated working source copy; serve the two builds in separate terminals.
VITE_HYPERGATE_POSTHOG_KEY=phc_test140 VITE_HYPERGATE_POSTHOG_HOST=https://us.i.posthog.com npm run build -- --outDir dist-test-on
VITE_HYPERGATE_POSTHOG_KEY= VITE_HYPERGATE_POSTHOG_HOST= npm run build -- --outDir dist-test-off
npm run preview -- --outDir dist-test-on --host 127.0.0.1 --port 4521 --strictPort
npm run preview -- --outDir dist-test-off --host 127.0.0.1 --port 4522 --strictPort
```

With Playwright and Chromium installed, run:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright node apps/site/scripts/verify-consent.mjs
```

Set `SITE_EVIDENCE_DIR` to save screenshots; also set `SITE_VIDEO_TMP` to a separate writable directory for browser video. The browser fixture intercepts release metadata, GitHub navigation and `POST https://us.i.posthog.com/i/v0/e/`, and aborts other non-loopback traffic. Chromium is also configured not to resolve non-loopback names. No request was sent to the live collector. Do not visit the configured build outside the intercepted harness.

## Verification results

- All 15 site unit tests and both shared analytics transport tests passed. The configured and explicitly empty Vite production builds passed the Chromium harness using the integrated shared helper. The desktop flow asserted exactly **eight intercepted collector attempts**. Middle-clicking the rendered **Portable ZIP** link in the release fixture followed the exact ZIP URL and produced one `hypergate_site_download_clicked` with `value: 'other'`. The suite checks the full event JSON, a stable UUIDv4 while opted in, disabled person profiles and GeoIP enrichment, and no cookie or referrer header.
- First visit, decline, withdrawal, empty config, Global Privacy Control and Do Not Track sent nothing. Withdrawal removed the ID. Keyboard and touch choices, installer navigation, the Linux picker and disabled RPM, Intel fallback, and both clipboard outcomes passed. A failed copy and the generic GitHub release link did not produce events.
- After merging #136, the suite also confirmed that the archive stays collapsed until opened, highlight links do not count as installer intent, and static highlights and legal links survive GitHub failure or JavaScript being off. Refreshed release notes and final Privacy copy at both widths; checked the PNG dimensions and inspected text and placement with OCR. Both legal pages show the updated Nekko Labs LLC copy and the two consent actions in the first viewport. The full-page captures include the policy/terms sections after decline. The Remote card kept its bounds at both sizes; the old “nothing phones home” language was replaced with an explanation that the provider receives the requests sent to its server. Prior consent motion evidence remains unchanged: [desktop GIF](consent-flow-desktop.gif) · [mobile GIF](consent-flow-mobile.gif).

### Vercel build and public site

| Build layout | Result |
| --- | --- |
| Root Directory `apps/site`, with the parent repository available | `npm run build` succeeded and produced all four routes in `dist`. |
| Monorepo root | `npm --prefix apps/site run build` with site dependencies installed produced byte-identical defaults and explicit-empty outputs in `apps/site/dist`. The repository’s plain `npm run build` is not the site build. |
| `apps/site` source only | Build failed resolving `../../../packages/browser-analytics/build-config`. If Vercel uses `apps/site` as Root Directory, enable [Include source files outside of the Root Directory in the Build Step](https://vercel.com/docs/monorepos/monorepo-faq#can-i-share-source-files-between-projects-are-shared-packages-supported). |

Serving both default bundles entirely through browser interception at `https://hypergate.app` loaded all four routes and their built assets. Both showed the first-visit prompt without making any collector attempt or writing storage. An intercepted non-production origin with defaults and the intercepted production origin with explicitly empty config both kept analytics unavailable. No traffic escaped those browser checks.

Read-only checks of the public Vercel site on 27 November 2026 returned HTTP 200 for the homepage, release notes and their referenced script/style assets. The public homepage was byte-identical to the clean baseline; `/privacy/` and `/terms/` returned HTTP 404. The repo records `apps/site` as the configured root in [TASKS.md](../../../TASKS.md), but the Vercel CLI had no credentials to confirm the current root, source-inclusion toggle, or deployment settings. Local bundle verification does not establish that the integrated site is deployed.

## Unfinished work / release limits

- Inspect all four routes and their assets using an authorized Vercel preview session. Build success is not rendered preview verification. If the root or include-source setting changes, confirm the repository parent source is still available; after deployment check all four public routes without opting in.
- No live PostHog ingestion, EU-host runtime, real installer download, physical phone, Safari or Firefox was tested. See the [manager verification](../../../screenshots/140-analytics/README.md) for desktop-shell limits.
