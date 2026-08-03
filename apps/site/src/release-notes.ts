import { fetchReleases, hydrateDownloadCtas, type GithubRelease } from './downloads';

void hydrateDownloadCtas();

const nav = document.getElementById('nav');
const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 24);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

const canvas = document.getElementById('stars') as HTMLCanvasElement;
const context = canvas.getContext('2d');

function drawStars() {
  if (!context) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, innerWidth, innerHeight);
  context.fillStyle = '#cdd8ff';
  const count = Math.floor((innerWidth * innerHeight) / 9000);
  for (let i = 0; i < count; i += 1) {
    const x = (Math.sin(i * 91.37) * 0.5 + 0.5) * innerWidth;
    const y = (Math.sin(i * 47.11 + 1.8) * 0.5 + 0.5) * innerHeight;
    context.globalAlpha = 0.18 + (i % 5) * 0.08;
    context.beginPath();
    context.arc(x, y, 0.4 + (i % 3) * 0.3, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

window.addEventListener('resize', drawStars, { passive: true });
drawStars();

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value));
}

function installerAssets(release: GithubRelease) {
  const version = release.tag_name.replace(/^v/, '');
  return release.assets.filter((asset) =>
    asset.name.includes(version) && /-setup\.exe$|\.pkg$|\.deb$|\.rpm$|\.tar\.gz$/i.test(asset.name),
  );
}

function appendInline(parent: HTMLElement, text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\))/g);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      parent.append(code);
      continue;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      parent.append(strong);
      continue;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (linkMatch) {
      const link = document.createElement('a');
      link.href = linkMatch[2];
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = linkMatch[1];
      parent.append(link);
      continue;
    }
    parent.append(document.createTextNode(part));
  }
}

function releaseBody(text: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'release-body';
  // A body edited in GitHub's web UI comes back with CRLF line endings.
  for (const block of text.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    // `### Features` and friends. Everything lands on h3: the release title is
    // the h2 above, so a note's own heading level should not compete with it.
    const heading = lines.length === 1 ? lines[0].match(/^#{1,3}\s+(.+)$/) : null;
    if (heading) {
      const element = document.createElement('h3');
      appendInline(element, heading[1]);
      body.append(element);
      continue;
    }
    if (/^[-*] /.test(lines[0])) {
      const list = document.createElement('ul');
      // A bullet wrapped across lines is one item, not one item per line.
      for (const line of lines) {
        if (/^[-*] /.test(line)) {
          const item = document.createElement('li');
          appendInline(item, line.slice(2));
          list.append(item);
          continue;
        }
        appendInline(list.lastElementChild as HTMLElement, ` ${line.trim()}`);
      }
      body.append(list);
      continue;
    }
    const paragraph = document.createElement('p');
    appendInline(paragraph, lines.join(' '));
    body.append(paragraph);
  }
  return body;
}

function releaseEntry(release: GithubRelease): HTMLElement {
  const article = document.createElement('article');
  article.className = 'release-entry';

  const meta = document.createElement('div');
  meta.className = 'release-meta';
  const version = document.createElement('span');
  version.className = 'release-version';
  version.textContent = release.tag_name;
  const date = document.createElement('time');
  date.className = 'release-date';
  date.dateTime = release.published_at;
  date.textContent = formatDate(release.published_at);
  meta.append(version, date);
  if (release.prerelease) {
    const prerelease = document.createElement('span');
    prerelease.className = 'release-version';
    prerelease.textContent = 'Prerelease';
    meta.append(prerelease);
  }

  const content = document.createElement('div');
  content.className = 'release-content';
  const heading = document.createElement('h2');
  heading.textContent = release.name || release.tag_name;
  const body = releaseBody(release.body || 'Installer and binary updates for this release.');
  const actions = document.createElement('div');
  actions.className = 'release-actions';
  const github = document.createElement('a');
  github.href = release.html_url;
  github.target = '_blank';
  github.rel = 'noopener';
  github.textContent = 'Full release on GitHub ↗';
  actions.append(github);

  const assets = installerAssets(release);
  if (assets.length) {
    const assetList = document.createElement('div');
    assetList.className = 'release-assets';
    for (const asset of assets) {
      const link = document.createElement('a');
      link.href = asset.browser_download_url;
      link.textContent = asset.name
        .replace(`hypergate-${release.tag_name.replace(/^v/, '')}-`, '')
        .replace(`hypergate_${release.tag_name.replace(/^v/, '')}_`, '');
      assetList.append(link);
    }
    actions.append(assetList);
  }

  content.append(heading, body, actions);
  article.append(meta, content);
  return article;
}

const list = document.getElementById('release-list');
if (list) {
  void fetchReleases()
    .then((releases) => {
      list.replaceChildren();
      if (!releases.length) {
        list.textContent = 'No published releases yet.';
        list.className = 'release-list release-state';
        return;
      }
      list.append(...releases.map(releaseEntry));
    })
    .catch(() => {
      list.className = 'release-list release-state';
      list.replaceChildren();
      const message = document.createElement('p');
      message.textContent = 'Release notes could not be loaded right now.';
      const link = document.createElement('a');
      link.href = 'https://github.com/nekko-labs/hypergate/releases';
      link.textContent = 'View releases on GitHub ↗';
      list.append(message, link);
    });
}
