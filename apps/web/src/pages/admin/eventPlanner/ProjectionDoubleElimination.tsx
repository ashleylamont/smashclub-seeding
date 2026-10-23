import type { FormatProjection, ProjectedMatch } from './projectionView';
import {
  bracketCard,
  projectionLaneLayout,
  projectionMatchName,
  projectionPairing,
  type ProjectionLane,
} from './projectionBracketLayout';

const lanes: { key: ProjectionLane; title: string; description: string }[] = [
  {
    key: 'winners',
    title: 'Winners bracket',
    description: 'Win to advance. A first loss drops to the matching lower-bracket feed.',
  },
  {
    key: 'losers',
    title: 'Losers bracket',
    description: 'A second loss eliminates an entrant. The last survivor reaches the grand final.',
  },
  {
    key: 'finals',
    title: 'Grand final and reset',
    description:
      'The losers-bracket finalist must win the grand final and the reset to become champion.',
  },
];

export function ProjectionDoubleElimination({
  bracket,
  matches,
}: {
  bracket: FormatProjection['brackets'][number];
  matches: ProjectedMatch[];
}) {
  const byId = new Map(matches.map((match) => [match.id, match]));
  return (
    <article className="projection-bracket projection-double-elimination">
      <h4>Double elimination · {bracket.entrants} entrants</h4>
      <p className="muted">
        W = winners round; L = losers round. Each card names its feeder set. Byes advance
        automatically; the reset is conditional.
      </p>
      {lanes.map((lane) => {
        const members = matches.filter((m) =>
          lane.key === 'finals'
            ? m.bracketLane === 'final' || m.bracketLane === 'reset'
            : m.bracketLane === lane.key,
        );
        if (!members.length) return null;
        const layout = projectionLaneLayout(members, lane.key);
        return (
          <section
            key={lane.key}
            className={`projection-bracket-lane projection-bracket-${lane.key}`}
          >
            <div className="projection-bracket-lane-heading">
              <h5>{lane.title}</h5>
              <span>
                {lane.key === 'finals' ? 'Up to ' : ''}
                {members.filter((m) => !m.bye).length} sets
              </span>
            </div>
            <p className="muted">{lane.description}</p>
            <div
              className="projection-scroll projection-bracket-scroll"
              role="region"
              aria-label={`${lane.title} layout`}
              tabIndex={0}
            >
              <div
                className="projection-bracket-canvas"
                style={{ width: layout.width, height: layout.height }}
              >
                <svg
                  width={layout.width}
                  height={layout.height}
                  aria-hidden="true"
                  className="projection-bracket-lines"
                >
                  {layout.edges.map((edge) => (
                    <path
                      key={`${edge.from}-${edge.to}-${edge.side}`}
                      d={edge.path}
                      className={`projection-connector projection-feed-${edge.outcome}`}
                    />
                  ))}
                </svg>
                {layout.rounds.map((round) => (
                  <strong
                    className="projection-bracket-round"
                    style={{ left: round.x }}
                    key={round.label}
                  >
                    {round.label}
                  </strong>
                ))}
                {layout.nodes.map(({ match, x, y }) => {
                  const sides = projectionPairing(match, byId);
                  return (
                    <article
                      key={match.id}
                      aria-label={`${projectionMatchName(match)}: ${sides.join(' versus ')}`}
                      data-match-id={match.id}
                      className={`projection-set${match.bye ? ' projection-set-bye' : ''}${match.conditional ? ' projection-set-conditional' : ''}`}
                      style={{
                        left: x,
                        top: y,
                        width: bracketCard.width,
                        height: bracketCard.height,
                      }}
                    >
                      <header>
                        <strong>{projectionMatchName(match)}</strong>
                        {match.bye ? (
                          <span>Bye</span>
                        ) : match.conditional ? (
                          <span>If needed</span>
                        ) : null}
                      </header>
                      {sides.map((side, i) => (
                        <p
                          key={i}
                          title={side}
                          className={
                            match.feeds.some((f) => f.side === i && f.outcome === 'loser')
                              ? 'projection-side-drop'
                              : undefined
                          }
                        >
                          {side}
                        </p>
                      ))}
                    </article>
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
    </article>
  );
}
