import type { RegistryEntry, PopularityMap } from '@hypergate/shared';

/**
 * Curated catalog of popular MCP servers users can add in one click. Process
 * commands assume the package is runnable via `npx`/`uvx`; `remote` entries
 * connect to a first-party hosted endpoint (usually one-click browser OAuth).
 * Users can override the runtime.
 *
 * `official` is hand-set from vendor docs (see the feature research in the
 * project memory); `recommended` marks Hypergate's suggested starting set, which
 * sorts first (see RECOMMENDED_IDS / sortRegistry).
 */
export const REGISTRY: RegistryEntry[] = [
  // ── Recommended set (sorts first, in RECOMMENDED_IDS order) ───────────────
  {
    id: 'nekkos',
    name: 'Nekkos',
    description: "Drive this machine's Nekkos agent from any harness: chat, spin up sessions, and kick off training runs on your local model.",
    runtime: 'process',
    command: 'nekkos',
    args: ['mcp'],
    official: true,
    recommended: true,
    note: 'Requires the Nekkos CLI (`nekkos`) on PATH — check the CLIs section below.',
    homepage: 'https://github.com/nekko-labs/nekkos',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date, version-specific docs and code examples for any library, injected into your prompts. One-click browser sign-in.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.context7.com/mcp/oauth',
    transport: 'http',
    auth: 'oauth',
    official: true,
    recommended: true,
    homepage: 'https://context7.com',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Manage your Supabase projects: query the database, inspect tables, run migrations, and read logs. Browser sign-in.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.supabase.com/mcp',
    transport: 'http',
    auth: 'oauth',
    official: true,
    recommended: true,
    homepage: 'https://github.com/supabase/mcp',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Read and manage Linear issues, projects, and cycles. One-click browser sign-in (dynamic client registration, zero config).',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.linear.app/mcp',
    transport: 'http',
    auth: 'oauth',
    official: true,
    recommended: true,
    homepage: 'https://linear.app/docs/mcp',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Pull design context, variables, and code from Figma files. Hosted server, works on any plan — browser sign-in.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.figma.com/mcp',
    transport: 'http',
    auth: 'oauth',
    official: true,
    recommended: true,
    homepage: 'https://developers.figma.com/docs/figma-mcp-server/',
  },

  // ── Other first-party servers ─────────────────────────────────────────────
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Manage Vercel projects and deployments, inspect logs and errors, query analytics, and search Vercel documentation. Browser sign-in.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.vercel.com',
    transport: 'http',
    auth: 'oauth',
    official: true,
    homepage: 'https://vercel.com/docs/agent-resources/vercel-mcp',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Official remote GitHub MCP server: repos, issues, PRs, code, Actions. Paste a GitHub personal access token.',
    runtime: 'remote',
    command: '',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    auth: 'token',
    official: true,
    tokenLabel: 'GitHub personal access token',
    tokenUrl: 'https://github.com/settings/personal-access-tokens',
    note: 'Use a fine-grained or classic GitHub PAT. Grant the repository, organization, project, package, gist, notification, workflow, and Codespaces scopes your tools need.',
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    description: 'Manage Cloudflare from your agent: Workers, DNS, R2, KV, and more. Browser sign-in.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.cloudflare.com/mcp',
    transport: 'http',
    auth: 'oauth',
    official: true,
    note: 'One of many Cloudflare servers (docs, bindings, observability, radar…). This is the main API server.',
    homepage: 'https://github.com/cloudflare/mcp-server-cloudflare',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    description: "Search Cloudflare's developer documentation. No account or sign-in required.",
    runtime: 'remote',
    command: '',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    transport: 'http',
    auth: 'none',
    official: true,
    homepage: 'https://developers.cloudflare.com/agents/model-context-protocol/',
  },
  {
    id: 'atlassian',
    name: 'Jira & Confluence',
    description: 'Atlassian Remote MCP (Rovo): Jira issues and Confluence pages, search, and updates. Browser sign-in.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.atlassian.com/v1/mcp',
    transport: 'http',
    auth: 'oauth',
    official: true,
    homepage: 'https://github.com/atlassian/atlassian-mcp-server',
  },
  {
    id: 'azure',
    name: 'Azure',
    description: 'Microsoft Azure: query and manage resources, storage, databases, monitoring, and more across your subscriptions.',
    runtime: 'process',
    command: 'npx',
    args: ['-y', '@azure/mcp@latest', 'server', 'start'],
    official: true,
    note: 'Signs in with the Azure CLI (`az login`), or set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET for a service principal.',
    homepage: 'https://github.com/microsoft/mcp',
  },
  {
    id: 'aws',
    name: 'AWS',
    description: 'AWS Labs core MCP server — foundational AWS tooling and a launcher for the wider AWS server suite.',
    runtime: 'process',
    command: 'uvx',
    args: ['awslabs.core-mcp-server@latest'],
    requires: ['AWS_PROFILE', 'AWS_REGION'],
    official: true,
    note: 'One of dozens of AWS Labs servers (cost-explorer, dynamodb, eks…). Needs `uv`/`uvx` on PATH; search the registry for the others.',
    homepage: 'https://github.com/awslabs/mcp',
  },
  {
    id: 'gcp-toolbox',
    name: 'GCP (MCP Toolbox)',
    description: "Google's MCP Toolbox for Databases: query BigQuery, Cloud SQL, AlloyDB, Spanner, Firestore, and more.",
    runtime: 'docker',
    command: '',
    image: 'us-central1-docker.pkg.dev/database-toolbox/toolbox/toolbox:latest',
    args: ['--prebuilt', 'bigquery', '--stdio'],
    official: true,
    note: 'Set --prebuilt to your source (bigquery, postgres, cloud-sql, spanner, firestore…) and provide GCP credentials. Needs Docker.',
    homepage: 'https://github.com/googleapis/mcp-toolbox',
  },
  {
    id: 'higgsfield',
    name: 'Higgsfield',
    description: 'Generate AI video and images with Higgsfield from your agent. One-click browser sign-in, no API keys.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.higgsfield.ai/mcp',
    transport: 'http',
    auth: 'oauth',
    official: true,
    homepage: 'https://higgsfield.ai/mcp',
  },
  {
    id: 'meta-ads',
    name: 'Meta Ads',
    description: 'Meta (Facebook / Instagram) Ads: campaigns, audiences, and performance insights. Business login.',
    runtime: 'remote',
    command: '',
    url: 'https://mcp.facebook.com/ads',
    transport: 'http',
    auth: 'oauth',
    official: true,
    homepage: 'https://developers.facebook.com/documentation/mcp',
  },
  {
    id: 'figma-devmode',
    name: 'Figma (Dev Mode, local)',
    description: "Figma's local Dev Mode server, served by the Figma desktop app on your machine. No sign-in, no data leaves localhost.",
    runtime: 'remote',
    command: '',
    url: 'http://127.0.0.1:3845/mcp',
    transport: 'http',
    auth: 'none',
    official: true,
    note: 'Requires the Figma desktop app with Preferences → "Enable Dev Mode MCP server" turned on.',
    homepage: 'https://developers.figma.com/docs/figma-mcp-server/local-server-installation/',
  },

  // ── Reference servers (modelcontextprotocol/servers) + local staples ──────
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read/write files under allowed directories.',
    runtime: 'process',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    requires: ['ALLOWED_DIR'],
    official: true,
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch a URL and return its content as Markdown.',
    runtime: 'process',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    official: true,
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'postgres',
    name: 'Postgres',
    description: 'Read-only SQL access to a Postgres database.',
    runtime: 'process',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    requires: ['DATABASE_URL'],
    official: true,
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'github-pat',
    name: 'GitHub (token)',
    description: 'Local GitHub server via a personal access token — the offline/self-hosted alternative to the OAuth entry.',
    runtime: 'process',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requires: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    official: true,
    homepage: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'fly',
    name: 'Fly.io',
    description: 'Deploy and manage Fly.io apps: status, logs, secrets, machines, scaling, and releases.',
    runtime: 'process',
    command: 'flyctl',
    args: ['mcp', 'server'],
    requires: ['FLY_API_TOKEN'],
    official: true,
    note: 'Requires the Fly CLI (`flyctl`) on PATH — check the CLIs section below.',
    homepage: 'https://fly.io/docs/flyctl/mcp/',
  },
  {
    id: 'nekko-vault',
    name: 'Nekko Vault',
    description: 'Your Nekko Notes vault as agent memory + RAG (list/search/read/create notes).',
    runtime: 'process',
    command: 'nekko-vault-mcp',
    requires: ['NEKKO_VAULT'],
    official: true,
    homepage: 'https://github.com/nekko-labs/nekko-notes',
  },
];

export const registryEntry = (id: string): RegistryEntry | undefined => REGISTRY.find((e) => e.id === id);

/**
 * Hypergate's recommended starting set, in display order. These sort to the top
 * of the catalog ahead of everything else (which is then ordered by popularity).
 */
export const RECOMMENDED_IDS: readonly string[] = ['nekkos', 'context7', 'supabase', 'linear', 'figma'];

/**
 * Order the catalog the way the UI shows it: the recommended set first (in
 * RECOMMENDED_IDS order), then the rest by popularity descending (from the
 * lazily-fetched `popularity` map, falling back to an entry's own `popularity`),
 * then a stable fallback to the input order. Pure + unit-tested.
 */
export function sortRegistry(entries: RegistryEntry[], popularity: PopularityMap = {}): RegistryEntry[] {
  const recRank = new Map(RECOMMENDED_IDS.map((id, i) => [id, i]));
  const score = (e: RegistryEntry): number => popularity[e.id] ?? e.popularity ?? -1;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ra = recRank.has(a.entry.id) ? recRank.get(a.entry.id)! : Infinity;
      const rb = recRank.has(b.entry.id) ? recRank.get(b.entry.id)! : Infinity;
      if (ra !== rb) return ra - rb; // recommended set first, in fixed order
      if (ra === Infinity) {
        const diff = score(b.entry) - score(a.entry); // popularity desc
        if (diff !== 0) return diff;
      }
      return a.index - b.index; // stable fallback to input order
    })
    .map((x) => x.entry);
}
