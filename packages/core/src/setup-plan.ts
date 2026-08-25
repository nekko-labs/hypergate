import type { CredentialGuide, RegistryEntry } from '@hypergate/shared';
import { CREDENTIAL_GUIDES } from './credential-catalog.js';
import { KNOWN_CLIS, knownCli } from './clis.js';
import { REGISTRY } from './registry.js';
import { registryConnections } from '@hypergate/shared';

/**
 * "What would it take to actually run this?" — the step between resolving a
 * server and adding it.
 *
 * The split this module exists to make explicit: **the registry tells you how to
 * run a server and almost nothing about how to authenticate it.** Measured on
 * the live registry, `com.microsoft/azure` declares zero `environmentVariables`
 * — not because it needs no credentials, but because it rides on whatever
 * `az login` already put on the machine. No metadata standard closes that gap,
 * so the auth half comes from Hypergate's own curated knowledge (the CLI
 * catalog, the credential guides, and the ambient-auth table below) and the
 * install half comes from the registry.
 *
 * Pure and unit-tested: callers pass in what they know about the machine
 * (what's on PATH, what's in the vault) and get back an ordered list of steps.
 * Nothing here touches the network, the filesystem, or a child process.
 */

/**
 * What kind of thing a step asks for.
 *
 * - `cli` — a command that must exist before the server can start.
 * - `credential` — a secret to store in the vault (the user pastes it once).
 * - `signin` — a browser OAuth flow Hypergate runs.
 * - `ambient` — a sign-in that belongs to a CLI, not to Hypergate: the server
 *   reads whatever credentials that tool already wrote. Nothing to paste.
 */
export type SetupStepKind = 'cli' | 'credential' | 'signin' | 'ambient';

export interface SetupStep {
  kind: SetupStepKind;
  /** Stable key for this step within the plan. */
  id: string;
  /** One line, written for the person deciding whether to approve it. */
  title: string;
  detail?: string;
  /** False when the server can run without it. */
  required: boolean;
  /** Whether this machine already meets it. */
  satisfied: boolean;
  /** `KNOWN_CLIS` id, on `cli` and `ambient` steps. */
  cliId?: string;
  /** The executable, or the sign-in command on an `ambient` step. */
  command?: string;
  /** Install hint for a missing CLI. */
  install?: string;
  /** Env var a `credential` step fills. */
  envVar?: string;
  /** The vendor's own instructions for getting that credential, when we have them. */
  guide?: CredentialGuide;
  /** Vault credential already satisfying this step. */
  credentialId?: string;
  /** Where to go: the create-token page, or the endpoint being signed into. */
  url?: string;
}

/** Everything standing between a resolved server and a running one. */
export interface SetupPlan {
  /** The server this plan is for. */
  entry: RegistryEntry;
  /** Ordered: runtimes first (nothing runs without them), then auth. */
  steps: SetupStep[];
  /** True when nothing required is outstanding. */
  ready: boolean;
  /** The steps still to do, for a caller that only wants the work. */
  outstanding: SetupStep[];
}

/** What the caller knows about this machine. Everything is optional. */
export interface SetupContext {
  /** Commands found on PATH (`['npx', 'node', 'az']`). */
  installedCommands?: string[];
  /** Curated CLI ids known to be signed in already. */
  signedInClis?: string[];
  /** Vault credentials, by the env var they are injected as. */
  storedCredentials?: { envVar: string; id: string }[];
}

/**
 * A server whose credentials come from a CLI's own login rather than from
 * anything Hypergate can store.
 *
 * This is curated on purpose. The registry cannot express it: a server that
 * authenticates through `az login` looks, in metadata, exactly like a server
 * that needs no authentication at all.
 */
export interface AmbientAuthRule {
  /** Curated entry ids and package identifiers this rule covers, matched exactly. */
  ids: string[];
  /** The `KNOWN_CLIS` id whose sign-in the server rides on. */
  cli: string;
  /** One sentence explaining why there is nothing to paste. */
  why: string;
}

export const AMBIENT_AUTH: AmbientAuthRule[] = [
  {
    ids: ['azure', 'com-microsoft-azure', '@azure/mcp', 'msmcp-azure', 'Azure.Mcp'],
    cli: 'az',
    why: 'The Azure server uses whatever credentials `az login` already put on this machine. Set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET instead to use a service principal.',
  },
  {
    ids: ['gcp-toolbox', 'us-central1-docker.pkg.dev/database-toolbox/toolbox/toolbox'],
    cli: 'gcloud',
    why: 'The MCP Toolbox reads your Google Cloud application-default credentials, which `gcloud auth login` writes.',
  },
  {
    ids: ['aws', 'awslabs.core-mcp-server'],
    cli: 'aws',
    why: 'AWS Labs servers read the shared AWS profile that `aws configure` writes; AWS_PROFILE picks which one.',
  },
];

/** Commands that run a package rather than being one. */
const PACKAGE_RUNNERS = new Set(['npx', 'npm', 'uvx', 'uv', 'bunx', 'pnpx']);

/**
 * The identifiers a server can be recognised by: its catalog id, its package
 * names with any version stripped, and its image without a tag.
 *
 * Deliberately *not* its homepage or description. Matching rules against free
 * text is how `advice.ts` once told every community server to go and use
 * GitHub's, because they all live on github.com.
 */
export function packageTokens(entry: RegistryEntry): string[] {
  const tokens: string[] = [entry.id];
  const strip = (spec: string): string => {
    // `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`.
    const at = spec.lastIndexOf('@');
    return at > 0 ? spec.slice(0, at) : spec;
  };
  const command = (entry.command ?? '').trim();
  if (PACKAGE_RUNNERS.has(command)) {
    // `npx -y <package> <subcommand>…` — only the first non-flag argument names
    // the package. Taking them all made Azure's `server start` collide with
    // Fly's `mcp server` and inherit its token requirement.
    const pkg = (entry.args ?? []).find((a) => !a.startsWith('-'));
    if (pkg) tokens.push(strip(pkg));
  } else if (command) {
    // A bare command is its own identity: `flyctl mcp server` is flyctl.
    tokens.push(command);
  }
  if (entry.image) tokens.push(entry.image.split(':')[0]);
  return tokens.filter(Boolean);
}

/**
 * Runners half the catalog shares. They identify nothing, so they must never
 * take part in matching: `npx` would otherwise match every npm server there is.
 */
const GENERIC_RUNNERS = new Set(['npx', 'npm', 'uvx', 'uv', 'bunx', 'node', 'python', 'python3', 'docker', '']);

/** Identifying tokens only — package names and ids, never a shared runner. */
const identityTokens = (entry: RegistryEntry): Set<string> =>
  new Set(packageTokens(entry).map((t) => t.toLowerCase()).filter((t) => !GENERIC_RUNNERS.has(t)));

/** The ambient-auth rule covering this server, if any. */
export function ambientAuthFor(entry: RegistryEntry): AmbientAuthRule | undefined {
  const tokens = identityTokens(entry);
  return AMBIENT_AUTH.find((rule) => rule.ids.some((id) => tokens.has(id.toLowerCase())));
}

/**
 * Credentials Hypergate knows a server needs but its registry entry does not
 * declare.
 *
 * `environmentVariables` is not a reliable statement of what a server requires:
 * measured on the live registry, both `com.microsoft/azure` and
 * `io.github.github/github-mcp-server` publish an empty list, and the GitHub
 * server does not work without a personal access token. The curated catalog
 * already carries that knowledge for the servers Hypergate ships, so a
 * registry-resolved entry borrows it when the packages match.
 */
export function curatedRequires(entry: RegistryEntry): string[] {
  const tokens = identityTokens(entry);
  if (!tokens.size) return [];
  const found = new Set<string>();
  for (const curated of REGISTRY) {
    // Check the entry and every connection it offers: GitHub's token
    // requirement lives on its `local` connection, not the top-level row.
    for (const variant of [curated, ...registryConnections(curated)]) {
      const variantEntry = { ...curated, ...variant } as RegistryEntry;
      const shared = [...identityTokens(variantEntry)].some((t) => tokens.has(t));
      if (!shared) continue;
      for (const env of variant.requires ?? []) found.add(env);
    }
  }
  return [...found];
}

/** The credential guide that fills a given env var, by canonical name or alias. */
const guideForEnvVar = (envVar: string): CredentialGuide | undefined => {
  const want = envVar.trim().toUpperCase();
  return CREDENTIAL_GUIDES.find((g) => g.envVar.toUpperCase() === want || g.aliases?.some((a) => a.toUpperCase() === want));
};

/**
 * The CLI a launch command depends on. `npx` and `uvx` are not the dependency —
 * the runtime that ships them is, and that is what a user has to install.
 */
const runtimeCliFor = (entry: RegistryEntry): string | undefined => {
  if (entry.runtime === 'docker') return 'docker';
  if (entry.runtime === 'remote') return undefined;
  const command = (entry.command ?? '').trim();
  if (!command) return undefined;
  if (command === 'npx' || command === 'npm') return 'node';
  if (command === 'uvx') return 'uv';
  // Anything else is its own tool: `flyctl mcp server` needs flyctl.
  return KNOWN_CLIS.find((c) => c.command === command)?.id ?? command;
};

/**
 * Work out everything standing between this entry and a running server.
 *
 * Order matters: a missing runtime blocks everything after it, so runtimes come
 * first and auth second. A step is `satisfied` when this machine already meets
 * it, which is what lets a caller show a plan and an "everything is ready"
 * state through the same shape.
 */
export function planSetup(entry: RegistryEntry, ctx: SetupContext = {}): SetupPlan {
  const onPath = new Set((ctx.installedCommands ?? []).map((c) => c.toLowerCase()));
  const signedIn = new Set((ctx.signedInClis ?? []).map((c) => c.toLowerCase()));
  const stored = new Map((ctx.storedCredentials ?? []).map((c) => [c.envVar.toUpperCase(), c.id]));
  const steps: SetupStep[] = [];

  // 1. The runtime the launch command needs.
  const runtimeId = runtimeCliFor(entry);
  if (runtimeId) {
    const tool = knownCli(runtimeId);
    const command = tool?.command ?? runtimeId;
    steps.push({
      kind: 'cli',
      id: `cli:${runtimeId}`,
      title: `Install ${tool?.name ?? runtimeId}`,
      detail: tool?.description,
      required: true,
      satisfied: onPath.has(command.toLowerCase()),
      cliId: runtimeId,
      command,
      install: tool?.install,
      url: tool?.homepage,
    });
  }

  // 2. Credentials the server needs — the ones it declares, plus the ones the
  //    curated catalog knows about when the registry entry under-declares.
  const declared = entry.requires ?? [];
  const required = [...new Set([...declared, ...curatedRequires(entry)])];
  for (const envVar of required) {
    const guide = guideForEnvVar(envVar);
    const credentialId = stored.get(envVar.toUpperCase());
    steps.push({
      kind: 'credential',
      id: `env:${envVar}`,
      title: guide ? `Add your ${guide.name}` : `Provide ${envVar}`,
      detail: guide?.note,
      required: true,
      satisfied: Boolean(credentialId),
      envVar,
      guide,
      credentialId,
      url: guide?.createUrl,
    });
  }

  // 3. A remote endpoint's own authentication.
  if (entry.runtime === 'remote') {
    if (entry.auth === 'token') {
      const label = entry.tokenLabel ?? `${entry.name} access token`;
      const credentialId = stored.get((entry.tokenLabel ?? '').toUpperCase());
      steps.push({
        kind: 'credential',
        id: `token:${entry.id}`,
        title: `Paste a ${label}`,
        required: true,
        satisfied: Boolean(credentialId),
        credentialId,
        url: entry.tokenUrl,
      });
    } else if (entry.auth !== 'none') {
      steps.push({
        kind: 'signin',
        id: `signin:${entry.id}`,
        title: `Sign in to ${entry.name}`,
        detail: entry.oauthApp
          ? 'Needs a one-time OAuth app, which Hypergate sets up with you.'
          : 'Opens the provider’s sign-in page; nothing to paste.',
        required: true,
        satisfied: false,
        url: entry.url,
      });
    }
  }

  // 4. Auth that belongs to a CLI, not to Hypergate. Checked last because it
  //    only makes sense once the tool it depends on is on the machine.
  const ambient = ambientAuthFor(entry);
  if (ambient) {
    const tool = knownCli(ambient.cli);
    const command = tool?.command ?? ambient.cli;
    const present = onPath.has(command.toLowerCase());
    if (!steps.some((s) => s.cliId === ambient.cli)) {
      steps.push({
        kind: 'cli',
        id: `cli:${ambient.cli}`,
        title: `Install ${tool?.name ?? ambient.cli}`,
        detail: tool?.description,
        required: true,
        satisfied: present,
        cliId: ambient.cli,
        command,
        install: tool?.install,
        url: tool?.homepage,
      });
    }
    steps.push({
      kind: 'ambient',
      id: `ambient:${ambient.cli}`,
      title: `Sign in with ${tool?.name ?? ambient.cli}`,
      detail: ambient.why,
      required: true,
      satisfied: present && signedIn.has(ambient.cli.toLowerCase()),
      cliId: ambient.cli,
      command: tool?.auth?.command ?? `${command} login`,
    });
  }

  const outstanding = steps.filter((s) => s.required && !s.satisfied);
  return { entry, steps, ready: outstanding.length === 0, outstanding };
}
