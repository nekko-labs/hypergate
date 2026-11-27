const repo = 'https://github.com/nekko-labs/hypergate';
const loginPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const tagPattern = /^v\d+\.\d+\.\d+$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text) => text.replace(/[&<>"']/g, (ch) => escapes[ch]);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function uniqueLogins(values) {
  return Array.isArray(values) && values.length > 0
    && values.every((login) => typeof login === 'string' && login.length <= 39 && loginPattern.test(login))
    && new Set(values.map((login) => login.toLowerCase())).size === values.length;
}

function validate(releases) {
  if (!Array.isArray(releases) || !releases.length) throw new Error('Add at least one release highlight.');
  const tags = new Set();
  let previousDate = '';
  for (const release of releases) {
    const { tag, date, title, contributors, features, changes = [] } = release;
    const fail = (message) => { throw new Error(`Release highlights (${tag}): ${message}`); };
    if (typeof tag !== 'string' || !tagPattern.test(tag) || tags.has(tag)) fail('expected a unique stable release tag');
    if (typeof date !== 'string' || !dayPattern.test(date) || Number.isNaN(Date.parse(date))
      || new Date(date).toISOString().slice(0, 10) !== date || (previousDate && date > previousDate)) {
      fail('expected a valid UTC publication date, newest first');
    }
    if (!isText(title) || !uniqueLogins(contributors)) fail('expected a title and unique contributor logins');
    if (!Array.isArray(features) || !features.length || !Array.isArray(changes)) fail('expected at least one headliner and optional additional changes');
    const logins = new Set(contributors.map((login) => login.toLowerCase()));
    for (const item of [...features, ...changes]) {
      if (!isText(item?.title) || !Number.isSafeInteger(item.pr) || item.pr <= 0
        || !uniqueLogins(item.authors) || item.authors.some((login) => !logins.has(login.toLowerCase()))) {
        fail('each change needs a title, PR number, and credited authors in contributors');
      }
    }
    if (!features.every((item) => isText(item.detail))) fail('each headliner needs a description');
    tags.add(tag);
    previousDate = date;
  }
}

function profile(login, avatar = false) {
  return `<a class="release-profile" href="https://github.com/${login}">${avatar ? `<span aria-hidden="true">${login.slice(0, 2).toUpperCase()}</span>` : ''}@${login}</a>`;
}

function credit({ pr, authors }) {
  return `<p class="release-credit"><span>By</span> ${authors.map((login) => profile(login)).join(', ')} <a class="release-pr" href="${repo}/pull/${pr}" aria-label="Pull request ${pr}">#${pr} ↗</a></p>`;
}

function section({ tag, date, title, contributors, features, changes = [] }, index) {
  return `<article class="highlight-release" id="${tag}" aria-labelledby="title-${tag}">
          <div class="highlight-meta"><span class="release-version">${tag}</span><time datetime="${date}">${dateFormat.format(new Date(date))}</time>${index === 0 ? '<span class="highlight-recent">Newest highlight</span>' : ''}</div>
          <h2 id="title-${tag}">${escape(title)}</h2>
          <div class="release-people"><span>Contributors</span> ${contributors.map((login) => profile(login, true)).join(' ')}</div>
          <div class="release-headliners">
            <p class="release-label"><img src="/favicon.svg" width="25" height="25" alt=""> Headliners</p>
            <ul>${features.map((item) => `<li><h3>${escape(item.title)}</h3><p>${escape(item.detail)}</p>${credit(item)}</li>`).join('')}</ul>
          </div>
          ${changes.length ? `<div class="release-changes"><h3 class="release-label">Also in ${tag}</h3><ul>${changes.map((item) => `<li><span>${escape(item.title)}</span>${credit(item)}</li>`).join('')}</ul></div>` : ''}
          <a class="release-full" href="${repo}/releases/tag/${tag}">Full notes for ${tag} on GitHub ↗</a>
        </article>`;
}

export function renderReleaseHighlights(html, releases) {
  validate(releases);
  const index = `<ul>${releases.map(({ tag, date }) => `<li><a href="#${tag}">${tag}<span>${monthFormat.format(new Date(date))}</span></a></li>`).join('')}</ul>`;
  return html
    .replace('<!-- release-index -->', () => index)
    .replace('<!-- release-highlights -->', () => releases.map(section).join('\n        '));
}
