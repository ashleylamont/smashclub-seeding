import { type FormatProjection } from './projectionView';

export function ProjectionBrackets({ projection }: { projection: FormatProjection }) {
  return (
    <div className="projection-layout">
      <h4>Pool layout and advancement</h4>
      <p className="muted">
        Seed and pool-place placeholders show the shape of the night. A1 means first in pool A;
        winners remain unknown.
      </p>
      <div className="projection-pools">
        {projection.pools.map((pool) => (
          <article key={pool.id} className="projection-pool">
            <h5>
              {pool.label} · {pool.id}
            </h5>
            <ul>
              {pool.entrants.map((entrant) => (
                <li key={entrant}>{entrant}</li>
              ))}
            </ul>
            <p>
              {(pool.entrants.length * (pool.entrants.length - 1)) / 2} sets · everyone plays
              everyone
            </p>
            {pool.championship ? (
              <p>
                Top {pool.championship} → championship
                <br />
                Remaining {pool.consolation} → consolation
              </p>
            ) : (
              <p>Confirmed pool order → final standings</p>
            )}
          </article>
        ))}
      </div>
      {projection.brackets.map((bracket) => {
        const matches = projection.matches.filter((m) => m.section === bracket.id);
        const rounds = Math.max(1, ...matches.map((m) => m.round));
        const firstRoundSize = matches.filter((m) => m.round === 1).length;
        const height = Math.max(90, firstRoundSize * 90);
        const pos = (round: number, slot: number) => ({
          x: (round - 1) * 250 + 10,
          y: (slot * 2 ** (round - 1) + (2 ** (round - 1) - 1) / 2) * 90 + 8,
        });
        return (
          <article key={bracket.id} className="projection-bracket">
            <h4>
              {bracket.label} · {bracket.entrants} entrants
            </h4>
            {bracket.entrants < 2 && (
              <p className="muted">
                {bracket.entrants
                  ? 'One qualifier advances without a played set.'
                  : 'No qualifiers in this bracket.'}
              </p>
            )}
            {matches.length > 0 && (
              <div
                className="projection-scroll"
                role="region"
                aria-label={`${bracket.label} bracket`}
                tabIndex={0}
              >
                <svg
                  role="img"
                  aria-label={`${bracket.label}: ${bracket.entrants} qualifiers, ${rounds} rounds; byes require no station time`}
                  width={rounds * 250}
                  height={height}
                >
                  {matches.flatMap((m) =>
                    m.dependsOn.map((id) => {
                      const parent = matches.find((p) => p.id === id)!;
                      const a = pos(parent.round, parent.slot),
                        b = pos(m.round, m.slot);
                      return (
                        <path
                          key={`${id}-${m.id}`}
                          d={`M${a.x + 220},${a.y + 32} H${a.x + 235} V${b.y + 32} H${b.x}`}
                          className="projection-connector"
                        />
                      );
                    }),
                  )}
                  {matches.map((m) => {
                    const { x, y } = pos(m.round, m.slot);
                    return (
                      <g key={m.id} className={`projection-node projection-${m.stage}`}>
                        <title>
                          {m.id}: {m.sides.join(' vs ')}
                          {m.bye ? ' — automatic bye' : ''}
                        </title>
                        <rect x={x} y={y} width={220} height={64} />
                        <text x={x + 8} y={y + 17} className="projection-node-title">
                          {m.id}
                          {m.bye ? ' · Bye' : ''}
                        </text>
                        <text x={x + 8} y={y + 37}>
                          {m.sides[0]}
                        </text>
                        <text x={x + 8} y={y + 55}>
                          {m.sides[1]}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
