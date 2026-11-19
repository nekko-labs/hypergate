import { isAbsolute, join, relative } from 'node:path';

/**
 * Agent instruction files: telling every harness how this machine works.
 *
 * The gateway already returns MCP `instructions` at `initialize`, but those
 * reach only a client that is connected to the gateway, and several harnesses
 * drop them on the floor. Every harness, connected or not, does read a *global*
 * instruction file at the start of each session (`~/.claude/CLAUDE.md`,
 * `~/.codex/AGENTS.md`, ...). So Hypergate offers to put a short block of its
 * own into each of those files: keys are in the vault, run CLIs through
 * `hypergate run`, never sign a CLI in or write a key down, and ask rather than
 * work around a refusal. It is a request, not enforcement, and it works the
 * same whichever model provider the harness talks to.
 *
 * Rules this module keeps:
 *   - **Only the block is ours.** It sits between stable markers, and every
 *     operation touches the text between them and nothing else. A file the user
 *     wrote stays byte-for-byte theirs outside the markers.
 *   - **Idempotent.** Installing twice is one block; installing a newer version
 *     replaces the older one in place.
 *   - **Never a secret.** The block names an agent *key* (the stable stem of the
 *     agent id) so its `hypergate run` line is concrete, and nothing else that
 *     identifies a caller. Keys are validated against a slug pattern, so a
 *     hostile agent name cannot smuggle text into someone's instructions.
 *   - **Verified paths only.** Each harness row cites the vendor page its path
 *     came from. A harness with no documented global file is listed as skipped
 *     with the reason, not guessed at.
 *
 * Everything here is pure: the daemon supplies the filesystem.
 */

/** The block version this build writes. Bump when the text changes meaningfully. */
export const INSTRUCTIONS_BLOCK_VERSION = 1;

const BEGIN_RE = /<!-- hypergate:begin v(\d+) -->/;
const END_MARK = '<!-- hypergate:end -->';

/** An agent key safe to print into someone's instructions. */
const SAFE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `key` when it is a plain slug, otherwise the fallback. */
export function safeAgentKey(key: string | undefined, fallback: string): string {
  const k = (key ?? '').trim().toLowerCase();
  return SAFE_KEY.test(k) ? k : fallback;
}

/**
 * The block itself, LF line endings, no trailing newline.
 *
 * Short on purpose: it is loaded into every session of every harness, so each
 * line has to name something an agent could not infer on its own.
 */
export function renderInstructionsBlock(agentKey: string): string {
  const key = safeAgentKey(agentKey, 'your-agent');
  return [
    `<!-- hypergate:begin v${INSTRUCTIONS_BLOCK_VERSION} -->`,
    '## Hypergate: keys, CLIs and MCP servers on this machine',
    '',
    'Hypergate (http://localhost:7777) manages the API keys, CLI logins and MCP servers agents use here. Follow these rules in every project:',
    '',
    `- Keys live in Hypergate's vault. Run a command that needs one as \`hypergate run --agent ${key} -- <command>\` (add \`--with <credential-id>\` to pick one), and use \`hypergate__credentials_list\` to see which ids exist. Never fetch a key's raw value to handle it yourself.`,
    '- Never write a key, token or password into a file, `.env`, shell rc file, config, commit or chat, and never `export SOME_API_KEY=...`.',
    '- Never sign a CLI in yourself (`gh auth login`, `aws configure`, `gcloud auth login`, `fly auth login`, `vercel login`, `npm login`, ...) and never ask the user to paste a key. If a key is missing or refused, request it with `hypergate__credential_request`, or tell the user which one to approve in Hypergate.',
    '- Need a CLI or MCP server that is not installed? Check `hypergate__clis_list` or `hypergate__server_resolve`, then ask with `hypergate__cli_install_request` or `hypergate__server_install_request`. Do not install it yourself.',
    "- If Hypergate's credential lockdown is on, refusals are expected. File a request and wait for approval instead of working around it.",
    '',
    'This block is managed by Hypergate; `hypergate instructions remove` takes it out. Edit outside the markers.',
    END_MARK,
  ].join('\n');
}

/** Where the block sits in a file, or why it cannot be found cleanly. */
export type BlockLocation =
  | { kind: 'absent' }
  | { kind: 'present'; start: number; end: number; version: number }
  /** A begin marker with no end after it: a hand edit went wrong. */
  | { kind: 'damaged' };

export function findInstructionsBlock(text: string): BlockLocation {
  const m = BEGIN_RE.exec(text);
  if (!m) return { kind: 'absent' };
  const endAt = text.indexOf(END_MARK, m.index);
  if (endAt === -1) return { kind: 'damaged' };
  return { kind: 'present', start: m.index, end: endAt + END_MARK.length, version: Number(m[1]) };
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');
const withEol = (block: string, eol: string): string => (eol === '\n' ? block : block.replace(/\n/g, eol));

export class DamagedInstructionsError extends Error {
  constructor() {
    super('found a Hypergate begin marker with no end marker; fix the file by hand, then try again');
    this.name = 'DamagedInstructionsError';
  }
}

/**
 * The file's text with exactly one current block. `undefined` means the file
 * does not exist yet. A block already present is replaced where it stands, so
 * a user who moved it to the top keeps it at the top.
 */
export function upsertInstructionsBlock(text: string | undefined, block: string): string {
  if (text === undefined || text.trim() === '') return `${block}\n`;
  const eol = eolOf(text);
  const b = withEol(block, eol);
  const loc = findInstructionsBlock(text);
  if (loc.kind === 'damaged') throw new DamagedInstructionsError();
  if (loc.kind === 'present') return text.slice(0, loc.start) + b + text.slice(loc.end);
  // Appended after one blank line, whatever the file ended with.
  const body = text.replace(/(\r?\n)*$/, '');
  return `${body}${eol}${eol}${b}${eol}`;
}

/**
 * The file's text without the block. Removes the blank line the install added
 * in front of it, so install then remove is a no-op on a file that ended
 * cleanly. Returns the input unchanged when there is no block.
 */
export function removeInstructionsBlock(text: string): string {
  const loc = findInstructionsBlock(text);
  if (loc.kind === 'damaged') throw new DamagedInstructionsError();
  if (loc.kind === 'absent') return text;
  const eol = eolOf(text);
  let before = text.slice(0, loc.start);
  let after = text.slice(loc.end);
  // Drop the newline that ended the block's own line.
  if (after.startsWith(eol)) after = after.slice(eol.length);
  else if (after.startsWith('\n')) after = after.slice(1);
  // Collapse the separating blank line the install put in front.
  if (after === '' && before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
  return before + after;
}

export interface InstructionsBlockStatus {
  installed: boolean;
  version?: number;
  /** Installed, this version, and identical to `expected`. */
  current: boolean;
  damaged?: boolean;
}

export function instructionsBlockStatus(text: string | undefined, expected: string): InstructionsBlockStatus {
  if (text === undefined) return { installed: false, current: false };
  const loc = findInstructionsBlock(text);
  if (loc.kind === 'damaged') return { installed: false, current: false, damaged: true };
  if (loc.kind === 'absent') return { installed: false, current: false };
  const found = text.slice(loc.start, loc.end).replace(/\r\n/g, '\n');
  return {
    installed: true,
    version: loc.version,
    current: loc.version === INSTRUCTIONS_BLOCK_VERSION && found === expected,
  };
}

// ── where each harness keeps its global instructions ────────────────────────

/** What a harness row needs from the machine. Injected so tests never touch a real home. */
export interface InstructionsContext {
  home: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** File text, or `undefined` when there is no such file. */
  read: (path: string) => string | undefined;
}

export interface InstructionsHarness {
  id: string;
  name: string;
  /** `CONNECT_TARGETS` ids this file serves. */
  targets: string[];
  /** Vendor documentation the path was verified against. */
  source: string;
  /** An env var that moves the harness's config home, honoured when set. */
  homeEnv?: string;
  /** Default config home, relative to the user's home directory. */
  defaultDir: string[];
  /** File name inside the config home. */
  file: string;
}

/**
 * The harnesses with a documented global instruction file. Paths are the same
 * on macOS, Linux and Windows (each tool resolves them under the user's home).
 */
export const INSTRUCTION_HARNESSES: InstructionsHarness[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    targets: ['claude-code'],
    // "User instructions: ~/.claude/CLAUDE.md". CLAUDE_CONFIG_DIR moves the
    // whole config directory: https://code.claude.com/docs/en/env-vars
    source: 'https://code.claude.com/docs/en/memory',
    homeEnv: 'CLAUDE_CONFIG_DIR',
    defaultDir: ['.claude'],
    file: 'CLAUDE.md',
  },
  {
    id: 'codex',
    name: 'Codex',
    targets: [],
    // "In your Codex home directory (defaults to ~/.codex, unless you set
    // CODEX_HOME)"; AGENTS.override.md wins when it is non-empty.
    source: 'https://developers.openai.com/codex/guides/agents-md',
    homeEnv: 'CODEX_HOME',
    defaultDir: ['.codex'],
    file: 'AGENTS.md',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI and Antigravity',
    targets: ['gemini-cli', 'antigravity'],
    // Gemini CLI: "Location: ~/.gemini/GEMINI.md". Antigravity lists the same
    // file among its global rules: https://antigravity.google/docs/rules
    source: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md',
    defaultDir: ['.gemini'],
    file: 'GEMINI.md',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    targets: [],
    // Global rules in ~/.config/opencode/AGENTS.md; without that file it reads
    // ~/.claude/CLAUDE.md instead.
    source: 'https://opencode.ai/docs/rules/',
    defaultDir: ['.config', 'opencode'],
    file: 'AGENTS.md',
  },
  {
    id: 'devin-desktop',
    name: 'Devin Desktop (Windsurf)',
    targets: [],
    // ".devin/global_rules.md: a single always-on file", which applies to
    // every project from the home directory.
    source: 'https://docs.devin.ai/desktop/cascade/memories',
    defaultDir: ['.devin'],
    file: 'global_rules.md',
  },
];

/** Harnesses Hypergate does not write to, and why. Shown so a gap is visible, not silent. */
export const INSTRUCTIONS_SKIPPED: { name: string; reason: string }[] = [
  {
    name: 'Cursor',
    reason:
      'User Rules live in Cursor Settings (synced with your account), not in a file. Copy the block into Cursor Settings > Rules.',
  },
  {
    name: 'VS Code (Copilot)',
    reason:
      'User instructions live in the VS Code profile. Agent Host sessions also read ~/.claude, which the Claude Code row covers.',
  },
  {
    name: 'Aider',
    reason: 'No global instruction file; conventions are loaded per project with `read:` in .aider.conf.yml.',
  },
  {
    name: 'Nekko Agent, Warp, Hermes, OpenClaw, Odysseus, Devin (cloud)',
    reason: 'No documented global instruction file. Connected through the gateway, they get its MCP instructions instead.',
  },
];

export const instructionsHarness = (id: string): InstructionsHarness | undefined =>
  INSTRUCTION_HARNESSES.find((h) => h.id === id);

/** A config-home override is honoured only as an absolute, existing directory under home. */
export function acceptableHome(dir: string | undefined, ctx: Pick<InstructionsContext, 'home' | 'exists'>): boolean {
  if (!dir || !isAbsolute(dir)) return false;
  const rel = relative(ctx.home, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  return ctx.exists(dir);
}

export interface ResolvedHarness {
  path: string;
  detected: boolean;
  note?: string;
}

/** Where this harness's file is on this machine, whether the harness is here, and anything worth saying. */
export function resolveHarness(h: InstructionsHarness, ctx: InstructionsContext): ResolvedHarness {
  const override = h.homeEnv ? ctx.env[h.homeEnv] : undefined;
  const dir = acceptableHome(override, ctx) ? (override as string) : join(ctx.home, ...h.defaultDir);
  let path = join(dir, h.file);
  const detected = ctx.exists(dir);
  let note: string | undefined;

  if (h.id === 'codex') {
    const override = ctx.read(join(dir, 'AGENTS.override.md'));
    if (override !== undefined && override.trim() !== '')
      note = 'AGENTS.override.md in the Codex home is non-empty, so Codex ignores AGENTS.md (and this block) while it exists.';
  }
  if (h.id === 'opencode' && !ctx.exists(path)) {
    // OpenCode falls back to Claude Code's file when it has none of its own.
    // Creating one would silently stop it reading the user's CLAUDE.md, so the
    // block goes where OpenCode actually reads today.
    const claude = resolveHarness(INSTRUCTION_HARNESSES[0], ctx).path;
    if (ctx.exists(claude)) {
      path = claude;
      note = 'OpenCode has no AGENTS.md of its own and reads the Claude Code file, so the block lives there.';
    }
  }
  if (h.id === 'gemini') note = 'One file serves both Gemini CLI and Antigravity.';
  return { path, detected, note };
}
