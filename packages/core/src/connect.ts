import type {
  AgentConnectTarget,
  ConnectShell,
  ConnectTarget,
  ConnectTargetStatus,
} from '@hypergate/shared';

/**
 * Connecting an agent harness to the gateway.
 *
 * This table is also the **agent catalog**: the list "+ Add agent" offers, so
 * picking a harness and connecting it are one decision instead of two. An agent
 * created from here is that product — its name is the product's name and it has
 * exactly one way in, its own — which is why the UI never shows a strip of every
 * other client underneath it.
 *
 * Three ways in, in descending order of how little the user has to do:
 *   • `cli`    — we know the client's own `mcp add` invocation, so the daemon can
 *                run it. Argv is built here, never a shell string, never anything
 *                the user typed. Most also carry a snippet, so a machine without
 *                the CLI installed isn't a dead end.
 *   • `config` — a config file we can name, and the exact text to put in it.
 *   • `manual` — the client keeps its MCP list in a UI (or in the cloud), so we
 *                hand over the endpoint, the token, and where to paste them.
 *
 * Pure data + string building; the daemon does the PATH lookup and the spawn.
 */

/** The MCP entry name clients end up with. Constant, so re-connecting replaces it. */
export const ENTRY_NAME = 'hypergate';

/**
 * Clients Hypergate knows how to connect.
 *
 * Order is deliberate and only two entries deep: Kotrain first because it is
 * ours and the pairing we can vouch for end to end, then Claude Code as the
 * harness most people arrive already running. Everything after those two is
 * alphabetical: a flat list nobody has to argue about, rather than a ranking
 * that quietly ages into a lie as clients come and go.
 */
export const CONNECT_TARGETS: ConnectTarget[] = [
  {
    id: 'kotrain',
    name: 'Kotrain',
    // The one client that connects itself: Kotrain registers `kotrain://`, so
    // the button hands the job to the app rather than writing a config file
    // underneath it (Kotrain holds its settings in memory while it runs, so a
    // file written behind its back would be overwritten by the next save).
    method: 'deeplink',
    blurb: 'Local-first AI chat, cowork and coding in one window (Nekko Labs).',
    hint: 'Kotrain comes forward and asks you to confirm, then shows Hypergate as a tab in its own window.',
    homepage: 'https://kotrain.com',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    method: 'cli',
    command: 'claude',
    blurb: "Anthropic's terminal coding agent.",
    hint: 'Registered in the user scope, so the gateway is there in every project.',
    homepage: 'https://docs.anthropic.com/en/docs/claude-code',
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    method: 'config',
    blurb: "Google's agentic IDE.",
    hint: 'One config serves the IDE and the CLI, or add it in Settings → Customizations → Open MCP Config.',
    homepage: 'https://antigravity.google/docs/mcp',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    method: 'config',
    blurb: 'The AI code editor.',
    hint: 'Cursor picks the file up without a restart.',
    homepage: 'https://docs.cursor.com/context/model-context-protocol',
  },
  {
    id: 'devin',
    name: 'Devin',
    method: 'manual',
    blurb: "Cognition's cloud software engineer.",
    hint: 'Settings → Connections → MCP servers → Add a custom MCP, transport HTTP.',
    // Worth saying before someone spends ten minutes on it: Devin's VM is not
    // on this machine, so `localhost:7777` means *its* localhost, not yours.
    note: 'Devin runs in the cloud and cannot reach a localhost gateway. Expose Hypergate on a public URL (a tunnel or a reachable host) first, then use that URL below.',
    homepage: 'https://docs.devin.ai/work-with-devin/mcp',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    method: 'cli',
    command: 'gemini',
    blurb: "Google's terminal agent.",
    hint: 'Registered in the user scope of the Gemini CLI.',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    method: 'config',
    blurb: "Nous Research's agent — YAML config, HTTP MCP servers.",
    hint: 'Hermes reads its MCP servers from YAML; merge this under `mcp_servers`.',
    homepage: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
  },
  // Filed under "m", where someone scanning the list would look for it.
  {
    id: 'mcp-json',
    name: '.mcp.json',
    method: 'config',
    blurb: 'The portable file most harnesses read — Codex, Windsurf, Zed, and more.',
    hint: 'The portable format — Claude Code project scope, Codex, and most harnesses read it.',
  },
  {
    id: 'odysseus',
    name: 'Odysseus',
    method: 'manual',
    blurb: 'Self-hosted AI workspace: chat, agent, research.',
    hint: 'Odysseus manages MCP servers from its admin UI, so add the endpoint there.',
    homepage: 'https://github.com/nekko-labs/odysseus',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    method: 'cli',
    command: 'openclaw',
    blurb: 'Open-source agent runtime with per-agent tool routing.',
    hint: 'Added to the global server list; per-agent routing can narrow it later.',
    homepage: 'https://docs.openclaw.ai/cli/mcp',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    method: 'config',
    blurb: 'Copilot Chat in VS Code.',
    hint: 'Copilot Chat reads MCP servers from this file.',
    homepage: 'https://code.visualstudio.com/docs/copilot/chat/mcp-servers',
  },
  {
    id: 'warp',
    name: 'Warp',
    method: 'config',
    blurb: 'The agentic terminal.',
    hint: 'Global Warp servers auto-spawn, or paste it in Settings → Agents → MCP servers → + Add.',
    homepage: 'https://docs.warp.dev/knowledge-and-collaboration/mcp',
  },
];

export const connectTarget = (id: string): ConnectTarget | undefined => CONNECT_TARGETS.find((t) => t.id === id);

/** Where a client keeps its MCP config on this platform. `~` stays symbolic. */
export const configPathFor = (id: string, platform: string): string | undefined => {
  switch (id) {
    case 'mcp-json':
      return '<your project>/.mcp.json';
    case 'antigravity':
      // One file for both surfaces: Antigravity's IDE and its CLI read the same
      // global config, so there is nothing to repeat per-surface.
      return '~/.gemini/config/mcp_config.json';
    case 'cursor':
      return '~/.cursor/mcp.json';
    case 'kotrain':
      return '~/.kotrain/settings.json';
    case 'openclaw':
      return '~/.openclaw/openclaw.json';
    case 'hermes':
      return '~/.hermes/config.yaml';
    case 'warp':
      return '~/.warp/.mcp.json';
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
  /**
   * A command that prints this agent's auth headers as JSON, for a client that
   * can run one at connect time rather than storing a credential.
   *
   * Set only when the command has been shown to work on this machine — a client
   * pointed at a helper that isn't there is worse off than one holding a token
   * that might go stale. Today only Claude Code reads it (`headersHelper`),
   * which is also the only client that re-runs the helper on a 401, so a
   * rotated token costs it a reconnect rather than a support question.
   */
  headersHelper?: string;
}

const authHeader = (token: string): string => `Authorization: Bearer ${token}`;

/**
 * Claude Code's entry for the gateway: a helper command when we have one, the
 * bearer token when we don't. One builder for both the `add-json` argv and the
 * snippet, so the button and the copy-paste can never describe different things.
 */
const claudeCodeEntry = (ctx: ConnectContext): Record<string, unknown> => ({
  type: 'http',
  url: ctx.url,
  ...(ctx.headersHelper
    ? { headersHelper: ctx.headersHelper }
    : { headers: { Authorization: `Bearer ${ctx.token}` } }),
});

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
        // With a helper, the entry names a command instead of carrying a token,
        // which `mcp add` has no flag for — hence `add-json`, whose payload is
        // the same object `connectSnippet` renders.
        add: ctx.headersHelper
          ? ['mcp', 'add-json', ENTRY_NAME, JSON.stringify(claudeCodeEntry(ctx)), '-s', 'user']
          : ['mcp', 'add', '-t', 'http', ENTRY_NAME, ctx.url, '-H', authHeader(ctx.token), '-s', 'user'],
      };
    case 'gemini-cli':
      return {
        reset: ['mcp', 'remove', ENTRY_NAME],
        add: [
          'mcp', 'add', '--transport', 'http', ENTRY_NAME, ctx.url,
          '--header', authHeader(ctx.token), '--scope', 'user',
        ],
      };
    case 'openclaw':
      return {
        reset: ['mcp', 'remove', ENTRY_NAME],
        add: [
          'mcp', 'add', ENTRY_NAME, '--url', ctx.url,
          '--transport', 'streamable-http', '--header', authHeader(ctx.token),
        ],
      };
    default:
      return undefined;
  }
};

/**
 * The config text a client wants, ready to paste.
 *
 * `cli` clients get one too where the format is known: the button is the happy
 * path, not the only path, and a machine without the CLI on it should still have
 * something to copy.
 */
export const connectSnippet = (id: string, ctx: ConnectContext): string | undefined => {
  const headers = { Authorization: `Bearer ${ctx.token}` };
  switch (id) {
    // Claude Code is the one client that can run a helper command, so it is the
    // one whose snippet may carry no credential at all.
    case 'claude-code':
      return JSON.stringify({ mcpServers: { [ENTRY_NAME]: claudeCodeEntry(ctx) } }, null, 2);
    // `.mcp.json` is read by half a dozen harnesses, most of which would choke
    // on a field only Claude Code understands, so this one keeps the token.
    case 'mcp-json':
    case 'gemini-cli':
      return JSON.stringify({ mcpServers: { [ENTRY_NAME]: { type: 'http', url: ctx.url, headers } } }, null, 2);
    case 'cursor':
    // Warp reads the portable shape, inferring HTTP from `url`.
    case 'warp':
      return JSON.stringify({ mcpServers: { [ENTRY_NAME]: { url: ctx.url, headers } } }, null, 2);
    // Antigravity is the odd one out: same `mcpServers` root, but the endpoint
    // key is `serverUrl`, and it rejects `url`/`httpUrl` outright.
    case 'antigravity':
      return JSON.stringify({ mcpServers: { [ENTRY_NAME]: { serverUrl: ctx.url, headers } } }, null, 2);
    case 'vscode':
      return JSON.stringify({ servers: { [ENTRY_NAME]: { type: 'http', url: ctx.url, headers } } }, null, 2);
    case 'openclaw':
      return JSON.stringify(
        {
          mcp: {
            servers: { [ENTRY_NAME]: { url: ctx.url, transport: 'streamable-http', headers } },
          },
        },
        null,
        2,
      );
    // Kotrain's mcpServers is an array of configs, each carrying its own bearer
    // token rather than a headers map — its own shape, not the portable one.
    case 'kotrain':
      return JSON.stringify(
        {
          mcpServers: [
            { id: ENTRY_NAME, name: 'Hypergate', command: '', args: [], url: ctx.url, token: ctx.token, enabled: true },
          ],
        },
        null,
        2,
      );
    // Hermes is the one YAML client we know; hand-built (no YAML dep in core),
    // and every value is quoted so a token starting with a digit stays a string.
    case 'hermes':
      return [
        'mcp_servers:',
        `  ${ENTRY_NAME}:`,
        `    url: "${ctx.url}"`,
        '    headers:',
        `      Authorization: "Bearer ${ctx.token}"`,
      ].join('\n');
    default:
      return undefined;
  }
};

/**
 * The URL that asks a `deeplink` client to connect itself to this gateway.
 *
 * Deliberately the whole payload: a port, and not one byte more. The client
 * takes it as "there is a gateway here" and goes and looks, reading the
 * daemon's version, its server count and its own scoped token back over
 * loopback before asking its user. A token in a URL would be a credential
 * handed through the OS's link handler on the word of whoever opened it.
 */
export const connectDeepLink = (id: string, ctx: ConnectContext): string | undefined => {
  if (id !== 'kotrain') return undefined;
  let port = '7777';
  try {
    port = new URL(ctx.url).port || port;
  } catch {
    /* a malformed gateway URL still gets the default, which is where it lives */
  }
  return `kotrain://hypergate/connect?port=${encodeURIComponent(port)}`;
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
 * run, that command quoted per shell, the config snippet to paste, or — for a
 * `manual` client — the endpoint and token to type into its settings.
 */
export const agentConnectTarget = (status: ConnectTargetStatus, ctx: ConnectContext): AgentConnectTarget => {
  const snippet = connectSnippet(status.id, ctx);
  if (status.method === 'manual') return { ...status, token: ctx.token, snippet };
  // A deep-link client still gets the snippet: the link needs the app to be
  // installed, and someone reading about it before installing should be able to
  // see exactly what it will do.
  if (status.method === 'deeplink') return { ...status, deepLink: connectDeepLink(status.id, ctx), snippet };
  if (status.method === 'cli') {
    const argv = connectArgv(status.id, ctx);
    if (!argv) return { ...status, snippet };
    return { ...status, argv: argv.add, commands: formatCommands(status.command ?? status.id, argv.add), snippet };
  }
  return { ...status, snippet };
};
