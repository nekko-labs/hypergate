# Site changes

A visual log of hypergate.app, one folder per change, newest at the bottom of the list.

Each folder holds the `before-*` and `after-*` screenshots for a single change, so the
site's history is reviewable without checking out old commits. **Nothing here is ever
overwritten or deleted** — a new change gets a new dated folder, and the older shots stay
put as the record of how the site looked at the time.

This is separate from `apps/site/public/demos/`, which holds the product screenshots the
live site actually serves. Those are also kept rather than replaced, so the app's own
visual history stays intact.

| Date | Change | Folder |
| --- | --- | --- |
| 2026-08-03 | First feature section reframed around security; three hero stats removed | [`2026-08-03-security-first-feature`](2026-08-03-security-first-feature) |

## Capturing shots

Run the site (`npm --prefix apps/site run dev`, port 4390) and screenshot the sections you
changed at 1440x980 for desktop and 390x844 for mobile. Downscale 2x captures to 1x before
committing so this folder stays small as it grows.
