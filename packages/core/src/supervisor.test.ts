import { describe, expect, it } from 'vitest';
import type { ManagedServerConfig } from '@hypergate/shared';
import { Supervisor } from './supervisor.js';

describe('Supervisor remote bearer auth', () => {
  it('attaches the injected bearer header without an OAuth provider', async () => {
    const config: ManagedServerConfig = {
      id: 'token-server',
      name: 'Token server',
      runtime: 'remote',
      command: '',
      url: 'https://example.test/mcp',
      transport: 'http',
      auth: 'token',
      enabled: true,
    };
    const supervisor = new Supervisor({
      authHeadersFor: () => ({ Authorization: 'Bearer test-token' }),
      authProviderFor: () => { throw new Error('OAuth provider must not be requested for token auth'); },
    });
    const instance = {
      config,
      state: 'stopped',
      tools: [],
      restarts: 0,
      logs: [],
    };
    const transport = (supervisor as unknown as {
      remoteTransport: (cfg: ManagedServerConfig, inst: typeof instance) => {
        _requestInit?: RequestInit;
        _authProvider?: unknown;
      };
    }).remoteTransport(config, instance);

    expect(transport._requestInit?.headers).toEqual({ Authorization: 'Bearer test-token' });
    expect(transport._authProvider).toBeUndefined();
    expect(instance.logs.join('\n')).not.toContain('test-token');
  });
});
