import { describe, expect, it } from 'vitest';

import { isAllowedHost, isAllowedMutationRequest, isLoopbackOrigin } from './security.ts';

describe('daemon request security predicates', () => {
  it('allows loopback Host names with any port, but rejects rebinding names', () => {
    expect(isAllowedHost('localhost:7777')).toBe(true);
    expect(isAllowedHost('127.0.0.1:1234')).toBe(true);
    expect(isAllowedHost('[::1]:7777')).toBe(true);
    expect(isAllowedHost('evil.example:7777')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(true);
  });

  it('extends loopback Hosts with case-insensitive configured names, ignoring ports', () => {
    const previous = process.env.HYPERGATE_ALLOWED_HOSTS;
    process.env.HYPERGATE_ALLOWED_HOSTS = ' example.test, ,Proxy.TEST:8443 ';
    try {
      expect(isAllowedHost('example.test:7777')).toBe(true);
      expect(isAllowedHost('PROXY.test:1234')).toBe(true);
      expect(isAllowedHost('localhost:9999')).toBe(true);
      expect(isAllowedHost('unlisted.example')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HYPERGATE_ALLOWED_HOSTS;
      else process.env.HYPERGATE_ALLOWED_HOSTS = previous;
    }
  });

  it('allows loopback origins on any port only', () => {
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackOrigin('http://evil.example')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
    expect(isLoopbackOrigin(undefined)).toBe(true);
  });

  it('rejects cross-site mutation metadata, including omitted Origin with a fetch site', () => {
    expect(isAllowedMutationRequest({ origin: 'http://localhost:5173' })).toBe(true);
    expect(isAllowedMutationRequest({})).toBe(true);
    expect(isAllowedMutationRequest({ origin: 'http://evil.example' })).toBe(false);
    expect(isAllowedMutationRequest({ 'sec-fetch-site': 'cross-site' })).toBe(false);
    expect(isAllowedMutationRequest({ 'sec-fetch-site': 'same-origin' })).toBe(true);
    expect(isAllowedMutationRequest({ 'sec-fetch-site': 'none' })).toBe(true);
  });
});
