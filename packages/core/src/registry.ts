import type { RegistryEntry, PopularityMap } from '@hypergate/shared';

/**
 * GitHub's authorization server (`https://github.com/login/oauth`) publishes RFC
 * 8414 metadata with **no `registration_endpoint`**, so there is no dynamic client
 * registration to fall back on: browser sign-in only works against an OAuth App
 * somebody registered by hand. It also requires client authentication at the token
 * endpoint even with PKCE, so that app needs a secret as well as an id.
 *
 * Hypergate therefore walks the user through registering one, once — see
 * `oauthApp` below and `/api/oauth/app/:id` in the daemon.
 */
const githubOAuthNote = 'Browser sign-in needs a one-time GitHub OAuth app (Hypergate sets it up with you, about two minutes). A personal access token needs no setup at all.';

const githubOAuthApp = {
  registerUrl: 'https://github.com/settings/applications/new',
  secretRequired: true,
  docsUrl: 'https://docs.github.com/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app',
  hint: 'Name it anything (e.g. "Hypergate"), set the homepage to https://hypergate.app, and paste the callback URL below exactly as shown.',
};

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
    id: 'kotrain',
    name: 'Kotrain',
    description: "Drive this machine's Kotrain agent from any harness: chat, spin up sessions, and kick off training runs on your local model.",
    runtime: 'process',
    command: 'kotrain',
    args: ['mcp'],
    official: true,
    recommended: true,
    note: 'Requires the Kotrain CLI (`kotrain`) on PATH — check the CLIs section below.',
    homepage: 'https://github.com/nekko-labs/kotrain',
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
    description: 'Official GitHub MCP server: repos, issues, PRs, code, Actions, and more.',
    runtime: 'remote',
    command: '',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    auth: 'oauth',
    official: true,
    note: githubOAuthNote,
    oauthApp: githubOAuthApp,
    connections: [
      {
        id: 'oauth',
        label: 'Sign in with GitHub',
        description: 'Browser sign-in, scoped consent, nothing to paste. Needs a one-time OAuth app, which Hypergate sets up with you.',
        runtime: 'remote',
        command: '',
        url: 'https://api.githubcopilot.com/mcp/',
        transport: 'http',
        auth: 'oauth',
        note: githubOAuthNote,
        oauthApp: githubOAuthApp,
      },
      {
        id: 'token',
        label: 'API key or token',
        description: 'Paste a GitHub personal access token. Nothing to register.',
        runtime: 'remote',
        command: '',
        url: 'https://api.githubcopilot.com/mcp/',
        transport: 'http',
        auth: 'token',
        tokenLabel: 'GitHub personal access token',
        tokenUrl: 'https://github.com/settings/personal-access-tokens',
        note: 'Use a fine-grained or classic GitHub PAT. Grant the repository, organization, project, package, gist, notification, workflow, and Codespaces scopes your tools need.',
      },
      {
        id: 'local',
        label: 'Run locally',
        // GitHub's own server, not the npm reference one: that package
        // (`@modelcontextprotocol/server-github`) is marked "no longer supported"
        // on npm, and GitHub ships this image itself.
        description: "GitHub's own server image on this machine, over stdio. Needs Docker.",
        runtime: 'docker',
        command: '',
        image: 'ghcr.io/github/github-mcp-server',
        requires: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        note: 'Runs the official `ghcr.io/github/github-mcp-server` image with your token injected at launch. Needs Docker installed.',
      },
    ],
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Give an agent a real browser: navigate, click, fill forms, read the accessibility tree, screenshot. Runs locally, no account.',
    runtime: 'process',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    official: true,
    // Microsoft ships two ways to hand an agent a browser and they are not
    // interchangeable: the MCP server keeps a stateful session and streams page
    // state into the model's context, while the CLI writes it to disk and lets the
    // agent read what it needs (measured at a fraction of the tokens). The server
    // is the right answer for a harness that cannot run shell commands.
    note: 'Best for harnesses that can’t run shell commands. If yours can, the Playwright CLI does the same job for far fewer tokens (see the CLI tools section).',
    homepage: 'https://github.com/microsoft/playwright-mcp',
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
    // The reference fetch server is published to PyPI, not npm: there is no
    // `@modelcontextprotocol/server-fetch` package at all (this entry pointed at
    // one until v0.22.0, so adding it always failed).
    runtime: 'process',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    official: true,
    note: 'Python server — needs `uv`/`uvx` on PATH (see the CLI tools section).',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
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
    note: 'The reference Postgres server is marked "no longer supported" on npm; it still runs, but search the registry for a maintained alternative if you need one.',
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
export const RECOMMENDED_IDS: readonly string[] = ['kotrain', 'context7', 'supabase', 'linear', 'figma'];

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
