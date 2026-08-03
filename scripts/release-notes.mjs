// Build a GitHub release's title and body from `docs/releases/<version>.md`.
//
// A release note is for the person deciding whether to update, so what changed
// comes first, grouped the way they would group it (Features, Bug fixes,
// Performance improvements), and the install instructions are the footer. The
// notes file carries the human part; this script adds the footer, which is the
// same on every release except for one line: promising
// `npm install -g hypergated` on a release where nothing was published sends
// people to a 404, so the registry command only appears when we published.
//
// The release workflow calls this, and it is also how an already-published
// release gets its notes rewritten (`gh release edit --notes-file`), so both
// paths word the footer identically.
//
//   node scripts/release-notes.mjs 0.17.0          # the release body, on stdout
//   node scripts/release-notes.mjs 0.17.0 --title  # just the release title
//   node scripts/release-notes.mjs 0.17.0 --npm    # footer points at the registry
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const version = args.find((arg) => !arg.startsWith('-'))?.replace(/^v/, '');
const wantsTitle = args.includes('--title');
const published = args.includes('--npm');

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version> [--title] [--npm]');
  process.exit(2);
}

const file = join(repo, 'docs', 'releases', `${version}.md`);
const notes = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';

if (!notes && !wantsTitle) {
  // A release with no notes still installs fine, so this must not fail the
  // release. It should be loud, though: notes that say nothing about what
  // changed are the reason this script exists.
  console.error(
    `::warning::docs/releases/${version}.md is missing, so this release says nothing about what changed.`,
  );
}

// An optional `# Headline` first line is the release title. Both GitHub and the
// site show the version right next to the title, so it stays out of the
// headline itself.
const lines = notes ? notes.split('\n') : [];
const heading = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : '';
const body = (heading ? lines.slice(1).join('\n') : notes).trim();

if (wantsTitle) {
  console.log(heading || `v${version}`);
  process.exit(0);
}

const npmLine = published
  ? 'Prefer npm? `npm install -g hypergated`.'
  : 'Prefer npm? Install from the tarballs attached below: ' +
    `\`npm install -g hypergate-shell-<os>-<arch>-${version}.tgz hypergated-${version}.tgz\`. ` +
    '(`hypergated` is not on the public registry yet. These are the same packages, ' +
    'and they are what the in-app updater installs.)';

const footer = [
  '### Install',
  '',
  'Download the installer for your platform below. Nothing else needed, not even Node.',
  '',
  npmLine,
  '',
  'Bare `hypergate` command-line binaries are attached too, and `SHA256SUMS` is signed ' +
    'with the GPG key at `docs/release-signing-key.asc`, so you can verify what you downloaded.',
].join('\n');

console.log([body, footer].filter(Boolean).join('\n\n'));
