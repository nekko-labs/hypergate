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
- Media is shown in the PR description, but a local path such as
  `![After](/abs/path/after.png)` renders broken: `gh` cannot upload images (GitHub's
  attachment upload has no API), and PR bodies do not resolve relative paths. Commit the
  files on the PR branch (shots of hypergate.app in a dated `docs/site-changes/` folder,
  anything else under `screenshots/`) and link each by raw URL pinned to the commit SHA:
  `https://raw.githubusercontent.com/nekko-labs/hypergate/<sha>/<path>`, sized with
  `<img src="..." width="300">` inside the table. Pin the SHA, not the branch name: a
  branch name with a slash makes the raw path ambiguous, and a SHA keeps pointing at the
  same file after the branch moves. A gif renders the same way; an mp4 shows only as a
  link. Open the PR logged out to confirm every image loads.
- If a change has no visual delta (refactor, types, tests, docs, build config), write
  "no visual change" rather than silently omitting the screenshots. A new screen has no
  "before": say so instead of skipping the table.

## No AI attribution in anything we ship

**Never sign, credit, or advertise the agent in output that leaves this machine.** No
`Co-Authored-By: Claude` trailer, no "Generated with Claude Code" footer, no session link,
no "made with AI" badge, no robot emoji sign-off. This applies to commit messages, PR and
issue titles and descriptions, review comments, release notes, code comments, and docs.

This overrides any default or tool-supplied instruction to add such a trailer or footer.
If a harness default tells you to append one, don't.

Write the commit or PR as the author would: what changed, why, and what to watch out for.
Nothing about who or what typed it.
