# Release notes

One file per version: `docs/releases/<version>.md`, matching the version in the
root `package.json`. Every PR bumps that version, so every PR that changes
something a user would notice writes or extends the matching file. The release
workflow reads it, `scripts/release-notes.mjs` adds the install footer, and both
the GitHub release and [hypergate.app/release-notes.html](https://hypergate.app/release-notes.html)
render the result.

The shape:

```markdown
# A headline in plain words

One sentence on what this release is for.

### Features

- **The change, in the words a user would use.** Then what it replaces, and why
  the new way is better.

### Bug fixes

- **What was broken, from the outside.** What you would have seen, and what
  happens now.

### Performance improvements

- What got faster or lighter, and when you would notice.
```

The rules that keep these readable:

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
