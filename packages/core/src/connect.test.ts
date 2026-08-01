import { describe, it, expect } from 'vitest';
import {
  CONNECT_TARGETS,
  ENTRY_NAME,
  agentConnectTarget,
  configPathFor,
  connectArgv,
  connectSnippet,
  connectTarget,
  defaultShellFor,
  formatCommand,
  formatCommands,
  shellsFor,
} from './connect.js';
import type { ConnectTargetStatus } from '@hypergate/shared';

const ctx = { url: 'http://localhost:7777/mcp', token: 'deadbeef' };

describe('connect targets', () => {
  it('has unique ids and the fields its method needs', () => {
    const ids = CONNECT_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of CONNECT_TARGETS) {
      if (t.method === 'cli') {
        expect(t.command, t.id).toBeTruthy();
        expect(connectArgv(t.id, ctx), t.id).toBeDefined();
      } else if (t.method === 'config') {
        expect(connectSnippet(t.id, ctx), t.id).toBeTruthy();
        expect(configPathFor(t.id, 'linux'), t.id).toBeTruthy();
      }
    }
  });

  it('describes every agent in the picker', () => {
    // The catalog doubles as "+ Add agent", so a nameless or blurb-less entry
    // would show up there as an unexplained button.
    for (const t of CONNECT_TARGETS) {
      expect(t.name, t.id).toBeTruthy();
      expect(t.blurb, t.id).toBeTruthy();
    }
  });

  it('offers the popular agents by name', () => {
    const ids = CONNECT_TARGETS.map((t) => t.id);
    for (const id of ['claude-code', 'cursor', 'kotrain', 'devin', 'hermes', 'odysseus', 'openclaw']) {
      expect(ids, id).toContain(id);
    }
  });

  it('only claims a config path for clients that read one', () => {
    expect(configPathFor('cursor', 'linux')).toBe('~/.cursor/mcp.json');
    expect(configPathFor('kotrain', 'linux')).toBe('~/.kotrain/settings.json');
    expect(configPathFor('openclaw', 'linux')).toBe('~/.openclaw/openclaw.json');
    expect(configPathFor('hermes', 'linux')).toBe('~/.hermes/config.yaml');
    expect(configPathFor('vscode', 'win32')).toContain('APPDATA');
    expect(configPathFor('vscode', 'darwin')).toContain('Library');
    // Devin keeps its MCP list in the cloud, so there is no file to point at.
    expect(configPathFor('devin', 'linux')).toBeUndefined();
  });

  it('resolves known ids only', () => {
    expect(connectTarget('claude-code')?.name).toBe('Claude Code');
    expect(connectTarget('rm -rf')).toBeUndefined();
    expect(connectArgv('rm -rf', ctx)).toBeUndefined();
  });
});

describe('connect commands', () => {
  it('adds the gateway to Claude Code in the user scope, after clearing a stale entry', () => {
    const argv = connectArgv('claude-code', ctx)!;
    expect(argv.add).toEqual([
      'mcp', 'add', '-t', 'http', ENTRY_NAME, ctx.url,
      '-H', 'Authorization: Bearer deadbeef', '-s', 'user',
    ]);
    expect(argv.reset).toContain('remove');
    // Re-connecting must land on the same entry name, or the reset is pointless.
    expect(argv.reset).toContain(ENTRY_NAME);
  });

  it('carries the token in a header, never in the URL', () => {
    for (const t of CONNECT_TARGETS) {
      const argv = connectArgv(t.id, ctx)?.add ?? [];
      for (const a of argv) if (a.includes(ctx.token)) expect(a).toContain('Authorization: Bearer');
      expect(connectSnippet(t.id, ctx) ?? '').not.toContain(`${ctx.url}?`);
    }
  });

  it('emits the config shape each client actually reads', () => {
    expect(JSON.parse(connectSnippet('mcp-json', ctx)!).mcpServers[ENTRY_NAME].type).toBe('http');
    // Cursor infers HTTP from `url`; VS Code nests under `servers`, not `mcpServers`.
    expect(JSON.parse(connectSnippet('cursor', ctx)!).mcpServers[ENTRY_NAME]).toEqual({
      url: ctx.url,
      headers: { Authorization: `Bearer ${ctx.token}` },
    });
    expect(JSON.parse(connectSnippet('vscode', ctx)!).servers[ENTRY_NAME].url).toBe(ctx.url);
    // OpenClaw nests under `mcp.servers` and names its transport explicitly.
    expect(JSON.parse(connectSnippet('openclaw', ctx)!).mcp.servers[ENTRY_NAME].transport).toBe('streamable-http');
    // Kotrain's list is an array of configs, each carrying its own bearer token.
    const kotrain = JSON.parse(connectSnippet('kotrain', ctx)!).mcpServers;
    expect(Array.isArray(kotrain)).toBe(true);
    expect(kotrain[0]).toMatchObject({ id: ENTRY_NAME, url: ctx.url, token: ctx.token, enabled: true });
    // Hermes is YAML, with every value quoted so a numeric-looking token stays a string.
    expect(connectSnippet('hermes', ctx)).toContain(`Authorization: "Bearer ${ctx.token}"`);
  });

  it('adds the gateway to OpenClaw over streamable HTTP', () => {
    const argv = connectArgv('openclaw', ctx)!;
    expect(argv.add).toEqual([
      'mcp', 'add', ENTRY_NAME, '--url', ctx.url,
      '--transport', 'streamable-http', '--header', 'Authorization: Bearer deadbeef',
    ]);
  });
});

describe('shell quoting', () => {
  const argv = connectArgv('claude-code', ctx)!.add;

  it('leaves plain arguments bare and quotes the header per shell', () => {
    expect(formatCommand('claude', argv, 'bash')).toBe(
      `claude mcp add -t http ${ENTRY_NAME} ${ctx.url} -H 'Authorization: Bearer deadbeef' -s user`,
    );
    expect(formatCommand('claude', argv, 'powershell')).toContain("'Authorization: Bearer deadbeef'");
    expect(formatCommand('claude', argv, 'cmd')).toContain('"Authorization: Bearer deadbeef"');
  });

  it("escapes each shell's own quote character", () => {
    expect(formatCommand('x', ["it's"], 'bash')).toBe(`x 'it'\\''s'`);
    expect(formatCommand('x', ["it's"], 'powershell')).toBe(`x 'it''s'`);
    expect(formatCommand('x', ['say "hi"'], 'cmd')).toBe('x "say ""hi"""');
  });

  it('caret-escapes cmd.exe metacharacters', () => {
    expect(formatCommand('x', ['a & b'], 'cmd')).toBe('x "a ^& b"');
  });

  it('offers cmd only on Windows, and preselects the native shell', () => {
    expect(defaultShellFor('win32')).toBe('powershell');
    expect(defaultShellFor('darwin')).toBe('bash');
    expect(shellsFor('win32')).toContain('cmd');
    expect(shellsFor('linux')).not.toContain('cmd');
    expect(Object.keys(formatCommands('claude', argv)).sort()).toEqual(['bash', 'cmd', 'powershell']);
  });
});

describe('agentConnectTarget', () => {
  const status = (over: Partial<ConnectTargetStatus>): ConnectTargetStatus => ({
    id: 'claude-code', name: 'Claude Code', method: 'cli', command: 'claude', found: true, ...over,
  });

  it('fills a CLI target with argv + per-shell commands, and a snippet to fall back on', () => {
    const t = agentConnectTarget(status({}), ctx);
    expect(t.argv?.[0]).toBe('mcp');
    expect(t.commands?.bash.startsWith('claude mcp add')).toBe(true);
    // A machine without the CLI still needs a way in.
    expect(t.snippet).toContain(ctx.token);
  });

  it('fills a config target with a snippet instead', () => {
    const t = agentConnectTarget(status({ id: 'cursor', name: 'Cursor', method: 'config', command: undefined }), ctx);
    expect(t.argv).toBeUndefined();
    expect(t.snippet).toContain(ctx.token);
  });

  it('hands a manual target the raw endpoint + token to type in', () => {
    const t = agentConnectTarget(status({ id: 'devin', name: 'Devin', method: 'manual', command: undefined }), ctx);
    expect(t.argv).toBeUndefined();
    expect(t.token).toBe(ctx.token);
  });
});
