/** Names that resolve only to the daemon's loopback listener. */
export const isLoopbackHostname = (hostname: string): boolean =>
  ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase().replace(/^\[|\]$/g, ''));

const hostnameFrom = (value: string): string | undefined => {
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password) return undefined;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
};

/**
 * A Host header is browser-controlled and therefore must not be allowed to
 * turn DNS rebinding into access to a loopback management service.
 */
export const isAllowedHost = (host: string | undefined): boolean => {
  if (host === undefined) return true;
  const hostname = hostnameFrom(host);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  const allowed = (process.env.HYPERGATE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => hostnameFrom(entry.trim()))
    .filter((entry): entry is string => Boolean(entry));
  return allowed.includes(hostname);
};

/** Accept same-machine browser origins, regardless of the UI dev port. */
export const isLoopbackOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
};

/**
 * Origin is absent for native clients. Sec-Fetch-Site closes the remaining
 * browser case where a browser omits Origin on a state-changing request.
 */
export const isAllowedMutationRequest = (headers: { origin?: string; 'sec-fetch-site'?: string }): boolean => {
  if (!isLoopbackOrigin(headers.origin)) return false;
  const fetchSite = headers['sec-fetch-site'];
  return fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';
};
