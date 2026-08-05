import type { Advice } from '@hypergate/shared';

/**
 * "Is this the right one?", answered directly under the row it is about.
 *
 * A search box that returns twenty things called `github` and says nothing about
 * any of them leaves the hardest question to the person least equipped to answer
 * it. This is that answer in one sentence, plus — when the answer is "not this
 * one" — the thing the provider actually recommends, as something you can act on.
 *
 * The verb comes from the verdict, not the caller: a `superseded` or `deprecated`
 * result says **use instead**, while an official row that has a sibling worth
 * knowing about says **also consider**. Same shape, honest strength.
 */
export function AdviceNote({
  advice,
  onPrefer,
}: {
  advice?: Advice;
  /** Act on the recommendation (switch to the entry, or copy its install). */
  onPrefer?: (advice: Advice) => void;
}) {
  if (!advice) return null;
  const redirecting = advice.kind === 'superseded' || advice.kind === 'deprecated';
  const prefer = advice.prefer;
  return (
    <div className={`advice advice-${advice.kind}`}>
      <span className="advice-ic" aria-hidden="true">{GLYPH[advice.kind]}</span>
      <span className="advice-body">
        <span className="advice-label">{LABEL[advice.kind]}</span>
        <span className="advice-msg">{advice.message}</span>
        {prefer && (
          <span className="advice-prefer">
            {redirecting ? 'Use instead:' : 'Also consider:'}{' '}
            {prefer.url ? (
              <a href={prefer.url} target="_blank" rel="noreferrer">{prefer.name}</a>
            ) : (
              <b>{prefer.name}</b>
            )}
            {onPrefer && (
              <button className="btn sm btn-ghost" onClick={() => onPrefer(advice)}>
                {prefer.kind === 'cli' ? (prefer.install ? 'Copy install' : 'Show it') : 'Switch to it'}
              </button>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

const LABEL: Record<Advice['kind'], string> = {
  recommended: 'Recommended',
  official: 'Official',
  verified: 'Verified publisher',
  superseded: 'Not the recommended route',
  deprecated: 'Deprecated',
  community: 'Community',
  unverified: 'Unverified',
};

const GLYPH: Record<Advice['kind'], string> = {
  recommended: '★',
  official: '✓',
  verified: '◑',
  // Placed here so the two "we know less than Official" kinds read as a pair.
  superseded: '↪',
  deprecated: '⚠',
  community: '👥',
  unverified: '?',
};
