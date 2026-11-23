import { Disclosure } from './ui/Disclosure';
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
  return [...leagues].sort(
    (a, b) => tierClass(a).localeCompare(tierClass(b)) || a.localeCompare(b),
  );
}

export function BoardLegend({ leagues }: Props) {
  const ordered = orderLeagues(leagues);

  return (
    <Disclosure
      title="How to read the board"
      triggerClassName="board-legend-summary"
      className="board-legend"
    >
      <div className="board-legend-body">
        <dl className="legend-terms">
          <div className="legend-term">
            <dt>
              <span className="legend-sample num legend-sample-rating">1684</span> Club rating
            </dt>
            <dd>Ranks use the skill estimate after any attendance penalty.</dd>
          </div>

          <div className="legend-term">
            <dt>
              <span className="legend-sample num">1961±138</span> Skill ± band
            </dt>
            <dd>
              The estimate and its uncertainty. Without an attendance penalty, the club rating
              equals the skill estimate.
            </dd>
          </div>

          <div className="legend-term">
            <dt>
              <span className="legend-sample num legend-sample-penalty">−80 away</span> Missed
              nights
            </dt>
            <dd>
              Any attendance deduction appears beside the rating. The <strong>Seen</strong> column
              counts missed club nights. Open <strong>How ranking works</strong> at the top of
              Rankings for the current attendance rule.
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
              Places gained or lost over the last club night, measured against a replay that leaves
              that night out. Movement uses the selected ranking field, even when you search or
              filter by company.
            </dd>
          </div>

          <div className="legend-term">
            <dt>Tournament placing</dt>
            <dd>
              Your finish in a bracket or division. WHR uses only eligible sets as rating evidence
              and accounts for opponent strength.
            </dd>
          </div>

          <div className="legend-term">
            <dt>Bracket seed</dt>
            <dd>
              Your starting position in a draw. Automatic rating-based seeds use saved skill and
              uncertainty. Pool results decide who advances. Nemesis’s combined finals policy uses
              pool place and saved rating strength to order qualifiers.
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
              Recent rating trajectory, sets won and lost, and events attended — a main and a rookie
              bracket on one evening count as one event.
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
            <p className="legend-leagues-note muted">
              Each row carries its league on its left edge.
            </p>
          </div>
        )}
      </div>
    </Disclosure>
  );
}
