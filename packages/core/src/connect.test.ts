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
    for (const id of [
      'claude-code', 'cursor', 'nekkos', 'devin', 'hermes', 'odysseus', 'openclaw', 'warp', 'antigravity',
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it('leads with Nekkos then Claude Code, and sorts the rest by name', () => {
    // The picker renders the catalog in array order, so the order *is* the UI.
    const [first, second, ...rest] = CONNECT_TARGETS;
    expect(first.id).toBe('nekkos');
    expect(second.id).toBe('claude-code');
    // `.mcp.json` files under "m", the way anyone reading the list says it,
    // rather than under the dot. That is the only reason for the sort key.
    const key = (s: string): string => s.replace(/^\W+/, '').toLowerCase();
    const names = rest.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => key(a).localeCompare(key(b))));
  });

  it('only claims a config path for clients that read one', () => {
    expect(configPathFor('cursor', 'linux')).toBe('~/.cursor/mcp.json');
    expect(configPathFor('nekkos', 'linux')).toBe('~/.nekkos/settings.json');
    expect(configPathFor('openclaw', 'linux')).toBe('~/.openclaw/openclaw.json');
    expect(configPathFor('hermes', 'linux')).toBe('~/.hermes/config.yaml');
    expect(configPathFor('warp', 'linux')).toBe('~/.warp/.mcp.json');
    // Antigravity's IDE and CLI share one global config, on every platform.
    expect(configPathFor('antigravity', 'win32')).toBe('~/.gemini/config/mcp_config.json');
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
    // Nekkos' list is an array of configs, each carrying its own bearer token.
    const nekkos = JSON.parse(connectSnippet('nekkos', ctx)!).mcpServers;
    expect(Array.isArray(nekkos)).toBe(true);
    expect(nekkos[0]).toMatchObject({ id: ENTRY_NAME, url: ctx.url, token: ctx.token, enabled: true });
    // Warp reads the same portable shape Cursor does.
    expect(JSON.parse(connectSnippet('warp', ctx)!).mcpServers[ENTRY_NAME].url).toBe(ctx.url);
    // Antigravity rejects `url` and `httpUrl` outright; the key is `serverUrl`.
    const antigravity = JSON.parse(connectSnippet('antigravity', ctx)!).mcpServers[ENTRY_NAME];
    expect(antigravity).toEqual({ serverUrl: ctx.url, headers: { Authorization: `Bearer ${ctx.token}` } });
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

describe('a helper command instead of a stored token', () => {
  const helped = { ...ctx, headersHelper: 'hypergate mcp-headers claude-code-a8ce' };

  it('gives Claude Code the helper, and no copy of the token anywhere', () => {
    const argv = connectArgv('claude-code', helped)!;
    expect(argv.add.slice(0, 3)).toEqual(['mcp', 'add-json', ENTRY_NAME]);
    expect(argv.add).toEqual(expect.arrayContaining(['-s', 'user']));
    expect(argv.reset).toContain('remove');
    const entry = JSON.parse(argv.add[3]).mcpServers?.[ENTRY_NAME] ?? JSON.parse(argv.add[3]);
    expect(entry).toEqual({ type: 'http', url: ctx.url, headersHelper: helped.headersHelper });
    expect(argv.add.join(' ')).not.toContain(ctx.token);
  });

  it('renders the same entry in the snippet as in the command', () => {
    const fromCommand = JSON.parse(connectArgv('claude-code', helped)!.add[3]);
    const fromSnippet = JSON.parse(connectSnippet('claude-code', helped)!).mcpServers[ENTRY_NAME];
    expect(fromSnippet).toEqual(fromCommand);
  });

  it('falls back to the bearer token when there is no helper to run', () => {
    expect(connectArgv('claude-code', ctx)!.add).toContain('-H');
    expect(JSON.parse(connectSnippet('claude-code', ctx)!).mcpServers[ENTRY_NAME].headers).toEqual({
      Authorization: `Bearer ${ctx.token}`,
    });
  });

  it('leaves every other client on the token, since only Claude Code runs helpers', () => {
    // `.mcp.json` in particular is read by harnesses that would choke on a field
    // they don't know, so the portable snippet stays portable.
    for (const id of ['mcp-json', 'cursor', 'vscode', 'gemini-cli', 'openclaw', 'nekkos', 'hermes']) {
      expect(connectSnippet(id, helped) ?? '', id).not.toContain('headersHelper');
    }
    expect(connectArgv('gemini-cli', helped)!.add).toContain('Authorization: Bearer deadbeef');
  });

  it('survives every shell the command can be pasted into', () => {
    // The JSON payload is one argument full of quotes; each shell has to be
    // handed it in a form that reassembles into exactly the same string.
    const argv = connectArgv('claude-code', helped)!.add;
    const rendered = formatCommands('claude', argv);
    expect(rendered.bash).toContain(`'${argv[3].replaceAll("'", `'\\''`)}'`);
    expect(rendered.powershell).toContain(`'${argv[3]}'`);
    expect(rendered.cmd).toContain(argv[3].replaceAll('"', '""'));
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
