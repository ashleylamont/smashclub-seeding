import { tierClass } from '../lib/format';

/**
 * The board's key.
 *
 * Every column on the board explained itself through `title=` on its header.
 * That has two holes. A phone has no hover, so the tooltips never fire; and
 * below the fold-point the header row is hidden altogether, so on the device
 * most club members actually check the rankings on, the columns were both
 * unlabelled and unexplained. Movement, confidence and form were three
 * anonymous marks.
 *
 * So the key is a disclosure that lives with the board on every width, closed
 * by default because most visits are just "where am I". It shows the actual
 * marks rather than describing them — the same pips, the same meter, the same
 * league swatches — because a key that renders a different thing from the board
 * is a key you have to translate.
 */

interface Props {
  /** The leagues actually present on the board, so the ramp is never invented. */
  leagues: string[];
}

/** Highest rung first — `tierClass` is already ordered, so sort on it. */
function orderLeagues(leagues: string[]): string[] {
  return [...leagues].sort((a, b) => tierClass(a).localeCompare(tierClass(b)) || a.localeCompare(b));
}

export function BoardLegend({ leagues }: Props) {
  const ordered = orderLeagues(leagues);

  return (
    <details className="board-legend">
      <summary className="board-legend-summary">How to read the board</summary>

      <div className="board-legend-body">
        <dl className="legend-terms">
          <div className="legend-term">
            <dt>
              <span className="legend-sample num legend-sample-rating">1684</span> Rating
            </dt>
            <dd>
              What the board is ordered on: the skill estimate less two standard deviations. Missing club nights
              widens the deviation, so a place is held by turning up as well as by winning.
            </dd>
          </div>

          <div className="legend-term">
            <dt>
              <span className="legend-sample num">1961±138</span> Skill ± band
            </dt>
            <dd>
              The estimate itself, and how sure of it we are. Play more and the band narrows, so the rating on the
              left closes on this number.
            </dd>
          </div>

          <div className="legend-term">
            <dt>
              <span className="legend-sample num">
                <span className="movement-up">▲2</span> <span className="movement-down">▼1</span>
              </span>{' '}
              Movement
            </dt>
            <dd>
              Places gained or lost over the last club night — compared against a replay with that night withheld,
              so it reports what the games did rather than what the last recompute happened to change.
            </dd>
          </div>

          <div className="legend-term">
            <dt>
              <span className="legend-sample legend-sample-meter">
                <span className="certainty-track">
                  <span className="certainty-fill" style={{ width: '72%' }} />
                </span>
              </span>{' '}
              Confidence
            </dt>
            <dd>Fuller means better established — more sets, against more different opponents.</dd>
          </div>

          <div className="legend-term">
            <dt>
              <span className="legend-sample">
                <span className="form">
                  <span className="pip pip-win" />
                  <span className="pip pip-win" />
                  <span className="pip pip-loss" />
                  <span className="pip pip-win" />
                  <span className="pip pip-loss" />
                </span>
              </span>{' '}
              Form
            </dt>
            <dd>The last five sets, oldest on the left. Tall is a win, short is a loss.</dd>
          </div>

          <div className="legend-term">
            <dt>Trend · W–L · Ev</dt>
            <dd>
              Recent rating trajectory, sets won and lost, and events attended — a main and a rookie bracket on one
              evening count as one event.
            </dd>
          </div>
        </dl>

        {ordered.length > 0 && (
          <div className="legend-leagues">
            <p className="legend-leagues-label">Leagues</p>
            <ul className="legend-league-list">
              {ordered.map((league) => (
                <li key={league} className={`legend-league ${tierClass(league)}`}>
                  <span className="legend-league-swatch" aria-hidden="true" />
                  {league}
                </li>
              ))}
            </ul>
            <p className="legend-leagues-note muted">Each row carries its league on its left edge.</p>
          </div>
        )}
      </div>
    </details>
  );
}
