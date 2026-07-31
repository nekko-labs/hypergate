import { describe, it, expect } from 'vitest';
import {
  accountFromClaims,
  accountFromTokens,
  accountFromUserinfo,
  authorizationServersOf,
  decodeJwtClaims,
  userinfoEndpoint,
} from './account.js';

/** base64url of a UTF-8 string (btoa alone is Latin-1, so it rejects "猫"). */
const b64 = (s: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** A JWT with the given payload. Header and signature are never read. */
const jwt = (payload: Record<string, unknown>): string =>
  `${b64('{"alg":"none"}')}.${b64(JSON.stringify(payload))}.sig`;

describe('decodeJwtClaims', () => {
  it('reads the payload of a well-formed token', () => {
    expect(decodeJwtClaims(jwt({ sub: 'u_1', email: 'a@b.c' }))).toEqual({ sub: 'u_1', email: 'a@b.c' });
  });

  it('returns nothing for an opaque token, which is the common case', () => {
    expect(decodeJwtClaims('gho_aaaaaaaaaaaaaaaaaaaa')).toBeUndefined();
    expect(decodeJwtClaims('')).toBeUndefined();
    expect(decodeJwtClaims(undefined)).toBeUndefined();
  });

  it('survives a token that only looks like a JWT', () => {
    expect(decodeJwtClaims('a.b.c')).toBeUndefined();
    expect(decodeJwtClaims(`x.${btoa('[1,2,3]')}.y`)).toBeUndefined();
  });

  it('decodes non-ASCII claims as UTF-8', () => {
    expect(decodeJwtClaims(jwt({ name: '猫 Nekko' }))?.name).toBe('猫 Nekko');
  });
});

describe('accountFromClaims', () => {
  it('prefers the most human-identifying claim available', () => {
    expect(accountFromClaims({ sub: 'u_1', email: 'a@b.c', preferred_username: 'ab', name: 'A B' }, 'id_token')?.label).toBe('a@b.c');
    expect(accountFromClaims({ sub: 'u_1', login: 'octocat', name: 'The Octocat' }, 'access_token')?.label).toBe('octocat');
    expect(accountFromClaims({ sub: 'u_1', name: 'A B' }, 'userinfo')?.label).toBe('A B');
    // A raw subject still answers "which account, and did it change?".
    expect(accountFromClaims({ sub: 'u_1' }, 'id_token')?.label).toBe('u_1');
  });

  it('carries the organisation when the provider names one', () => {
    expect(accountFromClaims({ sub: 'u', email: 'a@b.c', workspace: 'Nekko Labs' }, 'id_token')?.org).toBe('Nekko Labs');
  });

  it('reports nothing rather than an empty label', () => {
    expect(accountFromClaims({ scope: 'read write', exp: 123 }, 'id_token')).toBeUndefined();
    expect(accountFromClaims({ email: '   ' }, 'id_token')).toBeUndefined();
    expect(accountFromClaims(undefined, 'id_token')).toBeUndefined();
  });
});

describe('accountFromTokens', () => {
  it('trusts the id_token over the access token', () => {
    const a = accountFromTokens({ id_token: jwt({ email: 'me@id.token' }), access_token: jwt({ email: 'me@access.token' }) });
    expect(a).toMatchObject({ label: 'me@id.token', source: 'id_token' });
  });

  it('falls back to a JWT access token', () => {
    expect(accountFromTokens({ access_token: jwt({ sub: 'u_9' }) })).toMatchObject({ label: 'u_9', source: 'access_token' });
  });

  it('yields nothing for an opaque grant, so the caller can go ask userinfo', () => {
    expect(accountFromTokens({ access_token: 'lin_api_xxxxx' })).toBeUndefined();
    expect(accountFromTokens(undefined)).toBeUndefined();
  });
});

describe('accountFromUserinfo', () => {
  it('reads a userinfo body', () => {
    expect(accountFromUserinfo({ sub: 'u', email: 'a@b.c' })).toMatchObject({ label: 'a@b.c', source: 'userinfo' });
  });
  it('ignores a non-object body', () => {
    expect(accountFromUserinfo('nope')).toBeUndefined();
    expect(accountFromUserinfo([{ email: 'a@b.c' }])).toBeUndefined();
  });
});

describe('discovery', () => {
  it('accepts a userinfo endpoint on the issuer itself', () => {
    expect(userinfoEndpoint({ userinfo_endpoint: 'https://auth.example.com/userinfo' }, 'https://auth.example.com')).toBe(
      'https://auth.example.com/userinfo',
    );
  });

  it('refuses to send the token anywhere but the issuer', () => {
    // The metadata is fetched unauthenticated, so a cross-origin endpoint in it
    // is precisely the thing that must not be followed with a bearer token.
    expect(userinfoEndpoint({ userinfo_endpoint: 'https://evil.example/collect' }, 'https://auth.example.com')).toBeUndefined();
    expect(userinfoEndpoint({ userinfo_endpoint: 'http://auth.example.com/userinfo' }, 'http://auth.example.com')).toBeUndefined();
    expect(userinfoEndpoint({}, 'https://auth.example.com')).toBeUndefined();
    expect(userinfoEndpoint(undefined, 'https://auth.example.com')).toBeUndefined();
  });

  it('lists the authorization servers a resource trusts', () => {
    expect(authorizationServersOf({ authorization_servers: ['https://auth.example.com', 7] })).toEqual([
      'https://auth.example.com',
    ]);
    expect(authorizationServersOf({})).toEqual([]);
    expect(authorizationServersOf(null)).toEqual([]);
  });
});
