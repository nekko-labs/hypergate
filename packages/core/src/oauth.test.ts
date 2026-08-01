import { describe, it, expect } from 'vitest';
import { MemoryOAuthStore, HypergateOAuthProvider } from './oauth.js';

const REDIRECT = 'http://localhost:7777/oauth/callback';

describe('HypergateOAuthProvider', () => {
  it('advertises a public-client metadata with our redirect', () => {
    const p = new HypergateOAuthProvider(new MemoryOAuthStore(), { redirectUrl: REDIRECT });
    const meta = p.clientMetadata;
    expect(meta.redirect_uris).toEqual([REDIRECT]);
    expect(meta.token_endpoint_auth_method).toBe('none');
    expect(meta.grant_types).toContain('authorization_code');
    expect(meta.grant_types).toContain('refresh_token');
    expect(p.redirectUrl).toBe(REDIRECT);
  });

  it('persists client info, tokens, and the PKCE verifier through the store', () => {
    const store = new MemoryOAuthStore();
    const p = new HypergateOAuthProvider(store, { redirectUrl: REDIRECT });

    expect(p.clientInformation()).toBeUndefined();
    expect(p.tokens()).toBeUndefined();
    expect(p.hasTokens()).toBe(false);

    p.saveClientInformation({ client_id: 'abc', redirect_uris: [REDIRECT] });
    p.saveTokens({ access_token: 'tok', token_type: 'bearer' });
    p.saveCodeVerifier('verifier-123');

    // A fresh instance over the same store reads the persisted values (models the
    // callback arriving as a separate daemon request).
    const p2 = new HypergateOAuthProvider(store, { redirectUrl: REDIRECT });
    expect(p2.clientInformation()?.client_id).toBe('abc');
    expect(p2.tokens()?.access_token).toBe('tok');
    expect(p2.hasTokens()).toBe(true);
    expect(p2.codeVerifier()).toBe('verifier-123');
  });

  it('generates a stable state and captures the authorization URL + onRedirect', () => {
    const store = new MemoryOAuthStore();
    const seen: string[] = [];
    const p = new HypergateOAuthProvider(store, { redirectUrl: REDIRECT, onRedirect: (u) => seen.push(u.toString()) });

    const s1 = p.state();
    const s2 = p.state();
    expect(s1).toBe(s2); // stable within a flow
    expect(s1).toMatch(/^[0-9a-f]+$/);
    expect(p.currentState()).toBe(s1);

    p.redirectToAuthorization(new URL('https://auth.example.com/authorize?state=' + s1));
    expect(seen).toHaveLength(1);
    expect(p.lastAuthorizationUrl()).toContain('auth.example.com');
  });

  it('static clientId short-circuits DCR as a public client (no secret)', () => {
    const p = new HypergateOAuthProvider(new MemoryOAuthStore(), { redirectUrl: REDIRECT, clientId: 'Iv1.abc' });
    const info = p.clientInformation();
    expect(info?.client_id).toBe('Iv1.abc');
    expect((info as { client_secret?: string }).client_secret).toBeUndefined();
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none');
  });

  it('static clientId + clientSecret authenticates as a confidential client (GitHub)', () => {
    const p = new HypergateOAuthProvider(new MemoryOAuthStore(), {
      redirectUrl: REDIRECT, clientId: 'Iv1.abc', clientSecret: 'sec-xyz',
    });
    const info = p.clientInformation();
    expect(info?.client_id).toBe('Iv1.abc');
    expect((info as { client_secret?: string }).client_secret).toBe('sec-xyz');
    // Drives the SDK to send client auth at the token endpoint (client_secret_post).
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
  });

  it('throws if asked for a verifier before one was saved', () => {
    const p = new HypergateOAuthProvider(new MemoryOAuthStore(), { redirectUrl: REDIRECT });
    expect(() => p.codeVerifier()).toThrow();
  });

  it('invalidateCredentials scopes what it clears; tokens survive a verifier-only clear', () => {
    const store = new MemoryOAuthStore();
    const p = new HypergateOAuthProvider(store, { redirectUrl: REDIRECT });
    p.saveTokens({ access_token: 'tok', token_type: 'bearer' });
    p.saveCodeVerifier('v');
    p.state();

    p.invalidateCredentials('verifier');
    expect(p.tokens()?.access_token).toBe('tok');
    expect(() => p.codeVerifier()).toThrow();

    p.invalidateCredentials('all');
    expect(p.tokens()).toBeUndefined();
    expect(p.currentState()).toBeUndefined();
    expect(p.lastAuthorizationUrl()).toBeUndefined();
  });

  it('clearFlowState drops transient bits but keeps tokens + client', () => {
    const store = new MemoryOAuthStore();
    const p = new HypergateOAuthProvider(store, { redirectUrl: REDIRECT });
    p.saveClientInformation({ client_id: 'abc', redirect_uris: [REDIRECT] });
    p.saveTokens({ access_token: 'tok', token_type: 'bearer' });
    p.saveCodeVerifier('v');
    p.state();
    p.redirectToAuthorization(new URL('https://auth.example.com/authorize'));

    p.clearFlowState();
    expect(p.hasTokens()).toBe(true);
    expect(p.clientInformation()?.client_id).toBe('abc');
    expect(p.currentState()).toBeUndefined();
    expect(p.lastAuthorizationUrl()).toBeUndefined();
  });
});
