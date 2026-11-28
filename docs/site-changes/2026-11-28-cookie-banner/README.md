# Cookie banner (2026-11-28)

The website consent prompt from #141 now reads as a cookie banner: a themed cookie
icon, the line "Our cookies are made with only the best ingredients. No spam or data
sales risks inside.", and **No thanks** / **Accept cookies** in the site's ghost pill
button style. Both buttons keep an identical style so declining is as easy as accepting
(the harness asserts this). The settings dialog and its labels are unchanged.

Storage is unchanged: the choice and random ID still live in local storage, not HTTP
cookies, so nothing rides along with page requests. The Privacy page says so.

Before: [desktop](../2026-11-27-consent/after-home-desktop.png) ·
[mobile](../2026-11-27-consent/after-home-mobile.png). After: this folder, captured by
`apps/site/scripts/verify-consent.mjs` (`SITE_CAPTURE_PHASE=after`) with the same
fixtures, after the full desktop, unconfigured/GPC/DNT, mobile and no-JS checks passed.
