import { useState } from 'react';
import type { Theme } from '../types';

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') as Theme) || 'medium');
  const set = (t: Theme) => {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('hypergate-theme', t); } catch { /* ignore */ }
  };
  const opts: [Theme, string, string][] = [['light', '☀', 'Light'], ['medium', '◐', 'Medium'], ['dark', '☾', 'Dark']];
  return (
    <div className="themeswitch" role="group" aria-label="Theme">
      {opts.map(([t, icon, label]) => (
        <button key={t} className={theme === t ? 'active' : ''} title={label} aria-label={label} onClick={() => set(t)}>{icon}</button>
      ))}
    </div>
  );
}
