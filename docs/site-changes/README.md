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
| 2026-08-04 | Hero headline `One gate.` → `One secure gate.`, subhead rewritten around safely connecting agents to real services | [`2026-08-04-secure-gate-hero`](2026-08-04-secure-gate-hero) |

## Capturing shots

Run the site (`npm --prefix apps/site run dev`, port 4390) and screenshot the sections you
changed at 1440x980 for desktop and 390x844 for mobile. Downscale 2x captures to 1x before
committing so this folder stays small as it grows.

Drive the capture through CDP (`Emulation.setDeviceMetricsOverride`), not a bare
`msedge --headless --screenshot --window-size=390,844`: the window size alone leaves the
layout viewport desktop-wide and merely crops the image, so a "mobile" shot taken that way
shows the desktop layout with its right side cut off. Two more things the hero needs, or the
shot comes out blank: give the page ~4s of settle time for the fonts, the WebGL gate and the
1.1s `.fly` hero animation, and add `.in` to every `.reveal` element before capturing
anything below the fold.
