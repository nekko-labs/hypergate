import { useCallback, useState } from 'react';
import { useToast } from '../toast';

/**
 * Copy-to-clipboard with two layers of feedback: the returned `copied` key
 * drives the inline "Copied!" button label, and a shared toast confirms it
 * globally (so feedback isn't lost if the button scrolls out of view).
 */
export function useCopy(): [string | null, (key: string, text: string, label?: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const toast = useToast();
  const copy = useCallback(
    (key: string, text: string, label?: string) => {
      void navigator.clipboard.writeText(text).then(
        () => toast.show(`${label ?? 'Copied'} to clipboard`, 'success'),
        () => toast.show('Could not copy to clipboard', 'error'),
      );
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    },
    [toast],
  );
  return [copied, copy];
}
