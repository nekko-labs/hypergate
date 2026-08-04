import { describe, expect, it } from 'vitest';
import type { ManagedServerConfig } from '@hypergate/shared';
import { normalizeTokenAuthConfig, usesOAuth } from './remote-auth.js';

const remote = (over: Partial<ManagedServerConfig> = {}): ManagedServerConfig => ({
  id: 'github',
  name: 'GitHub',
  runtime: 'remote',
  command: '',
  url: 'https://example.test/mcp',
  enabled: true,
  ...over,
});

describe('remote auth helpers', () => {
  it('keeps token auth on the bearer path after conversion', () => {
    const cfg = normalizeTokenAuthConfig(remote({ auth: 'oauth', clientId: 'Iv1.abc' }));
    expect(cfg.auth).toBe('token');
    expect(cfg.bearerPreferred).toBe(true);
    expect(usesOAuth(cfg, 'Iv1.abc')).toBe(false);
  });

  it('keeps OAuth for token auth only when bearer is not preferred', () => {
    expect(usesOAuth(remote({ auth: 'token' }), 'Iv1.abc')).toBe(true);
    expect(usesOAuth(remote({ auth: 'token', bearerPreferred: true }), 'Iv1.abc')).toBe(false);
  });
});
