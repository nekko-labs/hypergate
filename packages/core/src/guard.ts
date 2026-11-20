/**
 * The secret guard: a vault key cannot leave through a tool call.
 *
 * Deterministic and narrow on purpose. It knows the exact values in the vault,
 * so it can say something true: a call whose arguments contain one of them is
 * refused before it reaches the server, and a result that contains one has it
 * replaced before the agent sees it. It does not claim to detect prompt
 * injection or every exfiltration path (an agent could still encode a key);
 * it closes the plain one, which is the one an injected instruction would use.
 */

/** Values shorter than this are too likely to occur by accident to act on. */
export const MIN_SECRET_LENGTH = 8;

export const REDACTED = '[redacted by Hypergate]';

export interface SecretRef {
  /** What to call it in a refusal or a log line; never the value. */
  label: string;
  value: string;
}

export interface SecretGuard {
  /** The label of the first vault secret found in `args`, or undefined. */
  findInArgs(args: unknown): string | undefined;
  /** `value` with every vault secret replaced by {@link REDACTED}; same shape. */
  redact<T>(value: T): T;
}

const usable = (secrets: SecretRef[]): SecretRef[] =>
  secrets
    .filter((s) => typeof s.value === 'string' && s.value.length >= MIN_SECRET_LENGTH)
    // Longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.value.length - a.value.length);

/** Every string inside a JSON-ish value (keys included: a key can be a carrier too). */
const strings = (v: unknown, out: string[] = [], depth = 0): string[] => {
  if (depth > 64) return out;
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out, depth + 1);
    }
  }
  return out;
};

const replaceAll = (s: string, secrets: SecretRef[]): string => {
  let r = s;
  for (const sec of secrets) if (r.includes(sec.value)) r = r.split(sec.value).join(REDACTED);
  return r;
};

const redactDeep = (v: unknown, secrets: SecretRef[], depth = 0): unknown => {
  if (depth > 64) return v;
  if (typeof v === 'string') return replaceAll(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets, depth + 1));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactDeep(x, secrets, depth + 1);
    return o;
  }
  return v;
};

/**
 * Build a guard over `load()`, which is called on every use so a credential
 * added or rolled a second ago is already covered.
 */
export const createSecretGuard = (load: () => SecretRef[]): SecretGuard => ({
  findInArgs(args) {
    const secrets = usable(load());
    if (!secrets.length) return undefined;
    const hay = strings(args);
    for (const sec of secrets) if (hay.some((s) => s.includes(sec.value))) return sec.label;
    return undefined;
  },
  redact<T>(value: T): T {
    const secrets = usable(load());
    if (!secrets.length) return value;
    return redactDeep(value, secrets) as T;
  },
});
