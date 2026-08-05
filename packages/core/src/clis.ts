import type { CliCatalogEntry, CliInstallOption, CliTool } from '@hypergate/shared';

/**
 * Command-line tools Hypergate knows about, hand-verified against each project's
 * own docs. Two jobs:
 *
 * 1. **Detection** — which of these is on this machine, so you know whether a
 *    given MCP server can run before you add it (runtimes, package runners, the
 *    Docker engine, the cloud CLIs the catalog's servers shell out to).
 * 2. **Installing** — the curated half of the CLI catalog. These sort ahead of
 *    anything looked up online (see cli-search.ts) because they are the only rows
 *    where "official" and "recommended" were checked by a person against the
 *    vendor's documentation.
 *
 * `official`/`publisher` say who distributes the tool; `recommended` marks the
 * short list worth having for agent work. This is pure data — the daemon does the
 * PATH lookup, the `--version` probe, and any network lookup.
 */

/** Curated tools, in a fixed order that puts the agent-facing ones first. */
export const KNOWN_CLIS: CliTool[] = [
  // ── Agent tooling (what an agent driving this machine actually reaches for) ──
  {
    id: 'playwright-cli',
    name: 'Playwright CLI',
    command: 'playwright-cli',
    category: 'testing',
    description: 'Drive a real browser from an agent: navigate, click, fill, assert, screenshot. Writes page state to disk instead of streaming it into the context window, which is why it costs a fraction of the tokens the MCP server does.',
    homepage: 'https://playwright.dev/agent-cli/introduction',
    install: 'npm install -g @playwright/cli@latest',
    official: true,
    recommended: true,
    publisher: 'Microsoft (Playwright)',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    category: 'mcp',
    description: "Anthropic's Claude Code CLI — a first-class Hypergate gateway client.",
    homepage: 'https://docs.anthropic.com/en/docs/claude-code',
    install: 'npm install -g @anthropic-ai/claude-code',
    official: true,
    recommended: true,
    publisher: 'Anthropic',
  },
  {
    id: 'kotrain',
    name: 'Kotrain',
    command: 'kotrain',
    category: 'mcp',
    description: "Kotrain CLI — exposes this machine's local agent as an MCP server (`kotrain mcp`).",
    homepage: 'https://github.com/nekko-labs/kotrain',
    install: 'Build from github.com/nekko-labs/kotrain',
    official: true,
    publisher: 'Nekko Labs',
  },
  {
    id: 'nekko-vault-mcp',
    name: 'Nekko Vault MCP',
    command: 'nekko-vault-mcp',
    category: 'mcp',
    description: 'Nekko Notes vault as an MCP server (memory + RAG).',
    homepage: 'https://github.com/nekko-labs/nekko-notes',
    install: 'Ships with Nekko Notes',
    official: true,
    publisher: 'Nekko Labs',
  },

  // ── Runtimes & package runners (what most catalog servers spawn) ────────────
  { id: 'node', name: 'Node.js', command: 'node', category: 'runtime', description: 'JavaScript runtime — required by every `npx` MCP server.', homepage: 'https://nodejs.org', install: 'https://nodejs.org (or nvm/fnm/volta)', official: true, recommended: true, publisher: 'OpenJS Foundation' },
  { id: 'npx', name: 'npx', command: 'npx', category: 'package', description: 'Runs npm-packaged MCP servers (ships with Node.js).', homepage: 'https://docs.npmjs.com/cli/commands/npx', install: 'Comes with Node.js', official: true, publisher: 'npm' },
  { id: 'npm', name: 'npm', command: 'npm', category: 'package', description: 'Node package manager (ships with Node.js).', homepage: 'https://www.npmjs.com', install: 'Comes with Node.js', official: true, publisher: 'npm' },
  { id: 'bun', name: 'Bun', command: 'bun', category: 'runtime', description: 'Fast JS runtime; Hypergate itself runs under it.', homepage: 'https://bun.sh', install: 'https://bun.sh', official: true, publisher: 'Oven' },
  { id: 'deno', name: 'Deno', command: 'deno', category: 'runtime', description: 'Secure TypeScript/JS runtime used by some MCP servers.', homepage: 'https://deno.com', install: 'https://deno.com', official: true, publisher: 'Deno Land' },
  { id: 'python', name: 'Python', command: 'python', category: 'runtime', description: 'Python runtime — required by Python (uvx) MCP servers.', homepage: 'https://www.python.org', install: 'https://www.python.org/downloads/', official: true, publisher: 'Python Software Foundation' },
  { id: 'uv', name: 'uv', command: 'uv', category: 'package', description: 'Fast Python package manager from Astral.', homepage: 'https://docs.astral.sh/uv/', install: 'https://docs.astral.sh/uv/getting-started/installation/', official: true, recommended: true, publisher: 'Astral' },
  { id: 'uvx', name: 'uvx', command: 'uvx', category: 'package', description: 'Runs Python-packaged MCP servers (e.g. AWS Labs); ships with uv.', homepage: 'https://docs.astral.sh/uv/', install: 'Comes with uv', official: true, publisher: 'Astral' },
  { id: 'pipx', name: 'pipx', command: 'pipx', category: 'package', description: 'Install/run Python CLI apps in isolated envs.', homepage: 'https://pipx.pypa.io', install: 'https://pipx.pypa.io/stable/installation/', official: true, publisher: 'PyPA' },

  // Container engine (the Docker runtime)
  { id: 'docker', name: 'Docker', command: 'docker', category: 'container', description: "Container engine — powers Hypergate's opt-in Docker isolation and the GCP Toolbox entry.", homepage: 'https://www.docker.com', install: 'https://docs.docker.com/get-docker/', official: true, publisher: 'Docker' },

  // Version control
  { id: 'git', name: 'Git', command: 'git', category: 'vcs', description: 'Version control — needed to clone/build servers from source.', homepage: 'https://git-scm.com', install: 'https://git-scm.com/downloads', official: true, publisher: 'Git' },
  { id: 'gh', name: 'GitHub CLI', command: 'gh', category: 'vcs', description: 'GitHub from the terminal (auth, PRs, issues).', homepage: 'https://cli.github.com', install: 'https://cli.github.com', official: true, publisher: 'GitHub' },

  // Cloud CLIs used by catalog servers
  { id: 'flyctl', name: 'Fly CLI', command: 'flyctl', category: 'cloud', description: 'Fly.io CLI — required by the Fly.io catalog server.', homepage: 'https://fly.io/docs/flyctl/', install: 'https://fly.io/docs/flyctl/install/', official: true, publisher: 'Fly.io' },
  { id: 'wrangler', name: 'Wrangler', command: 'wrangler', category: 'cloud', description: 'Cloudflare Workers CLI.', homepage: 'https://developers.cloudflare.com/workers/wrangler/', install: 'npm install -g wrangler', official: true, publisher: 'Cloudflare' },
  { id: 'vercel', name: 'Vercel CLI', command: 'vercel', category: 'cloud', description: 'Deploy and manage Vercel projects.', homepage: 'https://vercel.com/docs/cli', install: 'npm install -g vercel', official: true, publisher: 'Vercel' },
  { id: 'supabase', name: 'Supabase CLI', command: 'supabase', category: 'cloud', description: 'Local Supabase dev + project management.', homepage: 'https://supabase.com/docs/guides/local-development', install: 'https://supabase.com/docs/guides/local-development', official: true, publisher: 'Supabase' },
  { id: 'aws', name: 'AWS CLI', command: 'aws', category: 'cloud', description: 'Amazon Web Services CLI (auth/profiles for AWS servers).', homepage: 'https://aws.amazon.com/cli/', install: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html', official: true, publisher: 'AWS' },
  { id: 'az', name: 'Azure CLI', command: 'az', category: 'cloud', description: 'Microsoft Azure CLI — `az login` authenticates the Azure server.', homepage: 'https://learn.microsoft.com/cli/azure/', install: 'https://learn.microsoft.com/cli/azure/install-azure-cli', official: true, publisher: 'Microsoft' },
  { id: 'gcloud', name: 'Google Cloud CLI', command: 'gcloud', category: 'cloud', description: 'Google Cloud CLI (auth/config for GCP servers).', homepage: 'https://cloud.google.com/sdk/gcloud', install: 'https://cloud.google.com/sdk/docs/install', official: true, publisher: 'Google' },
];

export const knownCli = (id: string): CliTool | undefined => KNOWN_CLIS.find((c) => c.id === id);

/**
 * Extra install routes for curated tools, per platform. `install` on the entry is
 * the primary route (and stays the one the CLI prints); these are the alternatives
 * a given machine may prefer — a Windows user has no `brew`, and telling them to
 * open a download page when `winget` would do it is worse advice.
 *
 * Only commands taken from the vendor's own install docs belong here.
 */
const EXTRA_INSTALLS: Record<string, CliInstallOption[]> = {
  node: [
    { label: 'winget', command: 'winget install OpenJS.NodeJS.LTS', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install node', platforms: ['darwin', 'linux'] },
  ],
  bun: [
    { label: 'PowerShell', command: 'powershell -c "irm bun.sh/install.ps1 | iex"', platforms: ['win32'] },
    { label: 'shell', command: 'curl -fsSL https://bun.sh/install | bash', platforms: ['darwin', 'linux'] },
  ],
  deno: [
    { label: 'PowerShell', command: 'powershell -c "irm https://deno.land/install.ps1 | iex"', platforms: ['win32'] },
    { label: 'shell', command: 'curl -fsSL https://deno.land/install.sh | sh', platforms: ['darwin', 'linux'] },
  ],
  python: [
    { label: 'winget', command: 'winget install Python.Python.3.13', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install python', platforms: ['darwin', 'linux'] },
  ],
  uv: [
    { label: 'PowerShell', command: 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"', platforms: ['win32'] },
    { label: 'shell', command: 'curl -LsSf https://astral.sh/uv/install.sh | sh', platforms: ['darwin', 'linux'] },
    { label: 'Homebrew', command: 'brew install uv', platforms: ['darwin', 'linux'] },
  ],
  pipx: [{ label: 'Homebrew', command: 'brew install pipx', platforms: ['darwin', 'linux'] }],
  docker: [
    { label: 'winget', command: 'winget install Docker.DockerDesktop', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install --cask docker', platforms: ['darwin'] },
  ],
  git: [
    { label: 'winget', command: 'winget install Git.Git', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install git', platforms: ['darwin', 'linux'] },
  ],
  gh: [
    { label: 'winget', command: 'winget install GitHub.cli', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install gh', platforms: ['darwin', 'linux'] },
  ],
  flyctl: [
    { label: 'PowerShell', command: 'powershell -c "iwr https://fly.io/install.ps1 -useb | iex"', platforms: ['win32'] },
    { label: 'shell', command: 'curl -L https://fly.io/install.sh | sh', platforms: ['darwin', 'linux'] },
    { label: 'Homebrew', command: 'brew install flyctl', platforms: ['darwin', 'linux'] },
  ],
  aws: [
    { label: 'winget', command: 'winget install Amazon.AWSCLI', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install awscli', platforms: ['darwin', 'linux'] },
  ],
  az: [
    { label: 'winget', command: 'winget install Microsoft.AzureCLI', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install azure-cli', platforms: ['darwin', 'linux'] },
  ],
  gcloud: [{ label: 'Homebrew', command: 'brew install --cask google-cloud-sdk', platforms: ['darwin'] }],
  supabase: [
    { label: 'Scoop', command: 'scoop install supabase', platforms: ['win32'] },
    { label: 'Homebrew', command: 'brew install supabase/tap/supabase', platforms: ['darwin', 'linux'] },
  ],
};

/** npm packages the curated commands come from, so a lookup can de-duplicate them. */
const CURATED_PACKAGES: Record<string, string> = {
  'playwright-cli': '@playwright/cli',
  claude: '@anthropic-ai/claude-code',
  wrangler: 'wrangler',
  vercel: 'vercel',
};

/** Does the tool answer to this search text? Name, command, description, package. */
export const matchesCli = (tool: CliTool, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const pkg = CURATED_PACKAGES[tool.id] ?? '';
  return [tool.name, tool.command, tool.description, tool.id, pkg].some((field) => field.toLowerCase().includes(needle));
};

/**
 * A curated tool as a catalog entry, with the install routes that apply to this
 * platform first. `platform` is Node's `process.platform`; an unknown one simply
 * gets the primary route.
 */
export function cliCatalogEntry(tool: CliTool, platform?: string): CliCatalogEntry {
  const primary = tool.install?.trim();
  const isUrl = !!primary && /^https?:\/\//i.test(primary);
  const isCommand = !!primary && !isUrl && /^(npm|npx|pnpm|yarn|bun|brew|pipx|pip|winget|scoop|choco|apt|cargo|go|curl|powershell) /i.test(primary);
  const extras = (EXTRA_INSTALLS[tool.id] ?? []).filter((option) => !platform || !option.platforms || option.platforms.includes(platform));
  const installs: CliInstallOption[] = [
    ...(isCommand ? [{ label: primary!.split(' ')[0], command: primary! }] : []),
    ...extras,
    ...(isUrl ? [{ label: 'download', command: primary! }] : []),
  ];
  return {
    ...tool,
    channel: 'curated',
    package: CURATED_PACKAGES[tool.id],
    installs: installs.length > 0 ? installs : undefined,
  };
}

/** Hypergate's recommended tools, in display order, for the catalog's top rows. */
export const RECOMMENDED_CLI_IDS: readonly string[] = KNOWN_CLIS.filter((c) => c.recommended).map((c) => c.id);

/**
 * Order CLI results the way the UI shows them: recommended curated tools first,
 * then the rest of the curated set, then looked-up channels in the order the
 * source returned them (npm relevance, then Homebrew). Anything the maintainer
 * has deprecated sinks to the bottom whatever channel it came from — it is still
 * worth showing, since the user searched for it by name, but never as the answer.
 * Pure + unit-tested.
 */
export function sortCliCatalog(entries: CliCatalogEntry[]): CliCatalogEntry[] {
  const rank = (e: CliCatalogEntry): number => {
    if (e.deprecated) return 4;
    if (e.channel === 'curated') return e.recommended ? 0 : 1;
    return e.channel === 'npm' ? 2 : 3;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map((x) => x.entry);
}
