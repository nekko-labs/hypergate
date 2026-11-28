// Client-side project token (write-only ingestion), not a personal API key.
// Defaults apply only to the published website and production manager bundle.
const release = {
  key: 'phc_nELtrzYeLNTZrFKGaX2JgsE8252dKi9YsFpw2te4AGNm',
  host: 'https://us.i.posthog.com',
};

export function buildConfig(surface: 'site' | 'manager', env: { PROD: boolean; VITE_HYPERGATE_POSTHOG_KEY?: string; VITE_HYPERGATE_POSTHOG_HOST?: string }) {
  if (env.VITE_HYPERGATE_POSTHOG_KEY !== undefined || env.VITE_HYPERGATE_POSTHOG_HOST !== undefined) {
    return {key: env.VITE_HYPERGATE_POSTHOG_KEY, host: env.VITE_HYPERGATE_POSTHOG_HOST};
  }
  return env.PROD && (surface === 'manager' || location.origin === 'https://hypergate.app') ? release : {};
}
