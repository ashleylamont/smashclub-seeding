import { matchParticipantName, matchPresentation } from '../lib/matchPresentation';
import { linkedFinalCaption } from '../lib/linkedFinalCaption';
import { poolKey, poolTitle, usesOpenPools } from '../lib/poolFlow';
import { CharacterIcons } from './CharacterIcons';
import type { LiveMatch } from '../lib/eventDisplay';
export function MatchCard({
  match,
  station,
  nextMatch,
  structure,
}: {
  match: LiveMatch;
  station?: string;
  nextMatch?: LiveMatch;
  structure?: string;
}) {
  const presentation = matchPresentation(match);
  const linked = linkedFinalCaption(match);
  const pool = poolKey(match);
  const redundantPoolCaption =
    pool &&
    match.poolIndex !== null &&
    usesOpenPools(structure) &&
    match.label === `Open pool ${match.poolIndex + 1}`;
  const caption = station || linked?.identifier || (redundantPoolCaption ? null : match.label);
  return (
    <article className={`event-match ${match.status === 'playing' ? 'is-playing' : ''}`}>
      <div className="event-match-meta">
        <span>
          {linked?.context ??
            (pool
              ? poolTitle(pool, structure, 'heading')
              : `${match.division} · ${match.stage === 'group' ? 'Pool —' : match.stage}`)}
        </span>
        {caption && <span>{caption}</span>}
      </div>
      {[
        {
          name: match.player1Name,
          characters: match.player1Characters,
          id: match.player1Id,
          score: match.score1,
        },
        {
          name: match.player2Name,
          characters: match.player2Characters,
          id: match.player2Id,
          score: match.score2,
        },
      ].map((p, i) => (
        <div
          className={`event-contender ${match.status === 'complete' && p.id && p.id === match.winnerId ? 'is-winner' : ''}`}
          key={i}
        >
          <span>
            {matchParticipantName(match, i === 0 ? 0 : 1)}
            <CharacterIcons slugs={p.characters ?? []} />
          </span>
          {presentation.showScores && <strong>{p.score ?? '—'}</strong>}
        </div>
      ))}
      {presentation.result && <p>{presentation.result}</p>}
      {nextMatch && (
        <p>
          Next: {nextMatch.label} · {matchPresentation(nextMatch).title}
        </p>
      )}
      {presentation.status && <span className="event-match-status">{presentation.status}</span>}
    </article>
  );
}
