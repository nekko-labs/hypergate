// Release notes for a nightly, from the note files PRs add.
//
// PRs no longer bump the version, so they can't write `docs/releases/<version>.md`:
// they don't know which nightly will carry them. Instead each PR that changes
// something a user would notice adds its own file under
// `docs/releases/unreleased/` (one file per PR, so two PRs never conflict).
// The nightly collects the files added since the previous release tag and merges
// their sections, in the order of docs/releases/README.md.
//
// A file's shape is a cut of the notes format: `###` sections with bullets.
//
//   ### Features
//
//   - **Nekko Labs servers are tagged in the catalog.** So our own servers stand out.

export const UNRELEASED = 'docs/releases/unreleased';
export const SECTIONS = ['Features', 'Bug fixes', 'Improvements', 'Performance improvements'];

/** Merge note fragments into one notes body. Sections keep SECTIONS order; unknown ones follow, in first-seen order. */
export function mergeFragments(fragments) {
  const sections = new Map();
  for (const text of fragments) {
    // Per file first, so each file's bullets stay together and blank edges trim away.
    const own = new Map();
    let current = 'Changes';
    for (const line of text.split('\n')) {
      const heading = /^###\s+(.+?)\s*$/.exec(line);
      if (heading) {
        current = heading[1];
        continue;
      }
      if (/^\s*#\s/.test(line)) continue; // a stray title; the nightly has its own
      if (!own.has(current)) own.set(current, []);
      own.get(current).push(line);
    }
    for (const [name, lines] of own) {
      const block = trimBlank(lines).join('\n');
      if (!block) continue;
      if (!sections.has(name)) sections.set(name, []);
      sections.get(name).push(block);
    }
  }
  const order = [...SECTIONS, ...[...sections.keys()].filter((s) => !SECTIONS.includes(s))];
  return order
    .filter((name) => sections.has(name))
    .map((name) => `### ${name}\n\n${sections.get(name).join('\n')}`)
    .join('\n\n');
}

/** The PR titles of a first-parent log (`%s%x1f%b%x1e`), for a night with no note files. */
export function titlesFromLog(log) {
  return log
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, body = ''] = entry.split('\x1f');
      // A merge commit's subject is "Merge pull request #N from owner/branch"; its body is the PR title.
      const pr = /^Merge pull request (#\d+)/.exec(subject);
      return pr ? `${body.trim().split('\n')[0] || subject} (${pr[1]})` : subject.trim();
    })
    .filter((title) => title && !/^Merge (branch|remote-tracking)/.test(title));
}

function trimBlank(lines) {
  let [start, end] = [0, lines.length];
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}
