import { describe, it, expect } from 'vitest';
import { planSetup, ambientAuthFor, packageTokens, curatedRequires } from './setup-plan.js';
import type { RegistryEntry } from '@hypergate/shared';

const azure: RegistryEntry = {
  id: 'com-microsoft-azure',
  name: 'Azure',
  description: '',
  runtime: 'process',
  command: 'npx',
  args: ['-y', '@azure/mcp@2.0.2', 'server', 'start'],
  source: 'registry',
};

describe('packageTokens', () => {
  it('strips versions off package specs so a pinned entry still matches', () => {
    expect(packageTokens(azure)).toContain('@azure/mcp');
    expect(packageTokens(azure)).toContain('com-microsoft-azure');
  });

  it('strips the tag off a docker image', () => {
    const e = { ...azure, runtime: 'docker' as const, command: '', args: [], image: 'ghcr.io/github/github-mcp-server:1.10.1' };
    expect(packageTokens(e)).toContain('ghcr.io/github/github-mcp-server');
  });

  it('does not mine free text for tokens', () => {
    // advice.ts learned this the hard way: matching homepages made every
    // community server claim to be GitHub's.
    const e = { ...azure, homepage: 'https://github.com/microsoft/mcp', description: 'azure aws gcloud' };
    expect(packageTokens(e)).not.toContain('github.com/microsoft/mcp');
    expect(packageTokens(e)).not.toContain('aws');
  });
});

describe('ambientAuthFor', () => {
  it('knows the Azure server signs in through the Azure CLI', () => {
    // The registry declares zero environmentVariables for this server: it says
    // exactly how to run it and nothing at all about authenticating it.
    const rule = ambientAuthFor(azure);
    expect(rule?.cli).toBe('az');
  });

  it('matches the same server resolved under any of its package names', () => {
    expect(ambientAuthFor({ ...azure, args: ['-y', 'msmcp-azure'] })?.cli).toBe('az');
    expect(ambientAuthFor({ ...azure, id: 'azure', args: [] })?.cli).toBe('az');
  });

  it('has no opinion about an unrelated server', () => {
    expect(ambientAuthFor({ ...azure, id: 'weather', args: ['-y', '@acme/weather'] })).toBeUndefined();
  });
});

describe('planSetup', () => {
  it('asks for the runtime a command needs before anything else', () => {
    const plan = planSetup(azure, { installedCommands: [] });
    expect(plan.steps[0].kind).toBe('cli');
    expect(plan.steps[0].cliId).toBe('node');
    expect(plan.steps[0].satisfied).toBe(false);
  });

  it('marks the runtime satisfied when it is already on PATH', () => {
    const plan = planSetup(azure, { installedCommands: ['npx', 'node', 'az'] });
    expect(plan.steps.find((s) => s.cliId === 'node')?.satisfied).toBe(true);
  });

  it('splits install from auth: Azure needs the az CLI and a login, not a key', () => {
    const plan = planSetup(azure, { installedCommands: ['npx', 'node'] });
    const ambient = plan.steps.find((s) => s.kind === 'ambient');
    expect(ambient).toBeDefined();
    expect(ambient?.cliId).toBe('az');
    expect(ambient?.command).toBe('az login');
    // Nothing to paste — this is the whole point of the ambient case.
    expect(plan.steps.some((s) => s.kind === 'credential')).toBe(false);
  });

  it('does not ask for a login when the CLI is present and signed in', () => {
    const plan = planSetup(azure, { installedCommands: ['npx', 'node', 'az'], signedInClis: ['az'] });
    expect(plan.steps.some((s) => s.kind === 'ambient' && !s.satisfied)).toBe(false);
    expect(plan.ready).toBe(true);
  });

  it('turns a declared env var into a credential step with the vendor’s own link', () => {
    const e: RegistryEntry = { ...azure, id: 'x', args: ['-y', '@x/y'], requires: ['ANTHROPIC_API_KEY'] };
    const plan = planSetup(e, { installedCommands: ['npx', 'node'] });
    const cred = plan.steps.find((s) => s.kind === 'credential');
    expect(cred?.envVar).toBe('ANTHROPIC_API_KEY');
    expect(cred?.guide?.createUrl).toBe('https://console.anthropic.com/settings/keys');
    expect(cred?.satisfied).toBe(false);
  });

  it('satisfies a credential step from the vault instead of prompting again', () => {
    const e: RegistryEntry = { ...azure, id: 'x', args: ['-y', '@x/y'], requires: ['ANTHROPIC_API_KEY'] };
    const plan = planSetup(e, { installedCommands: ['npx', 'node'], storedCredentials: [{ envVar: 'ANTHROPIC_API_KEY', id: 'cred-1' }] });
    const cred = plan.steps.find((s) => s.kind === 'credential');
    expect(cred?.satisfied).toBe(true);
    expect(cred?.credentialId).toBe('cred-1');
    expect(plan.ready).toBe(true);
  });

  it('still asks for an env var it has no guide for', () => {
    const e: RegistryEntry = { ...azure, id: 'x', args: ['-y', '@x/y'], requires: ['WEIRD_PRIVATE_TOKEN'] };
    const cred = planSetup(e, { installedCommands: ['npx', 'node'] }).steps.find((s) => s.kind === 'credential');
    expect(cred?.envVar).toBe('WEIRD_PRIVATE_TOKEN');
    expect(cred?.guide).toBeUndefined();
  });

  it('plans a browser sign-in for a remote oauth server and needs no runtime', () => {
    const e: RegistryEntry = { id: 'linear', name: 'Linear', description: '', runtime: 'remote', command: '', url: 'https://mcp.linear.app/mcp', transport: 'http', auth: 'oauth' };
    const plan = planSetup(e, { installedCommands: [] });
    expect(plan.steps.map((s) => s.kind)).toEqual(['signin']);
    expect(plan.steps[0].url).toBe('https://mcp.linear.app/mcp');
  });

  it('plans a pasted token for a remote token server', () => {
    const e: RegistryEntry = { id: 'gh', name: 'GitHub', description: '', runtime: 'remote', command: '', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', tokenLabel: 'GitHub personal access token', tokenUrl: 'https://github.com/settings/personal-access-tokens' };
    const step = planSetup(e, {}).steps[0];
    expect(step.kind).toBe('credential');
    expect(step.title).toContain('GitHub personal access token');
    expect(step.url).toBe('https://github.com/settings/personal-access-tokens');
  });

  it('needs nothing at all for an unauthenticated remote server', () => {
    const e: RegistryEntry = { id: 'docs', name: 'Docs', description: '', runtime: 'remote', command: '', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none' };
    const plan = planSetup(e, {});
    expect(plan.steps).toEqual([]);
    expect(plan.ready).toBe(true);
  });

  it('asks for Docker for a docker-runtime server', () => {
    const e: RegistryEntry = { id: 'g', name: 'G', description: '', runtime: 'docker', command: '', image: 'ghcr.io/x/y:1' };
    expect(planSetup(e, { installedCommands: [] }).steps[0].cliId).toBe('docker');
  });

  it('asks for uv for a uvx server', () => {
    const e: RegistryEntry = { id: 'f', name: 'F', description: '', runtime: 'process', command: 'uvx', args: ['mcp-server-fetch'] };
    expect(planSetup(e, { installedCommands: [] }).steps[0].cliId).toBe('uv');
  });

  it('asks for a bare command that is its own CLI', () => {
    const e: RegistryEntry = { id: 'fly', name: 'Fly', description: '', runtime: 'process', command: 'flyctl', args: ['mcp', 'server'] };
    const step = planSetup(e, { installedCommands: [] }).steps[0];
    expect(step.cliId).toBe('flyctl');
    expect(step.install).toBeTruthy();
  });

  it('reports ready only when every required step is satisfied', () => {
    expect(planSetup(azure, { installedCommands: [] }).ready).toBe(false);
    expect(planSetup(azure, { installedCommands: ['npx', 'node', 'az'], signedInClis: ['az'] }).ready).toBe(true);
  });
});

describe('curatedRequires', () => {
  it('supplies the token GitHub’s own registry entry forgets to declare', () => {
    // Measured: io.github.github/github-mcp-server publishes zero
    // environmentVariables, but the server does not work without a PAT.
    // Hypergate's curated catalog already knows; the plan should ask it.
    const e: RegistryEntry = {
      id: 'io-github-github-github-mcp-server',
      name: 'github-mcp-server',
      description: '',
      runtime: 'docker',
      command: '',
      image: 'ghcr.io/github/github-mcp-server:1.10.1',
      source: 'registry',
    };
    expect(curatedRequires(e)).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
  });

  it('does not let a shared subcommand leak another server’s credentials in', () => {
    // Azure's `server start` and Fly's `mcp server` share the token "server".
    // Matching on every argument made Azure demand a FLY_API_TOKEN.
    expect(curatedRequires(azure)).toEqual([]);
    expect(planSetup(azure, { installedCommands: ['npx', 'node', 'az'], signedInClis: ['az'] }).steps.some((s) => s.envVar === 'FLY_API_TOKEN')).toBe(false);
  });

  it('does not match on a generic runner shared by half the catalog', () => {
    const e: RegistryEntry = { id: 'anything', name: 'A', description: '', runtime: 'process', command: 'npx', args: ['-y', '@nobody/unheard-of'] };
    expect(curatedRequires(e)).toEqual([]);
  });

  it('folds those requirements into the plan as credential steps', () => {
    const e: RegistryEntry = {
      id: 'io-github-github-github-mcp-server',
      name: 'github-mcp-server',
      description: '',
      runtime: 'docker',
      command: '',
      image: 'ghcr.io/github/github-mcp-server:1.10.1',
      source: 'registry',
    };
    const plan = planSetup(e, { installedCommands: ['docker'] });
    const cred = plan.steps.find((s) => s.kind === 'credential');
    expect(cred?.envVar).toBe('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(plan.ready).toBe(false);
  });

  it('does not double up when the registry declared the var itself', () => {
    const e: RegistryEntry = {
      id: 'io-github-github-github-mcp-server',
      name: 'github-mcp-server',
      description: '',
      runtime: 'docker',
      command: '',
      image: 'ghcr.io/github/github-mcp-server:1.10.1',
      requires: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      source: 'registry',
    };
    const creds = planSetup(e, { installedCommands: ['docker'] }).steps.filter((s) => s.kind === 'credential');
    expect(creds).toHaveLength(1);
  });
});
