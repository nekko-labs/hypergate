import type { ServerAccount } from '@hypergate/shared';

/**
 * Which account a remote server is signed in as.
 *
 * A remote MCP server is reached with one person's grant, and *whose* grant it
 * is decides what the agent can see — so the manager shows it on the server row.
 * Working it out is a chain of increasingly expensive guesses, and this module
 * owns the free ones: read what the grant already says about itself.
 *
 *   1. `id_token` — an OIDC token, so its claims are identity by definition.
 *   2. `access_token`, when it happens to be a JWT. Plenty of providers issue
 *      one; plenty issue an opaque string, which simply yields nothing.
 *   3. (the daemon, not here) the provider's `userinfo` endpoint — one bounded
 *      HTTP call, only when the two free routes came up empty.
 *
 * Nothing here validates a signature, and it must not: these tokens are ours,
 * minted for us, already stored; we are reading our own grant to label a row,
 * not authenticating a caller. Treat every claim as display text.
 */

/** Claims we might find, across OIDC, GitHub, Atlassian, Linear, and friends. */
type Claims = Record<string, unknown>;

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= 320 ? t : undefined;
};

/** base64url → utf8, without assuming Buffer or atob specifically. */
const b64urlDecode = (segment: string): string | undefined => {
  const b64 = segment.replaceAll('-', '+').replaceAll('_', '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * The claim set inside a JWT, or `undefined` for anything that isn't one.
 *
 * Opaque tokens are the common case, not an error: most OAuth providers hand
 * out a random string, and "this told us nothing" is a fine answer.
 */
export function decodeJwtClaims(token?: string): Claims | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const json = b64urlDecode(parts[1]);
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Claims) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a claim set into something worth showing on a row.
 *
 * The order is "how well does this identify the account *to a human*": an email
 * is unambiguous, a username nearly so, a display name is at least readable, and
 * a raw subject is a last resort that still answers "did this change?".
 */
export function accountFromClaims(claims: Claims | undefined, source: ServerAccount['source']): ServerAccount | undefined {
  if (!claims) return undefined;
  const email = str(claims.email);
  const username = str(claims.preferred_username) ?? str(claims.login) ?? str(claims.username) ?? str(claims.nickname);
  const name = str(claims.name) ?? str(claims.given_name);
  const subject = str(claims.sub) ?? str(claims.user_id) ?? str(claims.userId);
  const org =
    str(claims.org) ??
    str(claims.organization) ??
    str(claims.workspace) ??
    str(claims.tenant) ??
    str(claims.team) ??
    str(claims.account);
  const label = email ?? username ?? name ?? subject;
  if (!label) return undefined;
  return { label, email, name: name ?? username, subject, org, source };
}

/** Identity carried by the grant itself, free of any network call. */
export function accountFromTokens(tokens: { id_token?: unknown; access_token?: unknown } | undefined): ServerAccount | undefined {
  if (!tokens) return undefined;
  return (
    accountFromClaims(decodeJwtClaims(str(tokens.id_token)), 'id_token') ??
    accountFromClaims(decodeJwtClaims(str(tokens.access_token)), 'access_token')
  );
}

/** Identity from an OpenID `userinfo` response body. Same claim names apply. */
export function accountFromUserinfo(body: unknown): ServerAccount | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return accountFromClaims(body as Claims, 'userinfo');
}

/**
 * The `userinfo` endpoint of an authorization server, from its metadata
 * document — either flavour, since MCP providers publish both RFC 8414
 * (`oauth-authorization-server`) and OIDC (`openid-configuration`) shapes.
 *
 * Only same-origin-as-the-issuer endpoints are accepted: the metadata is
 * fetched from an unauthenticated well-known URL, and we are about to send it a
 * bearer token, so a document that points the token somewhere else is exactly
 * what we must not follow.
 */
export function userinfoEndpoint(metadata: unknown, issuerOrigin: string): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const endpoint = str((metadata as Claims).userinfo_endpoint);
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return undefined;
    return url.origin === new URL(issuerOrigin).origin ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The authorization servers a protected resource says it trusts (RFC 9728, the
 * discovery document MCP servers publish). First one wins — providers list one.
 */
export function authorizationServersOf(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const list = (metadata as Claims).authorization_servers;
  if (!Array.isArray(list)) return [];
  return list.map((v) => str(v)).filter((v): v is string => v !== undefined);
}
