# Agent workflow

Conventions for any AI agent or human opening PRs in this repo.

## UI changes need visual evidence

Any PR that changes what the app looks like ships the proof in its description:

- **Before/after screenshots** for every visual change, in a two-column table labeled
  `Before` / `After`, captured at the same route, viewport, theme, and data. Take the
  "before" shot from the base branch before applying the change, not from memory.
- **A short screen recording** (a few seconds, mp4 or gif) whenever the change touches
  animation, transition, gesture, scroll, or timing. A still frame cannot show motion,
  so screenshots alone do not cover those changes.
- Cover every surface the change actually affects: mobile and desktop widths on web,
  iOS and Android for native, light and dark theme if both shift.
- Media belongs in the PR description, not in the repo. Reference a local path such as
  `![After](/abs/path/after.png)` and let the PR tooling upload it.
- If a change has no visual delta (refactor, types, tests, docs, build config), write
  "no visual change" rather than silently omitting the screenshots. A new screen has no
  "before": say so instead of skipping the table.
