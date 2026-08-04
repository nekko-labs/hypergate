import type { ManagedServerConfig } from '@hypergate/shared';

export const normalizeTokenAuthConfig = (cfg: ManagedServerConfig): ManagedServerConfig => ({
  ...cfg,
  auth: 'token',
  bearerPreferred: true,
});

export const usesOAuth = (cfg: ManagedServerConfig, clientId?: string): boolean =>
  cfg.auth === 'oauth' || (cfg.auth === 'token' && !!clientId && !cfg.bearerPreferred);
