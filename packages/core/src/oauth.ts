import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * A tiny key→string store the OAuth provider persists through. Kept as an
 * interface so `packages/core` stays IO-free: the daemon supplies a file-backed
 * store (one directory per server under `~/.hypergate/oauth/`), while tests use
 * an in-memory Map. Values are opaque JSON strings.
 */
export interface OAuthStore {
  load(key: string): string | undefined;
  save(key: string, value: string): void;
  remove(key: string): void;
}

/** A trivial in-memory OAuthStore — handy for tests and ephemeral flows. */
export class MemoryOAuthStore implements OAuthStore {
  private m = new Map<string, string>();
  load(key: string): string | undefined {
    return this.m.get(key);
  }
  save(key: string, value: string): void {
    this.m.set(key, value);
  }
  remove(key: string): void {
    this.m.delete(key);
  }
}

// Store keys. Everything the MCP OAuth flow needs to persist between the initial
// authorize step and the later code exchange (which may be a fresh daemon request).
const K_CLIENT = 'client'; // dynamic-registration result (client_id, secret?)
const K_TOKENS = 'tokens'; // access/refresh tokens
const K_VERIFIER = 'verifier'; // PKCE code_verifier
const K_STATE = 'state'; // CSRF state — also how the callback maps back to a server
const K_AUTH_URL = 'authUrl'; // the last authorization URL we asked the user to open

export const HYPERGATE_OAUTH_IDENTITY = {
  clientName: 'Hypergate',
  clientUri: 'https://hypergate.app/',
  logoUri: 'https://hypergate.app/favicon.svg?v=2',
  softwareId: 'app.hypergate',
} as const;

export interface HypergateOAuthProviderOpts {
  /** The daemon's OAuth callback, e.g. `http://localhost:7777/oauth/callback`. */
  redirectUrl: string;
  /** Client name presented at dynamic registration. */
  clientName?: string;
  clientUri?: string;
  logoUri?: string;
  softwareId?: string;
  /** Optional scope requested at registration/authorization. */
  scope?: string;
  /**
   * Pre-registered public client id. When set, the flow skips dynamic client
   * registration and uses this id — required for providers (e.g. GitHub) whose
   * OAuth server doesn't support RFC 7591 registration.
   */
  clientId?: string;
  /**
   * Pre-registered client secret, for providers that require client authentication
   * at the token endpoint even with PKCE (e.g. GitHub). When present, the SDK picks
   * `client_secret_post`/`client_secret_basic` from the server's advertised methods;
   * when absent, the flow stays a pure public client (PKCE only).
   */
  clientSecret?: string;
  /** Called with the authorization URL when the flow needs the user's browser. */
  onRedirect?: (url: URL) => void;
}

/**
 * A store-backed {@link OAuthClientProvider} implementing the MCP OAuth flow
 * (RFC 8414 metadata discovery + RFC 7591 dynamic client registration + OAuth
 * 2.1 auth-code + PKCE). One instance per managed remote server.
 *
 * We never open a browser ourselves: {@link redirectToAuthorization} persists the
 * URL and fires `onRedirect`, and the daemon hands it to the UI to open. Tokens,
 * the registered client, the PKCE verifier, and the CSRF state all persist through
 * the injected {@link OAuthStore} so the callback (a separate request) can finish
 * the exchange.
 */
export class HypergateOAuthProvider implements OAuthClientProvider {
  constructor(
    private store: OAuthStore,
    private opts: HypergateOAuthProviderOpts,
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? HYPERGATE_OAUTH_IDENTITY.clientName,
      client_uri: this.opts.clientUri ?? HYPERGATE_OAUTH_IDENTITY.clientUri,
      logo_uri: this.opts.logoUri ?? HYPERGATE_OAUTH_IDENTITY.logoUri,
      software_id: this.opts.softwareId ?? HYPERGATE_OAUTH_IDENTITY.softwareId,
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client by default (PKCE is the protection). When a secret is
      // configured we register/authenticate as a confidential client instead —
      // some servers (GitHub) require client auth at the token endpoint even
      // with PKCE, since they don't treat native apps as public clients.
      token_endpoint_auth_method: this.opts.clientSecret ? 'client_secret_post' : 'none',
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformation | OAuthClientInformationFull | undefined {
    // A configured static client id short-circuits dynamic registration.
    // Including the secret makes the SDK authenticate the token request.
    if (this.opts.clientId)
      return { client_id: this.opts.clientId, ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}) };
    return this.read<OAuthClientInformationFull>(K_CLIENT);
  }
  saveClientInformation(info: OAuthClientInformation | OAuthClientInformationFull): void {
    this.store.save(K_CLIENT, JSON.stringify(info));
  }

  tokens(): OAuthTokens | undefined {
    return this.read<OAuthTokens>(K_TOKENS);
  }
  saveTokens(tokens: OAuthTokens): void {
    this.store.save(K_TOKENS, JSON.stringify(tokens));
  }

  saveCodeVerifier(verifier: string): void {
    this.store.save(K_VERIFIER, verifier);
  }
  codeVerifier(): string {
    const v = this.store.load(K_VERIFIER);
    if (!v) throw new Error('no PKCE code_verifier saved — restart the authorization flow');
    return v;
  }

  /** CSRF state; also the key the daemon's callback uses to find this server. */
  state(): string {
    let s = this.store.load(K_STATE);
    if (!s) {
      s = randomState();
      this.store.save(K_STATE, s);
    }
    return s;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.store.save(K_AUTH_URL, authorizationUrl.toString());
    this.opts.onRedirect?.(authorizationUrl);
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') this.store.remove(K_TOKENS);
    if (scope === 'all' || scope === 'verifier') this.store.remove(K_VERIFIER);
    if (scope === 'all' || scope === 'client') this.store.remove(K_CLIENT);
    if (scope === 'all') {
      this.store.remove(K_STATE);
      this.store.remove(K_AUTH_URL);
    }
  }

  // ── helpers the daemon uses to drive/observe the flow ────────────────────
  /** The CSRF state currently associated with this server (if a flow is live). */
  currentState(): string | undefined {
    return this.store.load(K_STATE);
  }
  /** The last authorization URL we asked the user to open (if any). */
  lastAuthorizationUrl(): string | undefined {
    return this.store.load(K_AUTH_URL);
  }
  /** True once we hold an access token (i.e. the server is authorized). */
  hasTokens(): boolean {
    return !!this.tokens()?.access_token;
  }
  /** Drop the transient bits after a completed exchange (keep client + tokens). */
  clearFlowState(): void {
    this.store.remove(K_VERIFIER);
    this.store.remove(K_STATE);
    this.store.remove(K_AUTH_URL);
  }

  private read<T>(key: string): T | undefined {
    const raw = this.store.load(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
}

/** URL-safe random state/verifier material without pulling in node:crypto here. */
function randomState(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
