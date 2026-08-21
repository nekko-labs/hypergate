export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

export type GithubRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
};

export type Platform = 'windows' | 'macos' | 'linux' | 'mobile' | 'unknown';
export type Architecture = 'x64' | 'arm64';
type LinuxFormat = 'deb' | 'rpm' | 'tar.gz';

export type Device = {
  platform: Platform;
  architecture: Architecture;
};

export type InstallCommand = {
  shell: string;
  command: string;
};

const API = 'https://api.github.com/repos/nekko-labs/hypergate/releases';
const LATEST_ASSET = 'https://github.com/nekko-labs/hypergate/releases/latest/download';
export const RELEASES_URL = 'https://github.com/nekko-labs/hypergate/releases/latest';

function normalizeArchitecture(value: string): Architecture {
  return /arm|aarch64/i.test(value) ? 'arm64' : 'x64';
}

function isMobileBrowser(): boolean {
  const uaData = (navigator as Navigator & { userAgentData?: { mobile: boolean } }).userAgentData;
  return !!uaData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function detectDevice(): Promise<Device> {
  const ua = navigator.userAgent;
  const uaData = (navigator as Navigator & {
    userAgentData?: {
      mobile: boolean;
      platform: string;
      getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
    };
  }).userAgentData;

  if (isMobileBrowser()) return { platform: 'mobile', architecture: 'arm64' };

  const platformText = `${uaData?.platform ?? ''} ${navigator.platform} ${ua}`;
  const platform: Platform = /Windows/i.test(platformText)
    ? 'windows'
    : /Mac/i.test(platformText)
      ? 'macos'
      : /Linux|X11/i.test(platformText)
        ? 'linux'
        : 'unknown';

  let architecture = normalizeArchitecture(ua);
  if (uaData?.getHighEntropyValues) {
    try {
      const values = await uaData.getHighEntropyValues(['architecture']);
      if (values.architecture) architecture = normalizeArchitecture(values.architecture);
    } catch {
      architecture = normalizeArchitecture(ua);
    }
  } else if (platform === 'macos') {
    architecture = 'arm64';
  }

  return { platform, architecture };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function fetchLatestRelease(): Promise<GithubRelease> {
  return fetchJson<GithubRelease>(`${API}/latest`);
}

export async function fetchReleases(): Promise<GithubRelease[]> {
  const releases = await fetchJson<GithubRelease[]>(`${API}?per_page=30`);
  return releases.filter((release) => !release.draft);
}

function architectureTerms(architecture: Architecture): string[] {
  return architecture === 'arm64' ? ['arm64', 'aarch64'] : ['x64', 'amd64', 'x86_64'];
}

export function findInstaller(
  release: GithubRelease,
  device: Device,
  linuxFormat: LinuxFormat = 'deb',
): ReleaseAsset | undefined {
  if (device.platform === 'macos') {
    // The stable alias is the asset that says Apple silicon, so it is the name
    // a visitor sees in their downloads folder; the versioned disk image (still
    // arm64, because the in-app updater asks for that exact file) is the
    // fallback for releases published before the alias existed.
    if (device.architecture !== 'arm64') return undefined;
    return release.assets.find((asset) => asset.name === 'hypergate-macos-apple-silicon.dmg')
      ?? release.assets.find((asset) => asset.name.toLowerCase().endsWith('-macos-arm64.dmg'));
  }
  const terms = architectureTerms(device.architecture);
  return release.assets.find((asset) => {
    const name = asset.name.toLowerCase();
    if (!terms.some((term) => name.includes(term))) return false;
    if (device.platform === 'windows') return name.endsWith('-setup.exe');
    if (device.platform === 'linux') return linuxFormat === 'tar.gz' ? name.endsWith('.tar.gz') : name.endsWith(`.${linuxFormat}`);
    return false;
  });
}

function platformName(platform: Platform): string {
  if (platform === 'windows') return 'Windows';
  if (platform === 'macos') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return 'your computer';
}

/**
 * Hypergate on macOS is Apple silicon only, and an Intel Mac cannot run the
 * arm64 build at all (Rosetta translates the other way), so those visitors are
 * told that rather than handed a disk image that will not open.
 */
function unsupportedMac(device: Device): boolean {
  return device.platform === 'macos' && device.architecture !== 'arm64';
}

export function installerUrlFor(device: Device): string | null {
  const arch = device.architecture;
  if (unsupportedMac(device)) return null;
  if (device.platform === 'windows') return `${LATEST_ASSET}/hypergate-windows-${arch}-setup.exe`;
  if (device.platform === 'macos') return `${LATEST_ASSET}/hypergate-macos-apple-silicon.dmg`;
  if (device.platform === 'linux') return `${LATEST_ASSET}/hypergate-linux-${arch}.deb`;
  return null;
}

export function installCommandFor(device: Device): InstallCommand | null {
  const arch = device.architecture;
  if (unsupportedMac(device)) return null;
  if (device.platform === 'windows') {
    const asset = `${LATEST_ASSET}/hypergate-windows-${arch}-setup.exe`;
    return {
      shell: 'PowerShell',
      command: `$i="$env:TEMP\\hypergate-setup.exe"; irm "${asset}" -OutFile $i; Start-Process $i -ArgumentList "/S" -Wait; & "$env:LOCALAPPDATA\\Programs\\Hypergate\\hypergate.exe" app`,
    };
  }
  if (device.platform === 'macos') {
    const asset = `${LATEST_ASSET}/hypergate-macos-apple-silicon.dmg`;
    return {
      shell: 'Terminal',
      command: `curl -fsSL "${asset}" -o /tmp/hypergate.dmg && open /tmp/hypergate.dmg`,
    };
  }
  if (device.platform === 'linux') {
    const asset = `${LATEST_ASSET}/hypergate-linux-${arch}.deb`;
    return {
      shell: 'Bash · Debian / Ubuntu',
      command: `curl -fsSL "${asset}" -o /tmp/hypergate.deb && sudo apt-get install -y /tmp/hypergate.deb && hypergate app`,
    };
  }
  return null;
}

function hydrateInstallCommand(device: Device): void {
  const install = installCommandFor(device);
  for (const block of document.querySelectorAll<HTMLElement>('[data-install-command]')) {
    if (!install) {
      block.hidden = true;
      continue;
    }
    const shell = block.querySelector<HTMLElement>('[data-install-shell]');
    const command = block.querySelector<HTMLElement>('[data-install-command-text]');
    const copy = block.querySelector<HTMLButtonElement>('[data-copy-install]');
    if (shell) shell.textContent = install.shell;
    if (command) command.textContent = install.command;
    if (copy) {
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(install.command);
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
    }
  }
}

/** The label on the primary button, once we know what this device can run. */
function downloadLabel(device: Device, hasDownload: boolean): string {
  if (unsupportedMac(device)) return 'Needs an Apple silicon Mac';
  if (!hasDownload) return 'View latest downloads';
  // "Apple silicon" is said out loud, because a Mac owner knows that phrase from
  // their own About This Mac window and may not know it means arm64.
  if (device.platform === 'macos') return 'Download for Mac (Apple silicon)';
  return `Download for ${platformName(device.platform)}`;
}

export async function hydrateDownloadCtas(): Promise<void> {
  const groups = [...document.querySelectorAll<HTMLElement>('[data-download-group]')];
  if (!groups.length) return;
  if (isMobileBrowser()) document.documentElement.dataset.downloadPlatform = 'mobile';

  const device = await detectDevice();
  hydrateInstallCommand(device);
  if (device.platform === 'mobile') {
    for (const group of groups) group.hidden = true;
    return;
  }

  const fallbackUrl = installerUrlFor(device);
  for (const group of groups) {
    const link = group.querySelector<HTMLAnchorElement>('[data-download-primary]');
    const label = group.querySelector<HTMLElement>('[data-download-label]');
    if (link) link.href = fallbackUrl ?? RELEASES_URL;
    if (label) label.textContent = downloadLabel(device, !!fallbackUrl);
  }

  try {
    const release = await fetchLatestRelease();
    const asset = findInstaller(release, device);
    for (const group of groups) {
      const link = group.querySelector<HTMLAnchorElement>('[data-download-primary]');
      const label = group.querySelector<HTMLElement>('[data-download-label]');
      const version = group.querySelector<HTMLElement>('[data-download-version]');
      if (link) link.href = asset?.browser_download_url ?? fallbackUrl ?? release.html_url;
      if (label) label.textContent = downloadLabel(device, !!(asset || fallbackUrl));
      // A version number beside "Needs an Apple silicon Mac" would read as an
      // offer, so the chip stays empty when there is nothing to download.
      if (version) version.textContent = unsupportedMac(device) ? '' : release.tag_name;
    }

    if (device.platform === 'linux') {
      for (const picker of document.querySelectorAll<HTMLElement>('[data-linux-picker]')) {
        picker.hidden = false;
        for (const link of picker.querySelectorAll<HTMLAnchorElement>('[data-linux-format]')) {
          const format = link.dataset.linuxFormat as LinuxFormat;
          const alternate = findInstaller(release, device, format);
          if (alternate) {
            link.href = alternate.browser_download_url;
            link.removeAttribute('aria-disabled');
          } else {
            link.removeAttribute('href');
            link.setAttribute('aria-disabled', 'true');
          }
        }
      }
    }
  } catch {
    for (const group of groups) {
      const link = group.querySelector<HTMLAnchorElement>('[data-download-primary]');
      const label = group.querySelector<HTMLElement>('[data-download-label]');
      const version = group.querySelector<HTMLElement>('[data-download-version]');
      if (!fallbackUrl && link) link.href = RELEASES_URL;
      if (!fallbackUrl && label) label.textContent = downloadLabel(device, false);
      if (version) version.textContent = '';
    }
  }
}
