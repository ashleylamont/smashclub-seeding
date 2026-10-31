import { matchParticipantName, matchPresentation } from '../lib/matchPresentation';
import { CharacterIcons } from './CharacterIcons';
import type { LiveMatch } from '../lib/eventDisplay';
export function MatchCard({
  match,
  station,
  nextMatch,
}: {
  match: LiveMatch;
  station?: string;
  nextMatch?: LiveMatch;
}) {
  const presentation = matchPresentation(match);
  return (
    <article className={`event-match ${match.status === 'playing' ? 'is-playing' : ''}`}>
      <div className="event-match-meta">
        <span>
          {match.division} ·{' '}
          {match.stage === 'group'
            ? `Pool ${match.poolIndex === null ? '—' : String.fromCharCode(65 + match.poolIndex)}`
            : match.stage}
        </span>
        <span>{station || match.label}</span>
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
