import { describe, expect, it } from 'vitest';
import {
  TOKEN_PRINTERS,
  checkLockdownRun,
  defaultProgramsFor,
  isRefusedProgram,
  lockdownRunLine,
  normalisePrograms,
  programName,
  tokenPrinterFor,
} from './lockdown.js';
import { KNOWN_CLIS } from './clis.js';
import { CREDENTIAL_GUIDES } from './credentials.js';
import { GATEWAY_INSTRUCTIONS, gatewayInstructions } from './gateway.js';

const commandFor = (id: string): string | undefined => KNOWN_CLIS.find((c) => c.id === id)?.command;
const gh = { id: 'github', defaultPrograms: ['gh'] };
const fly = { id: 'fly', defaultPrograms: defaultProgramsFor(['flyctl'], commandFor) };

describe('program names', () => {
  it('takes the basename on POSIX and keeps case', () => {
    expect(programName('/opt/homebrew/bin/gh', 'darwin')).toBe('gh');
    expect(programName('/usr/bin/GH', 'linux')).toBe('GH');
    expect(programName('gh.exe', 'linux')).toBe('gh.exe');
  });

  it('strips executable extensions and folds case on Windows', () => {
    expect(programName('C:\\Program Files\\GitHub CLI\\GH.EXE', 'win32')).toBe('gh');
    expect(programName('C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd', 'win32')).toBe('npm');
  });

  it('normalises a user list to unique bare names', () => {
    expect(normalisePrograms(['gh', '/usr/bin/gh', ' git ', '', 3, 'a b'], 'linux')).toEqual(['gh', 'git']);
  });
});

describe('refused programs', () => {
  it('covers shells, interpreters and exec wrappers', () => {
    for (const p of ['sh', 'bash', 'zsh', 'fish', 'pwsh', 'cmd', 'env', 'xargs', 'sudo', 'node', 'bun', 'deno', 'ruby', 'perl', 'php', 'osascript', 'awk', 'npx']) {
      expect(isRefusedProgram(p), p).toBe(true);
    }
  });

  it('matches every python spelling', () => {
    for (const p of ['python', 'python3', 'python3.12', 'pythonw', 'py']) expect(isRefusedProgram(p), p).toBe(true);
  });

  it('leaves ordinary CLIs alone', () => {
    for (const p of ['gh', 'flyctl', 'fly', 'aws', 'vercel', 'wrangler', 'git', 'shasum']) expect(isRefusedProgram(p), p).toBe(false);
  });
});

describe('default programs', () => {
  it('maps a guide CLI id to its command plus vendor aliases', () => {
    expect(fly.defaultPrograms).toEqual(['flyctl', 'fly']);
    expect(defaultProgramsFor(['gh'], commandFor)).toEqual(['gh']);
    expect(defaultProgramsFor(undefined, commandFor)).toEqual([]);
    expect(defaultProgramsFor(['not-a-cli'], commandFor)).toEqual([]);
  });

  it('every guide CLI resolves to a curated command, and none defaults to an interpreter', () => {
    for (const g of CREDENTIAL_GUIDES) {
      for (const id of g.clis ?? []) expect(commandFor(id), `${g.service} → ${id}`).toBeDefined();
      for (const p of defaultProgramsFor(g.clis, commandFor)) expect(isRefusedProgram(p), `${g.service} → ${p}`).toBe(false);
    }
  });
});

describe('token printers', () => {
  it('catches the documented ones', () => {
    expect(tokenPrinterFor('gh', ['auth', 'token'])).toBeDefined();
    expect(tokenPrinterFor('gh', ['auth', 'token', '--hostname', 'github.com'])).toBeDefined();
    expect(tokenPrinterFor('gh', ['auth', 'status', '--show-token'])).toBeDefined();
    expect(tokenPrinterFor('gh', ['auth', 'status', '-t'])).toBeDefined();
    expect(tokenPrinterFor('gh', ['auth', 'git-credential', 'get'])).toBeDefined();
    expect(tokenPrinterFor('fly', ['auth', 'token'])).toBeDefined();
    expect(tokenPrinterFor('flyctl', ['tokens', 'create', 'deploy'])).toBeDefined();
    expect(tokenPrinterFor('npm', ['token', 'create'])).toBeDefined();
    expect(tokenPrinterFor('gcloud', ['auth', 'print-access-token'])).toBeDefined();
    expect(tokenPrinterFor('aws', ['--profile', 'x', 'configure', 'get', 'aws_secret_access_key'])).toBeDefined();
    expect(tokenPrinterFor('npm', ['exec', '--', 'sh'])).toBeDefined();
  });

  it('lets the ordinary invocations through', () => {
    expect(tokenPrinterFor('gh', ['auth', 'status'])).toBeUndefined();
    expect(tokenPrinterFor('gh', ['repo', 'list'])).toBeUndefined();
    expect(tokenPrinterFor('fly', ['deploy'])).toBeUndefined();
    expect(tokenPrinterFor('npm', ['publish'])).toBeUndefined();
    expect(tokenPrinterFor('npm', ['token', 'list'])).toBeUndefined();
    // Same words, different program.
    expect(tokenPrinterFor('vercel', ['auth', 'token'])).toBeUndefined();
  });

  it('every rule names at least one program and one word', () => {
    for (const r of TOKEN_PRINTERS) {
      expect(r.programs.length).toBeGreaterThan(0);
      expect(r.words.length).toBeGreaterThan(0);
      expect(r.what).not.toMatch(/\u2014/);
    }
  });
});

describe('checkLockdownRun', () => {
  it('needs the program', () => {
    const v = checkLockdownRun({ candidates: [gh] });
    expect(v).toMatchObject({ ok: false, status: 400, code: 'program_required' });
  });

  it('injects only the credentials bound to the program', () => {
    expect(checkLockdownRun({ program: '/opt/homebrew/bin/gh', args: ['repo', 'list'], candidates: [gh, fly], platform: 'darwin' })).toEqual({
      ok: true,
      ids: ['github'],
      program: 'gh',
    });
    expect(checkLockdownRun({ program: '/Users/me/.fly/bin/fly', args: ['deploy'], candidates: [gh, fly], platform: 'darwin' })).toEqual({
      ok: true,
      ids: ['fly'],
      program: 'fly',
    });
  });

  it('refuses an explicit credential that is not bound to the program, naming the fix', () => {
    const v = checkLockdownRun({ program: '/usr/bin/curl', requestedIds: ['github'], candidates: [gh], platform: 'linux' });
    expect(v).toMatchObject({ ok: false, status: 403, code: 'not_bound' });
    if (!v.ok) expect(v.error).toContain('hypergate cred programs github curl');
  });

  it('refuses a credential with no programs at all', () => {
    const v = checkLockdownRun({ program: '/usr/bin/curl', requestedIds: ['custom'], candidates: [{ id: 'custom' }], platform: 'linux' });
    expect(v).toMatchObject({ ok: false, code: 'not_bound' });
  });

  it('refuses shells and interpreters', () => {
    for (const p of ['/bin/sh', '/bin/bash', '/usr/bin/python3', '/usr/local/bin/node', '/usr/bin/env']) {
      const v = checkLockdownRun({ program: p, args: ['-c', 'env'], candidates: [gh], platform: 'linux' });
      expect(v, p).toMatchObject({ ok: false, status: 403, code: 'interpreter' });
      const explicit = checkLockdownRun({ program: p, requestedIds: ['github'], candidates: [gh], platform: 'linux' });
      expect(explicit, p).toMatchObject({ ok: false, code: 'interpreter' });
    }
  });

  it('a default binding never reaches an interpreter, an explicit one can', () => {
    const viaDefault = { id: 'odd', defaultPrograms: ['node'] };
    expect(checkLockdownRun({ program: '/usr/bin/node', candidates: [viaDefault], platform: 'linux' })).toMatchObject({ ok: false, code: 'interpreter' });
    const bound = { id: 'odd', programs: ['node'] };
    expect(checkLockdownRun({ program: '/usr/bin/node', candidates: [bound], platform: 'linux' })).toEqual({ ok: true, ids: ['odd'], program: 'node' });
  });

  it('an explicit binding replaces the default', () => {
    const rebound = { id: 'github', programs: ['git'], defaultPrograms: ['gh'] };
    expect(checkLockdownRun({ program: '/usr/bin/gh', candidates: [rebound], platform: 'linux' })).toEqual({ ok: true, ids: [], program: 'gh' });
    expect(checkLockdownRun({ program: '/usr/bin/git', candidates: [rebound], platform: 'linux' })).toEqual({ ok: true, ids: ['github'], program: 'git' });
  });

  it('refuses token printers before anything else', () => {
    const v = checkLockdownRun({ program: '/usr/bin/gh', args: ['auth', 'token'], candidates: [gh], platform: 'linux' });
    expect(v).toMatchObject({ ok: false, status: 403, code: 'token_printer' });
  });
});

describe('lockdown run line', () => {
  it('is the exact command, quoted only where a shell needs it', () => {
    expect(lockdownRunLine('github')).toBe('hypergate run --with github -- <command>');
    expect(lockdownRunLine('github', 'claude-code-a1b2')).toBe('hypergate run --agent claude-code-a1b2 --with github -- <command>');
    expect(lockdownRunLine("it's", 'my agent')).toBe(`hypergate run --agent 'my agent' --with 'it'\\''s' -- <command>`);
  });
});

describe('gateway instructions', () => {
  it('are unchanged outside lockdown', () => {
    expect(gatewayInstructions()).toBe(GATEWAY_INSTRUCTIONS);
    expect(gatewayInstructions({ lockdown: false })).toBe(GATEWAY_INSTRUCTIONS);
  });

  it('under lockdown never tell an agent to take a value, and rule out the workarounds', () => {
    const text = gatewayInstructions({ lockdown: true });
    expect(text).toContain('credential lockdown is on');
    expect(text).toContain('hypergate run --agent');
    expect(text).toContain('gh auth login');
    expect(text).toContain('.env');
    expect(text).not.toContain('get it as environment variables');
    expect(text).not.toContain('Fetch the key');
    // The CLI and server sections survive intact.
    expect(text).toContain('hypergate__cli_install_request');
    expect(text).toContain('hypergate__server_install_request');
    expect(text).not.toMatch(/\u2014/);
  });
});
