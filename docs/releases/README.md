# Release notes

**PRs don't bump the version** (TASKS.md §4.1): releases go out nightly, as the
next patch on the current line, so a PR can't know which version will carry it.
Instead, a PR that changes something a user would notice adds **its own file**
under [`unreleased/`](unreleased/), named for the change
(`unreleased/nekko-labs-tag.md`). One file per PR means two PRs never conflict.

When a nightly is cut, `scripts/release-notes.mjs <version> --since <previous tag>`
takes every `unreleased/` file added since the previous tag, merges their
sections (Features, then Bug fixes, then Performance improvements), and adds the
install footer. A night with no files lists the titles of the PRs merged since the
last tag, so a release is never blank. The GitHub release and
[hypergate.app/release-notes.html](https://hypergate.app/release-notes.html)
render the result.

A hand-written `docs/releases/<version>.md` still wins over the files: write one
when Philip starts a new line (`v1.39`) and wants it headlined. The older
`<version>.md` files are the history from when every PR bumped the minor.

An `unreleased/` file is a cut of the shape below: `###` sections and their
bullets, no `# Headline` (a nightly's title is its version).

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

## Featured releases on hypergate.app

The Highlights timeline and the full archive share `/release-notes.html`. The
archive reads recent GitHub releases and links to the complete history. It does
not use the curated data.

For a release with something worth featuring, add an entry to
[`apps/site/src/release-highlights.json`](../../apps/site/src/release-highlights.json)
**after** the stable release is public. Use the UTC publication day from GitHub
and add newest entries first. Write one short title, one to three headliners
(each with a title and detail), and optional shorter `changes`. Give each item
its merged PR number and author handles, verified on GitHub. Include the human
contributors whose PRs shipped in that release, even if their changes aren't
featured. Don't add bots or unpublished tags.

The site build validates the entries and renders the index, headliners, and
credit links as static HTML. Run `npm --prefix apps/site test` and
`npm --prefix apps/site run build` when editing the list.
