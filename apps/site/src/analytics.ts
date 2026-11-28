import { buildConfig } from '../../../packages/browser-analytics/build-config';
import { createAnalytics } from '../../../packages/browser-analytics/index';
import { installerPlatform } from './installer-intent';

type Page = 'home' | 'releases' | 'privacy' | 'terms';
type Choice = 'granted' | 'denied';

const analytics = createAnalytics('site', buildConfig('site', {
  PROD: import.meta.env.PROD,
  VITE_HYPERGATE_POSTHOG_KEY: import.meta.env.VITE_HYPERGATE_POSTHOG_KEY,
  VITE_HYPERGATE_POSTHOG_HOST: import.meta.env.VITE_HYPERGATE_POSTHOG_HOST,
}));

export function recordInstallCommandCopy(): void {
  analytics.track('install_command_copied', 'shell');
}

export function initSiteAnalytics(page: Page): void {
  const manage = document.querySelector<HTMLButtonElement>('[data-analytics-settings]');
  if (!manage) return;

  const banner = document.createElement('section');
  banner.className = 'analytics-panel analytics-banner';
  banner.setAttribute('aria-labelledby', 'analytics-banner-title');
  banner.setAttribute('data-lenis-prevent', '');
  banner.hidden = true;
  banner.innerHTML = `
    <div class="cookie-head">
      <svg class="cookie-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <defs><linearGradient id="cookie-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6bff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
        <path d="M24 4a20 20 0 1 0 20 20 6 6 0 0 1-7-6 6 6 0 0 1-6-7 6 6 0 0 1-7-7Z" fill="var(--bg-2)" stroke="url(#cookie-grad)" stroke-width="2.5" stroke-linejoin="round"/>
        <circle cx="16" cy="18" r="2.6" fill="var(--violet)"/><circle cx="27" cy="27" r="2.6" fill="var(--cyan)"/>
        <circle cx="15" cy="31" r="2.2" fill="var(--cyan)"/><circle cx="33" cy="36" r="2" fill="var(--violet)"/><circle cx="23" cy="38" r="1.6" fill="var(--ice)"/>
      </svg>
      <h2 id="analytics-banner-title">Care for a cookie?</h2>
    </div>
    <p>Our cookies are made with only the best ingredients. No spam or data sales risks inside. They only tell us which pages get visited and how people install Hypergate.</p>
    <div class="analytics-actions">
      <button type="button" class="btn btn-ghost" data-deny>No thanks</button>
      <button type="button" class="btn btn-ghost" data-allow>Accept cookies</button>
    </div>
    <a class="analytics-details" href="/privacy/#website-analytics">Privacy details</a>`;
  document.querySelector('main')?.before(banner);
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--analytics-clearance', `${banner.offsetHeight + 32}px`);
  }).observe(banner);

  const settings = document.createElement('dialog');
  settings.id = 'analytics-settings';
  settings.className = 'analytics-panel analytics-dialog';
  settings.setAttribute('aria-labelledby', 'analytics-settings-title');
  settings.setAttribute('aria-describedby', 'analytics-status');
  settings.setAttribute('data-lenis-prevent', '');
  settings.innerHTML = `
    <p class="feat-k">This website only</p>
    <h2 id="analytics-settings-title">Privacy choices</h2>
    <p id="analytics-status" role="status"></p>
    <div class="analytics-actions" data-actions>
      <button type="button" data-deny>Turn analytics off</button>
      <button type="button" data-allow>Allow analytics</button>
    </div>
    <div class="analytics-dialog-footer">
      <a class="analytics-details" href="/privacy/#website-analytics">Privacy details</a>
      <button type="button" class="analytics-close" autofocus>Close</button>
    </div>`;
  document.body.append(settings);

  const status = settings.querySelector<HTMLElement>('#analytics-status')!;
  const actions = settings.querySelector<HTMLElement>('[data-actions]')!;
  const close = settings.querySelector<HTMLButtonElement>('.analytics-close')!;
  let pageRecorded = false;

  function sync() {
    const available = analytics.available();
    const choice = analytics.consent();
    banner.hidden = !available || choice !== 'unset';
    actions.hidden = !available;
    status.textContent = !available
      ? 'Website analytics is unavailable here. No website analytics events are sent, and there’s no setting to change.'
      : choice === 'granted'
        ? 'Website analytics is on. You can turn it off without changing any settings in the app.'
        : choice === 'denied'
          ? 'Website analytics is off. The site works the same either way.'
          : 'Website analytics is off until you allow it. This choice only affects this website.';

    if (available && choice === 'granted' && !pageRecorded) {
      pageRecorded = true;
      analytics.track('page_view', page);
    }
  }

  function choose(choice: Choice, source: HTMLElement) {
    const moveFocus = source === banner && banner.contains(document.activeElement);
    analytics.setConsent(choice);
    sync();
    if (source === settings) {
      settings.close();
    } else if (banner.hidden && moveFocus) {
      const main = document.querySelector('main');
      main?.setAttribute('tabindex', '-1');
      main?.focus({ preventScroll: true });
    }
  }

  for (const control of [banner, settings]) {
    control.querySelector('[data-allow]')?.addEventListener('click', () => choose('granted', control));
    control.querySelector('[data-deny]')?.addEventListener('click', () => choose('denied', control));
  }
  manage.setAttribute('aria-controls', settings.id);
  manage.addEventListener('click', () => {
    sync();
    settings.showModal();
  });
  close.addEventListener('click', () => settings.close());
  manage.hidden = false;
  window.addEventListener('storage', sync);
  window.addEventListener('pageshow', sync);
  sync();

  if (!analytics.available()) return;
  const recordDownload = (event: MouseEvent) => {
    if (!event.isTrusted || event.defaultPrevented || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a:is([data-download-primary], [data-linux-format], [data-release-installer])[href]');
    if (!link || link.closest('[hidden], [inert]') || link.getAttribute('aria-disabled') === 'true' || !link.getClientRects().length) return;
    const platform = installerPlatform(link.href);
    if (platform) analytics.track('download_clicked', platform);
  };
  document.addEventListener('click', (event) => { if (event.button === 0) recordDownload(event); });
  document.addEventListener('auxclick', (event) => { if (event.button === 1) recordDownload(event); });
}
