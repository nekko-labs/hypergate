import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_GUIDES,
  credentialEnv,
  guideForCli,
  guideForService,
  guidesForServer,
  isCredentialAllowed,
  isValidEnvVar,
  looksSecret,
  maskSecret,
  setCredentialAllowed,
} from './credentials.js';
import { KNOWN_CLIS } from './clis.js';
import { REGISTRY } from './registry.js';

describe('credential guides', () => {
  it('every guide has a unique lowercase service id and a valid env var', () => {
    const seen = new Set<string>();
    for (const g of CREDENTIAL_GUIDES) {
      expect(g.service).toBe(g.service.toLowerCase());
      expect(seen.has(g.service)).toBe(false);
      seen.add(g.service);
      expect(isValidEnvVar(g.envVar)).toBe(true);
      for (const alias of g.aliases ?? []) expect(isValidEnvVar(alias)).toBe(true);
    }
  });

  it('every guide URL is https and every guide has at least one way to obtain the credential', () => {
    for (const g of CREDENTIAL_GUIDES) {
      for (const url of [g.createUrl, g.manageUrl, g.docsUrl]) {
        if (url) expect(url.startsWith('https://')).toBe(true);
      }
      expect(Boolean(g.createUrl || g.createCommand)).toBe(true);
    }
  });

  it('guide cross-references point at real curated catalog ids', () => {
    const cliIds = new Set(KNOWN_CLIS.map((c) => c.id));
    const serverIds = new Set(REGISTRY.map((r) => r.id));
    for (const g of CREDENTIAL_GUIDES) {
      for (const cli of g.clis ?? []) expect(cliIds.has(cli)).toBe(true);
      for (const server of g.servers ?? []) expect(serverIds.has(server)).toBe(true);
    }
  });

  it('looks up by service, CLI, and server', () => {
    expect(guideForService('fly')?.envVar).toBe('FLY_API_TOKEN');
    expect(guideForService('FLY ')?.service).toBe('fly');
    expect(guideForCli('gh')?.service).toBe('github');
    expect(guidesForServer('fly').map((g) => g.service)).toEqual(['fly']);
    expect(guideForService('nope')).toBeUndefined();
  });

  it('the github guide supplies the env var the curated github server requires', () => {
    const github = REGISTRY.find((r) => r.id === 'github');
    const required = (github?.connections ?? []).flatMap((c) => c.requires ?? []);
    const guide = guideForService('github')!;
    const supplied = new Set([guide.envVar, ...(guide.aliases ?? [])]);
    for (const key of required) expect(supplied.has(key)).toBe(true);
  });
});

describe('credential scope', () => {
  it('absent scope permits nothing; the wildcard permits everything', () => {
    expect(isCredentialAllowed(undefined, 'fly-token')).toBe(false);
    expect(isCredentialAllowed([], 'fly-token')).toBe(false);
    expect(isCredentialAllowed('*', 'fly-token')).toBe(true);
    expect(isCredentialAllowed(['fly-token'], 'fly-token')).toBe(true);
    expect(isCredentialAllowed(['other'], 'fly-token')).toBe(false);
  });

  it('granting on an absent scope produces a single-id list, never the wildcard', () => {
    expect(setCredentialAllowed(undefined, 'a', true, ['a', 'b'])).toEqual(['a']);
  });

  it('revoking on a wildcard pins to the current roster minus the id', () => {
    expect(setCredentialAllowed('*', 'a', false, ['a', 'b'])).toEqual(['b']);
  });

  it('granting never widens back to the wildcard', () => {
    expect(setCredentialAllowed(['a'], 'b', true, ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('credential env shaping', () => {
  it('injects the canonical var plus guide aliases', () => {
    const env = credentialEnv({ service: 'github', envVar: 'GH_TOKEN' }, 'v');
    expect(env).toEqual({ GH_TOKEN: 'v', GITHUB_TOKEN: 'v', GITHUB_PERSONAL_ACCESS_TOKEN: 'v' });
  });

  it('skips aliases when the env var was renamed away from the guide default', () => {
    expect(credentialEnv({ service: 'github', envVar: 'MY_TOKEN' }, 'v')).toEqual({ MY_TOKEN: 'v' });
  });

  it('no env var means no injection', () => {
    expect(credentialEnv({ envVar: undefined }, 'v')).toEqual({});
  });
});

describe('masking and heuristics', () => {
  it('masks values without revealing the middle', () => {
    expect(maskSecret('shortpw')).toBe('sh…');
    const masked = maskSecret('fly_v1_abcdefghijklmnop');
    expect(masked).toBe('fly_…mnop');
    expect(masked.includes('abcdefgh')).toBe(false);
  });

  it('classifies secret-looking env keys', () => {
    for (const key of ['FLY_API_TOKEN', 'CLIENT_SECRET', 'API_KEY', 'DB_PASSWORD', 'DATABASE_URL', 'GH_AUTH']) {
      expect(looksSecret(key)).toBe(true);
    }
    for (const key of ['ALLOWED_DIR', 'AWS_REGION', 'AWS_PROFILE', 'PORT']) {
      expect(looksSecret(key)).toBe(false);
    }
  });
});
