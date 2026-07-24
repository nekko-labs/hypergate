import type { CliTool } from '@nekko-mcp/shared';

/**
 * Command-line tools NekkoMCP knows about — the ones that MCP servers commonly
 * depend on (runtimes, package runners, the Docker engine, cloud CLIs used by
 * catalog servers). The CLIs section detects which are present so you know
 * whether a given server can run before you add it.
 *
 * This is pure data; the daemon does the PATH lookup + `--version` probe (IO).
 */
export const KNOWN_CLIS: CliTool[] = [
  // Runtimes & package runners (what most catalog servers spawn)
  { id: 'node', name: 'Node.js', command: 'node', category: 'runtime', description: 'JavaScript runtime — required by every `npx` MCP server.', homepage: 'https://nodejs.org', install: 'https://nodejs.org (or nvm/fnm/volta)' },
  { id: 'npx', name: 'npx', command: 'npx', category: 'package', description: 'Runs npm-packaged MCP servers (ships with Node.js).', homepage: 'https://docs.npmjs.com/cli/commands/npx', install: 'Comes with Node.js' },
  { id: 'npm', name: 'npm', command: 'npm', category: 'package', description: 'Node package manager (ships with Node.js).', homepage: 'https://www.npmjs.com', install: 'Comes with Node.js' },
  { id: 'bun', name: 'Bun', command: 'bun', category: 'runtime', description: 'Fast JS runtime; NekkoMCP itself runs under it.', homepage: 'https://bun.sh', install: 'https://bun.sh' },
  { id: 'deno', name: 'Deno', command: 'deno', category: 'runtime', description: 'Secure TypeScript/JS runtime used by some MCP servers.', homepage: 'https://deno.com', install: 'https://deno.com' },
  { id: 'python', name: 'Python', command: 'python', category: 'runtime', description: 'Python runtime — required by Python (uvx) MCP servers.', homepage: 'https://www.python.org', install: 'https://www.python.org/downloads/' },
  { id: 'uv', name: 'uv', command: 'uv', category: 'package', description: 'Fast Python package manager from Astral.', homepage: 'https://docs.astral.sh/uv/', install: 'https://docs.astral.sh/uv/getting-started/installation/' },
  { id: 'uvx', name: 'uvx', command: 'uvx', category: 'package', description: 'Runs Python-packaged MCP servers (e.g. AWS Labs); ships with uv.', homepage: 'https://docs.astral.sh/uv/', install: 'Comes with uv' },
  { id: 'pipx', name: 'pipx', command: 'pipx', category: 'package', description: 'Install/run Python CLI apps in isolated envs.', homepage: 'https://pipx.pypa.io', install: 'https://pipx.pypa.io/stable/installation/' },

  // Container engine (the Docker runtime)
  { id: 'docker', name: 'Docker', command: 'docker', category: 'container', description: "Container engine — powers NekkoMCP's opt-in Docker isolation and the GCP Toolbox entry.", homepage: 'https://www.docker.com', install: 'https://docs.docker.com/get-docker/' },

  // Version control
  { id: 'git', name: 'Git', command: 'git', category: 'vcs', description: 'Version control — needed to clone/build servers from source.', homepage: 'https://git-scm.com', install: 'https://git-scm.com/downloads' },
  { id: 'gh', name: 'GitHub CLI', command: 'gh', category: 'vcs', description: 'GitHub from the terminal (auth, PRs, issues).', homepage: 'https://cli.github.com', install: 'https://cli.github.com' },

  // Cloud CLIs used by catalog servers
  { id: 'flyctl', name: 'Fly CLI', command: 'flyctl', category: 'cloud', description: 'Fly.io CLI — required by the Fly.io catalog server.', homepage: 'https://fly.io/docs/flyctl/', install: 'https://fly.io/docs/flyctl/install/' },
  { id: 'wrangler', name: 'Wrangler', command: 'wrangler', category: 'cloud', description: 'Cloudflare Workers CLI.', homepage: 'https://developers.cloudflare.com/workers/wrangler/', install: 'npm i -g wrangler' },
  { id: 'vercel', name: 'Vercel CLI', command: 'vercel', category: 'cloud', description: 'Deploy and manage Vercel projects.', homepage: 'https://vercel.com/docs/cli', install: 'npm i -g vercel' },
  { id: 'supabase', name: 'Supabase CLI', command: 'supabase', category: 'cloud', description: 'Local Supabase dev + project management.', homepage: 'https://supabase.com/docs/guides/local-development', install: 'https://supabase.com/docs/guides/local-development' },
  { id: 'aws', name: 'AWS CLI', command: 'aws', category: 'cloud', description: 'Amazon Web Services CLI (auth/profiles for AWS servers).', homepage: 'https://aws.amazon.com/cli/', install: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html' },
  { id: 'az', name: 'Azure CLI', command: 'az', category: 'cloud', description: 'Microsoft Azure CLI — `az login` authenticates the Azure server.', homepage: 'https://learn.microsoft.com/cli/azure/', install: 'https://learn.microsoft.com/cli/azure/install-azure-cli' },
  { id: 'gcloud', name: 'Google Cloud CLI', command: 'gcloud', category: 'cloud', description: 'Google Cloud CLI (auth/config for GCP servers).', homepage: 'https://cloud.google.com/sdk/gcloud', install: 'https://cloud.google.com/sdk/docs/install' },

  // MCP / agent tooling
  { id: 'kotrain', name: 'Kotrain', command: 'kotrain', category: 'mcp', description: "Kotrain CLI — exposes this machine's local agent as an MCP server (`kotrain mcp`).", homepage: 'https://github.com/nekko-labs/kotrain', install: 'Build from github.com/nekko-labs/kotrain' },
  { id: 'nekko-vault-mcp', name: 'Nekko Vault MCP', command: 'nekko-vault-mcp', category: 'mcp', description: 'Nekko Notes vault as an MCP server (memory + RAG).', homepage: 'https://github.com/nekko-labs/nekko-notes', install: 'Ships with Nekko Notes' },
  { id: 'claude', name: 'Claude Code', command: 'claude', category: 'mcp', description: 'Anthropic Claude Code CLI — a first-class NekkoMCP gateway client.', homepage: 'https://docs.anthropic.com/en/docs/claude-code', install: 'npm i -g @anthropic-ai/claude-code' },
];

export const knownCli = (id: string): CliTool | undefined => KNOWN_CLIS.find((c) => c.id === id);
