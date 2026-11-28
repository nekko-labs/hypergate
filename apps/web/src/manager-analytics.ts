import { buildConfig } from '../../../packages/browser-analytics/build-config';
import { useEffect, useRef, useState } from 'react';
import { createAnalytics } from '../../../packages/browser-analytics/index';
import { inShell } from './lib/shell';

export const MANAGER_VIEWS = ['servers', 'people', 'analytics', 'settings'] as const;
export type ManagerView = typeof MANAGER_VIEWS[number];

type ManagerFeature = 'server_added' | 'server_started' | 'server_stopped' | 'server_restarted' | 'agent_connected';

// The same URL is also served to browsers and embedded in Nekko Agent's Electron
// guest, which looks like a top-level page. Require the native Hypergate shell
// marker instead of guessing from the URL, frame ancestry, or user agent alone.
const analytics = inShell && window.top === window
  ? createAnalytics('manager', buildConfig('manager', {
    PROD: import.meta.env.PROD,
    VITE_HYPERGATE_POSTHOG_KEY: import.meta.env.VITE_HYPERGATE_POSTHOG_KEY,
    VITE_HYPERGATE_POSTHOG_HOST: import.meta.env.VITE_HYPERGATE_POSTHOG_HOST,
  }))
  : null;

export function trackManagerFeature(feature: ManagerFeature): void {
  if (readChoice().enabled) analytics?.track('feature_used', feature);
}

function privacySignal(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  const win = window as Window & { doNotTrack?: string };
  return nav.globalPrivacyControl === true || [nav.doNotTrack, nav.msDoNotTrack, win.doNotTrack]
    .some((value) => value === '1' || value === 'yes');
}

function readChoice() {
  const blocked = privacySignal();
  const available = analytics?.available() ?? false;
  return { enabled: available && !blocked && analytics?.consent() === 'granted', blocked, available };
}

export function useManagerUsageReports(view: ManagerView) {
  const [choice, setChoice] = useState(readChoice);
  const opened = useRef(false);
  const lastView = useRef<ManagerView | null>(null);

  useEffect(() => {
    if (!analytics) return;
    const sync = () => setChoice(readChoice());
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  useEffect(() => {
    if (!analytics || !choice.enabled || !readChoice().enabled) {
      lastView.current = null;
      return;
    }
    if (!opened.current) {
      analytics.track('manager_opened', 'manager');
      opened.current = true;
    }
    if (lastView.current !== view) {
      analytics.track('view_opened', view);
      lastView.current = view;
    }
  }, [choice.enabled, view]);

  if (!analytics) return null;
  return {
    ...choice,
    setEnabled(enabled: boolean) {
      analytics.setConsent(enabled ? 'granted' : 'denied');
      setChoice(readChoice());
    },
  };
}
