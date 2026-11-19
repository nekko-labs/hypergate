import { describe, expect, it } from 'vitest';
import {
  AMBIENT_RULES,
  ambientFingerprint,
  ambientPaths,
  classifyEnvVar,
  isLiteralSecret,
  removeAmbient,
  scanAmbient,
  toFinding,
  type AmbientContext,
  type AmbientHit,
} from './ambient.js';

const HOME = '/home/u';
const ctxWith = (files: Record<string, string>, env: Record<string, string> = {}, platform = 'linux'): AmbientContext => ({
  home: HOME,
  platform,
  env,
  readFile: (p) => files[p],
});
const byRule = (hits: AmbientHit[], rule: string): AmbientHit[] => hits.filter((h) => h.rule === rule);

const GH_TOKEN = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';
const OPENAI = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

describe('isLiteralSecret', () => {
  it('accepts real-looking values and rejects references and placeholders', () => {
    expect(isLiteralSecret(OPENAI)).toBe(true);
    for (const v of ['$(op read op://x/y)', '${NPM_TOKEN}', '$OPENAI', 'short', 'your-key-here', 'changeme', '<token>', 'xxxxxxxx', 'op://vault/item'])
      expect(isLiteralSecret(v)).toBe(false);
    expect(isLiteralSecret(undefined)).toBe(false);
  });
});

describe('classifyEnvVar', () => {
  it('maps catalog env vars and aliases to their service', () => {
    expect(classifyEnvVar('OPENROUTER_API_KEY')?.service).toBe('openrouter');
    expect(classifyEnvVar('GOOGLE_API_KEY')).toEqual({ service: 'gemini', envVar: 'GEMINI_API_KEY' });
    expect(classifyEnvVar('GITHUB_TOKEN')?.service).toBe('github');
  });
  it('keeps unknown but secret-shaped names, and ignores ordinary variables', () => {
    expect(classifyEnvVar('ACME_API_KEY')).toEqual({ envVar: 'ACME_API_KEY' });
    for (const n of ['PATH', 'SSH_AUTH_SOCK', 'KEYBOARD_LAYOUT', 'EDITOR']) expect(classifyEnvVar(n)).toBeUndefined();
  });
});

describe('gh hosts.yml', () => {
  it('reports a keyring login without reading a value, and a plain-text one with a masked hint', () => {
    const hits = scanAmbient(
      ctxWith({
        [`${HOME}/.config/gh/hosts.yml`]: [
          'github.com:',
          '    git_protocol: https',
          '    users:',
          '        octo:',
          '    user: octo',
          'ghe.example.com:',
          `    oauth_token: ${GH_TOKEN}`,
          '    user: me',
        ].join('\n'),
      }),
    );
    const gh = byRule(hits, 'gh-hosts');
    expect(gh).toHaveLength(2);
    const [dotcom, ghe] = gh;
    expect(dotcom.storage).toBe('keyring');
    expect(dotcom.value).toBeUndefined();
    expect(dotcom.valueCommand).toEqual({ file: 'gh', args: ['auth', 'token', '--hostname', 'github.com'] });
    expect(dotcom.service).toBe('github');
    expect(dotcom.importable).toBe(true);
    expect(dotcom.logout?.args).toEqual(['auth', 'logout', '--hostname', 'github.com', '--user', 'octo']);
    expect(ghe.storage).toBe('plaintext');
    expect(ghe.value).toBe(GH_TOKEN);
    expect(ghe.hint).not.toContain(GH_TOKEN.slice(5, 30));
  });

  it('honours GH_CONFIG_DIR', () => {
    const hits = scanAmbient(ctxWith({ '/cfg/hosts.yml': 'github.com:\n    user: a\n' }, { GH_CONFIG_DIR: '/cfg' }));
    expect(byRule(hits, 'gh-hosts')[0].location).toBe('/cfg/hosts.yml');
  });
});

describe('file-based CLIs', () => {
  it('fly config.yml access_token, removable by commenting the line', () => {
    const file = `${HOME}/.fly/config.yml`;
    const text = 'access_token: FlyV1 fm2_abcdefghijklmnop\nlast_login: x\n';
    const [h] = byRule(scanAmbient(ctxWith({ [file]: text })), 'fly-config');
    expect(h.service).toBe('fly');
    expect(h.value).toBe('FlyV1 fm2_abcdefghijklmnop');
    const out = removeAmbient(text, h, '2026-11-19')!;
    expect(out).not.toContain('fm2_abcdefghijklmnop');
    expect(out).toContain('# hypergate: ');
    expect(out).toContain('last_login: x');
  });

  it('aws credentials are reported per profile but never importable', () => {
    const file = `${HOME}/.aws/credentials`;
    const hits = byRule(
      scanAmbient(
        ctxWith({
          [file]: '[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n\n[sso]\nsso_session = x\n',
        }),
      ),
      'aws-credentials',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].importable).toBe(false);
    expect(hits[0].removal).toBe('manual');
  });

  it('npmrc auth tokens: npmjs maps to the npm guide, references are skipped', () => {
    const file = `${HOME}/.npmrc`;
    const text = '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz\n//npm.pkg.github.com/:_authToken=${GH}\n';
    const hits = byRule(scanAmbient(ctxWith({ [file]: text })), 'npmrc');
    expect(hits).toHaveLength(1);
    expect(hits[0].service).toBe('npm');
    const out = removeAmbient(text, hits[0], '2026-11-19')!;
    expect(out.split('\n')[0].startsWith('; hypergate:')).toBe(true);
    expect(out).toContain('${GH}');
  });

  it('vercel auth.json token is deleted from the JSON', () => {
    const file = `${HOME}/.local/share/com.vercel.cli/auth.json`;
    const text = JSON.stringify({ '// Note': 'x', token: 'vercel_tok_abcdefghijklmnop' });
    const [h] = byRule(scanAmbient(ctxWith({ [file]: text })), 'vercel-auth');
    expect(h.service).toBe('vercel');
    expect(JSON.parse(removeAmbient(text, h, 'd')!)).toEqual({ '// Note': 'x' });
  });

  it('vercel on macOS reads Application Support', () => {
    const file = `${HOME}/Library/Application Support/com.vercel.cli/auth.json`;
    const hits = scanAmbient(ctxWith({ [file]: '{"token":"vercel_tok_abcdefghijklmnop"}' }, {}, 'darwin'));
    expect(byRule(hits, 'vercel-auth')).toHaveLength(1);
  });

  it('supabase access-token fallback file is a delete-file removal', () => {
    const [h] = byRule(scanAmbient(ctxWith({ [`${HOME}/.supabase/access-token`]: 'sbp_0123456789abcdef0123\n' })), 'supabase-token');
    expect(h.removal).toBe('delete-file');
    expect(h.value).toBe('sbp_0123456789abcdef0123');
  });

  it('docker auths are detect-only, credsStore-only configs report nothing', () => {
    const file = `${HOME}/.docker/config.json`;
    expect(byRule(scanAmbient(ctxWith({ [file]: '{"credsStore":"desktop","auths":{"https://index.docker.io/v1/":{}}}' })), 'docker-config')).toHaveLength(0);
    const hits = byRule(scanAmbient(ctxWith({ [file]: '{"auths":{"ghcr.io":{"auth":"dXNlcjpwYXNzd29yZDEyMw=="}}}' })), 'docker-config');
    expect(hits[0].importable).toBe(false);
  });

  it('git-credentials: github.com imports and is dropped (no comments allowed), others are manual', () => {
    const file = `${HOME}/.git-credentials`;
    const text = `https://octo:${GH_TOKEN}@github.com\nhttps://me:hunter2hunter2@gitlab.example.com\n`;
    const hits = byRule(scanAmbient(ctxWith({ [file]: text })), 'git-credentials');
    expect(hits.map((h) => h.importable)).toEqual([true, false]);
    const out = removeAmbient(text, hits[0], 'd')!;
    expect(out).toBe('https://me:hunter2hunter2@gitlab.example.com\n');
  });

  it('netrc passwords are reported per machine', () => {
    const hits = byRule(
      scanAmbient(ctxWith({ [`${HOME}/.netrc`]: 'machine api.heroku.com\n  login me\n  password abcdef0123456789\n' })),
      'netrc',
    );
    expect(hits[0].detail).toBe('api.heroku.com');
  });

  it('gcloud ADC and Azure MSAL caches are reported, not imported', () => {
    const hits = scanAmbient(
      ctxWith({
        [`${HOME}/.config/gcloud/application_default_credentials.json`]: '{"type":"authorized_user","refresh_token":"x"}',
        [`${HOME}/.azure/msal_token_cache.json`]: '{"AccessToken":{"a":{}}}',
      }),
    );
    expect(byRule(hits, 'gcloud-adc')[0].importable).toBe(false);
    expect(byRule(hits, 'azure-msal')[0].importable).toBe(false);
  });
});

describe('model providers', () => {
  it('Codex auth.json: the API key imports and is nulled; a ChatGPT sign-in is reported only', () => {
    const file = `${HOME}/.codex/auth.json`;
    const text = JSON.stringify({ OPENAI_API_KEY: OPENAI, tokens: { id_token: 'x' }, last_refresh: 'y' });
    const hits = byRule(scanAmbient(ctxWith({ [file]: text })), 'codex-auth');
    expect(hits.map((h) => [h.detail, h.importable])).toEqual([
      ['API key', true],
      ['ChatGPT sign-in', false],
    ]);
    expect(hits[0].service).toBe('openai');
    expect(JSON.parse(removeAmbient(text, hits[0], 'd')!).OPENAI_API_KEY).toBeNull();
  });

  it('shell rc files across bash, zsh, fish and PowerShell syntax', () => {
    const hits = scanAmbient(
      ctxWith({
        [`${HOME}/.zshrc`]: [
          `export OPENAI_API_KEY="${OPENAI}"`,
          'export OPENROUTER_API_KEY=$(op read op://x/y)',
          'export PATH=/usr/bin:$PATH',
          '# export ANTHROPIC_API_KEY=sk-ant-commentedoutvalue1234',
          'GEMINI_API_KEY=AIzaSyA0123456789abcdefghij # personal',
        ].join('\n'),
        [`${HOME}/.config/fish/config.fish`]: 'set -gx OPENROUTER_API_KEY sk-or-v1-0123456789abcdef',
        [`${HOME}/.config/powershell/Microsoft.PowerShell_profile.ps1`]: '$env:ANTHROPIC_API_KEY = "sk-ant-api03-0123456789abcdef"',
      }),
    );
    const rc = byRule(hits, 'shell-rc');
    expect(rc.map((h) => h.envVar).sort()).toEqual(['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']);
    const gemini = rc.find((h) => h.envVar === 'GEMINI_API_KEY')!;
    expect(gemini.value).toBe('AIzaSyA0123456789abcdefghij');
    expect(gemini.service).toBe('gemini');
  });

  it('removing an rc line keeps the rest of the file and never writes the value', () => {
    const file = `${HOME}/.bashrc`;
    const text = `alias ll='ls -l'\n  export OPENAI_API_KEY=${OPENAI}\necho hi\n`;
    const [h] = byRule(scanAmbient(ctxWith({ [file]: text })), 'shell-rc');
    const out = removeAmbient(text, h, '2026-11-19')!;
    expect(out).toBe(`alias ll='ls -l'\n  # hypergate: OPENAI_API_KEY moved to the Hypergate vault on 2026-11-19\necho hi\n`);
  });

  it('refuses to edit when the line changed since the scan', () => {
    const file = `${HOME}/.bashrc`;
    const text = `export OPENAI_API_KEY=${OPENAI}\n`;
    const [h] = byRule(scanAmbient(ctxWith({ [file]: text })), 'shell-rc');
    expect(removeAmbient('export OPENAI_API_KEY=sk-different-value-123456\n', h, 'd')).toBeUndefined();
  });

  it('Gemini CLI ~/.gemini/.env and aider config', () => {
    const hits = scanAmbient(
      ctxWith({
        [`${HOME}/.gemini/.env`]: 'GEMINI_API_KEY=AIzaSyA0123456789abcdefghij\n',
        [`${HOME}/.aider.conf.yml`]: [
          `openai-api-key: ${OPENAI}`,
          'api-key:',
          '  - gemini=AIzaSyB0123456789abcdefghij',
          '  - openrouter=sk-or-v1-0123456789abcdef',
          'model: x',
        ].join('\n'),
      }),
    );
    expect(byRule(hits, 'gemini-env')[0].service).toBe('gemini');
    expect(byRule(hits, 'aider-conf').map((h) => [h.envVar, h.service])).toEqual([
      ['OPENAI_API_KEY', 'openai'],
      ['GEMINI_API_KEY', 'gemini'],
      ['OPENROUTER_API_KEY', 'openrouter'],
    ]);
  });

  it('the daemon environment reports catalog keys only, as manual removals', () => {
    const hits = byRule(
      scanAmbient(ctxWith({}, { OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef', ACME_TOKEN: 'abcdefghijkl', HOME: HOME })),
      'daemon-env',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].removal).toBe('manual');
    expect(hits[0].location).toBe('environment');
  });
});

describe('the API shape', () => {
  it('toFinding strips the value and every command a caller could misuse', () => {
    const [h] = scanAmbient(ctxWith({ [`${HOME}/.zshrc`]: `export OPENAI_API_KEY=${OPENAI}` }));
    const f = toFinding(h);
    expect(JSON.stringify(f)).not.toContain(OPENAI);
    expect(f).not.toHaveProperty('value');
    expect(f).not.toHaveProperty('edit');
  });

  it('ids are stable across scans and differ by place', () => {
    const files = { [`${HOME}/.zshrc`]: `export OPENAI_API_KEY=${OPENAI}`, [`${HOME}/.bashrc`]: `export OPENAI_API_KEY=${OPENAI}` };
    const a = scanAmbient(ctxWith(files)).map((h) => h.id);
    const b = scanAmbient(ctxWith(files)).map((h) => h.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });

  it('fingerprints differ when the value changes and never contain it', () => {
    expect(ambientFingerprint('a-secret-value')).not.toBe(ambientFingerprint('b-secret-value'));
    expect(ambientFingerprint('a-secret-value')).not.toContain('secret');
  });

  it('every rule records where it was verified and what it does not prove', () => {
    for (const r of AMBIENT_RULES) {
      expect(r.verifiedFrom.length).toBeGreaterThan(10);
      expect(r.caveat.length).toBeGreaterThan(10);
    }
  });

  it('ambientPaths lists every file the rules would read', () => {
    const paths = ambientPaths({ home: HOME, platform: 'linux', env: {} });
    expect(paths).toContain(`${HOME}/.config/gh/hosts.yml`);
    expect(paths).toContain(`${HOME}/.zshrc`);
    expect(paths).toContain(`${HOME}/.codex/auth.json`);
  });

  it('a rule that throws does not hide the others', () => {
    const boom = { id: 'boom', tool: 'x', verifiedFrom: 'x', caveat: 'x', scan: () => { throw new Error('bad'); } };
    const hits = scanAmbient(ctxWith({ [`${HOME}/.zshrc`]: `export OPENAI_API_KEY=${OPENAI}` }), [boom, ...AMBIENT_RULES]);
    expect(hits.length).toBe(1);
  });

  it('Windows paths use APPDATA and _netrc', () => {
    const home = 'C:\\Users\\u';
    const paths = ambientPaths({ home, platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } });
    expect(paths).toContain('C:\\Users\\u\\AppData\\Roaming\\GitHub CLI\\hosts.yml');
    expect(paths).toContain('C:\\Users\\u\\_netrc');
  });
});
