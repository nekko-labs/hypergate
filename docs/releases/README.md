# Release notes

One file per version: `docs/releases/<version>.md`, matching the version in the
root `package.json`. Every PR bumps that version (TASKS.md §4.1), so every PR
that changes something a user would notice writes or extends the matching file.
The release workflow reads it, `scripts/release-notes.mjs` adds the install
footer, and both the GitHub release and
[hypergate.app/release-notes.html](https://hypergate.app/release-notes.html)
render the result.

**Merging a version bump now cuts the release.** `version-release.yml` watches
pushes to main that touch `package.json`: when that version has no tag yet, it
tags it and dispatches `release.yml`. So the notes file has to exist **in the
same PR as the bump**, and the workflow refuses to tag without it, rather than
leaving a tag pointing at a release that never built. It also refuses when
`apps/shell/Cargo.toml` disagrees with `package.json`, since that version ends
up inside the built binaries.

**A release's notes cover everything since the last released tag, not just its
own version.** This mattered more before the automation, when a minor bump per
PR outran the tags: v0.16.0 was bumped and never released, so its changes went
out under v0.16.1, whose notes fold them in and say so. Bumps and tags now move
together, but if a release did get skipped, check what the next one actually
contains and make sure its file accounts for all of it:

```
git log $(git describe --tags --abbrev=0)..HEAD --no-merges --oneline
```

Nothing can tell that a notes file is *incomplete*. That part is the read-through
above.

The shape:

```markdown
# A headline in plain words

One sentence on what this release is for.

### Features

- **The change, in the words a user would use.** Say what it replaces or why it
  matters in one short sentence.

### Bug fixes

- **What was broken, from the outside.** Say what users saw and what happens
  now in one short sentence.

### Performance improvements

- **What got faster or lighter.** Say when users would notice in one short
  sentence.
```

The rules that keep these readable:

- **Keep each bullet compact.** Every bullet starts with a bold headline phrase and
  contains at most one short sentence describing the user-visible result.
- **Write for the person deciding whether to update.** They do not know our
  module names, our function names, or which file changed. "Links out of the app
  went nowhere" is the same fact as "the webview had no NewWindowRequested
  handler", and only one of them means anything to them.
- **Leave a section out when it is empty.** A "Performance improvements" heading
  with nothing real under it teaches people to skim past the headings.
- **The headline is not the version.** GitHub and the site both print the version
  right beside the title, so the title says what the release is.
- **Install instructions are the footer, not the notes.** They come from
  `scripts/release-notes.mjs`, so they are identical on every release and nobody
  has to write them.

The site renders a deliberately small subset of Markdown (`###` headings,
bullet lists, paragraphs, `**bold**`, `` `code` `` and links) as real DOM nodes
rather than parsed HTML. Anything outside that subset shows up as its own
literal punctuation on the page, so keep to it.
