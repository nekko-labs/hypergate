import type {
  AgentConnectTarget,
  ConnectShell,
  ConnectTarget,
  ConnectTargetStatus,
} from '@hypergate/shared';

/**
 * Connecting an agent harness to the gateway.
 *
 * One scoped agent token, one client. For a `cli` target we know the client's
 * own `mcp add` invocation, so the daemon can run it — argv built here, never a
 * shell string, never anything the user typed. For a `config` target we produce
 * the snippet and say which file it belongs in. Both paths also render the
 * command/snippet for the user's shell, so the one-click button is a shortcut
 * for something visible rather than a black box.
 *
 * Pure data + string building; the daemon does the PATH lookup and the spawn.
 */

/** The MCP entry name clients end up with. Constant, so re-connecting replaces it. */
export const ENTRY_NAME = 'hypergate';

/** Clients Hypergate knows how to connect, best-supported first. */
export const CONNECT_TARGETS: ConnectTarget[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    method: 'cli',
    command: 'claude',
    hint: 'Registered in the user scope, so the gateway is there in every project.',
    homepage: 'https://docs.anthropic.com/en/docs/claude-code',
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    method: 'cli',
    command: 'gemini',
    hint: 'Registered in the user scope of the Gemini CLI.',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'openpaw',
    name: 'Open Paw',
    method: 'config',
    hint: 'Nothing to paste — Open Paw finds the daemon itself.',
    homepage: 'https://github.com/nekko-labs/open-paw',
  },
  {
    id: 'mcp-json',
    name: '.mcp.json',
    method: 'config',
    hint: 'The portable format — Claude Code project scope, Codex, and most harnesses read it.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    method: 'config',
    hint: 'Cursor picks the file up without a restart.',
    homepage: 'https://docs.cursor.com/context/model-context-protocol',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    method: 'config',
    hint: 'Copilot Chat reads MCP servers from this file.',
    homepage: 'https://code.visualstudio.com/docs/copilot/chat/mcp-servers',
  },
];

export const connectTarget = (id: string): ConnectTarget | undefined => CONNECT_TARGETS.find((t) => t.id === id);

/** Where a `config` client keeps its MCP config on this platform. `~` stays symbolic. */
export const configPathFor = (id: string, platform: string): string | undefined => {
  switch (id) {
    case 'mcp-json':
      return '<your project>/.mcp.json';
    case 'cursor':
      return '~/.cursor/mcp.json';
    case 'vscode':
      return platform === 'win32'
        ? '%APPDATA%\\Code\\User\\mcp.json'
        : platform === 'darwin'
          ? '~/Library/Application Support/Code/User/mcp.json'
          : '~/.config/Code/User/mcp.json';
    default:
      return undefined;
  }
};

/** The shell whose quoting we should show first on this platform. */
export const defaultShellFor = (platform: string): ConnectShell => (platform === 'win32' ? 'powershell' : 'bash');

/** The shells worth offering on this platform (`cmd` only matters on Windows). */
export const shellsFor = (platform: string): ConnectShell[] =>
  platform === 'win32' ? ['powershell', 'cmd', 'bash'] : ['bash', 'powershell'];

/** Connection details a command/snippet is built from. */
export interface ConnectContext {
  /** The gateway's streamable-HTTP endpoint. */
  url: string;
  /** The agent's scoped bearer token. */
  token: string;
}

const authHeader = (token: string): string => `Authorization: Bearer ${token}`;

/**
 * The client CLI invocation that adds the gateway, and the one that removes a
 * previous entry of the same name first. The remove is best-effort: it makes
 * re-connecting (after a token change, say) idempotent instead of an
 * "already exists" error.
 */
export const connectArgv = (id: string, ctx: ConnectContext): { add: string[]; reset?: string[] } | undefined => {
  switch (id) {
    case 'claude-code':
      return {
        reset: ['mcp', 'remove', ENTRY_NAME, '-s', 'user'],
        add: ['mcp', 'add', '-t', 'http', ENTRY_NAME, ctx.url, '-H', authHeader(ctx.token), '-s', 'user'],
      };
    case 'gemini-cli':
      return {
        reset: ['mcp', 'remove', ENTRY_NAME],
        add: [
          'mcp', 'add', '--transport', 'http', ENTRY_NAME, ctx.url,
          '--header', authHeader(ctx.token), '--scope', 'user',
        ],
      };
    default:
      return undefined;
  }
};

/** The config snippet a `config` client wants, ready to paste. */
export const connectSnippet = (id: string, ctx: ConnectContext): string | undefined => {
  const headers = { Authorization: `Bearer ${ctx.token}` };
  switch (id) {
    case 'mcp-json':
      return JSON.stringify({ mcpServers: { [ENTRY_NAME]: { type: 'http', url: ctx.url, headers } } }, null, 2);
    case 'cursor':
      return JSON.stringify({ mcpServers: { [ENTRY_NAME]: { url: ctx.url, headers } } }, null, 2);
    case 'vscode':
      return JSON.stringify({ servers: { [ENTRY_NAME]: { type: 'http', url: ctx.url, headers } } }, null, 2);
    case 'openpaw':
      return 'Settings → MCP servers → "Connect Hypergate gateway".\nOpen Paw discovers the daemon on localhost and uses this agent\'s token.';
    default:
      return undefined;
  }
};

// ── shell quoting ───────────────────────────────────────────────────────────
// Only the Authorization header actually needs quoting today (it has a space),
// but a token or URL from a future release shouldn't silently produce a command
// that pastes wrong, so each shell gets its real escaping rules.

/** Characters that never need quoting in any shell we render for. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

const quoteBash = (s: string): string => (BARE.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
/** PowerShell: single quotes are literal; an embedded quote doubles. */
const quotePwsh = (s: string): string => (BARE.test(s) ? s : `'${s.replaceAll("'", "''")}'`);
/** cmd.exe: double quotes, with the shell metacharacters caret-escaped. */
const quoteCmd = (s: string): string => {
  if (BARE.test(s)) return s;
  return `"${s.replaceAll('"', '""').replace(/[&|<>^]/g, (c) => `^${c}`)}"`;
};

const QUOTE: Record<ConnectShell, (s: string) => string> = {
  bash: quoteBash,
  powershell: quotePwsh,
  cmd: quoteCmd,
};

/** Render `command argv…` the way the given shell wants it typed. */
export const formatCommand = (command: string, argv: string[], shell: ConnectShell): string =>
  [command, ...argv].map((a) => QUOTE[shell](a)).join(' ');

/** Every shell's rendering of one command, for the copy-paste tabs. */
export const formatCommands = (command: string, argv: string[]): Record<ConnectShell, string> => ({
  powershell: formatCommand(command, argv, 'powershell'),
  cmd: formatCommand(command, argv, 'cmd'),
  bash: formatCommand(command, argv, 'bash'),
});

/**
 * Fill a detected target in with one agent's connect material: the argv we'd
 * run, that command quoted per shell, or the config snippet to paste.
 */
export const agentConnectTarget = (status: ConnectTargetStatus, ctx: ConnectContext): AgentConnectTarget => {
  if (status.method === 'cli') {
    const argv = connectArgv(status.id, ctx);
    if (!argv) return status;
    return { ...status, argv: argv.add, commands: formatCommands(status.command ?? status.id, argv.add) };
  }
  return { ...status, snippet: connectSnippet(status.id, ctx) };
};
