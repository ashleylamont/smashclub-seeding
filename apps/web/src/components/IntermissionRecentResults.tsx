import { useEffect, useId, useState } from 'react';
import { characterName, isCharacterSlug } from '@smashclub/shared';
import type { LiveMatch } from '../lib/eventDisplay';
import { linkedFinalCaption } from '../lib/linkedFinalCaption';
import { matchParticipantName, matchPresentation } from '../lib/matchPresentation';
import { FIGHTER_ART_CREDIT } from '../lib/resultGraphic';
import './IntermissionRecentResults.css';

const sides = [0, 1] as const;

function mainCharacter(match: LiveMatch, side: 0 | 1) {
  const id = side === 0 ? match.player1Id : match.player2Id;
  const slug = (side === 0 ? match.player1Characters : match.player2Characters)?.[0];
  return id && slug && isCharacterSlug(slug) ? slug : undefined;
}

/** Art is an optional decoration. Reveal it only after the exact local asset decodes. */
function useMainPortraits(slugKey: string) {
  const [portraits, setPortraits] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!slugKey) return;
    let current = true;
    void import('../lib/resultGraphicBundledArt')
      .then(async ({ bundledResultPortraitUrl }) => {
        const images = await Promise.all(
          slugKey.split(',').map(async (slug) => {
            const url = bundledResultPortraitUrl(slug);
            if (!url || !current || new URL(url, location.href).origin !== location.origin) return;
            const image = new Image();
            image.src = url;
            try {
              await image.decode();
              return [slug, url] as const;
            } catch {
              return undefined;
            }
          }),
        );
        if (current)
          setPortraits(Object.fromEntries(images.filter((image) => image !== undefined)));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [slugKey]);
  return portraits;
}

export function IntermissionRecentResults({ matches }: { matches: readonly LiveMatch[] }) {
  const heading = useId();
  const results = matches.filter(({ status }) => status === 'complete').slice(0, 2);
  const cards = results.map((match) => {
    const result = matchPresentation(match, true);
    const winnerKnown = Boolean(
      match.winnerId && [match.player1Id, match.player2Id].includes(match.winnerId),
    );
    const players = sides.flatMap((side) => {
      const id = side === 0 ? match.player1Id : match.player2Id;
      if (!id || (result.kind === 'bye' && match.winnerId && id !== match.winnerId)) return [];
      const score = side === 0 ? match.score1 : match.score2;
      return [
        {
          side,
          name: matchParticipantName(match, side),
          winner: id === match.winnerId,
          score:
            result.showScores && score !== null && Number.isInteger(score) && score >= 0
              ? score
              : null,
          main: mainCharacter(match, side),
        },
      ];
    });
    const status =
      result.kind === 'played'
        ? players.some(({ score }) => score !== null)
          ? null
          : 'Result recorded'
        : result.status;
    return { match, result, players, winnerKnown, status };
  });
  const slugs = [
    ...new Set(cards.flatMap(({ players }) => players.flatMap(({ main }) => (main ? [main] : [])))),
  ].sort();
  const portraits = useMainPortraits(slugs.join(','));
  const hasArt = slugs.some((slug) => portraits[slug]);
  return (
    <section className="intermission-recent" aria-labelledby={heading}>
      <h2 id={heading}>Recent results</h2>
      {cards.length ? (
        <div className="intermission-recent-cards" data-count={cards.length}>
          {cards.map(({ match, result, players, winnerKnown, status }) => (
            <article
              className="intermission-recent-card"
              key={match.id}
              data-match-id={match.id}
              data-long-names={players.some(({ name }) => name.length > 90) || undefined}
            >
              <header>
                <h3>{linkedFinalCaption(match)?.text ?? match.label}</h3>
                {status && <strong>{status}</strong>}
              </header>
              {players.length > 0 && (
                <div className="intermission-recent-players" data-count={players.length}>
                  {players.map(({ side, name, winner, score, main }) => (
                    <div
                      className="intermission-recent-fighter"
                      data-winner={winner || undefined}
                      key={side}
                    >
                      {players.some((player) => player.main && portraits[player.main]) && (
                        <div className="intermission-recent-art">
                          {main && portraits[main] && (
                            <>
                              <img src={portraits[main]} alt="" draggable={false} />
                              <span className="intermission-recent-main">
                                {characterName(main)}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                      <p>{name}</p>
                      {score !== null && (
                        <b className="intermission-recent-score" aria-label={`Score ${score}`}>
                          {score}
                        </b>
                      )}
                      {winner && (
                        <strong className="intermission-recent-winner">
                          {result.kind === 'bye' || result.kind === 'forfeit'
                            ? 'Advances'
                            : 'Winner'}
                        </strong>
                      )}
                      {result.kind === 'forfeit' && winnerKnown && !winner && (
                        <span className="intermission-recent-winner">Forfeits</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p>No recorded results yet.</p>
      )}
      {hasArt && <p className="intermission-recent-credit">Profile mains · {FIGHTER_ART_CREDIT}</p>}
    </section>
  );
}
