import { useState } from 'react';
import type { PlayerData } from '../lib/apiTypes';
import { formatDate } from '../lib/format';
import { InfoTip } from './InfoTip';
import { Select, SelectItem } from './ui/Select';

function signedPoints(value: number) {
  const rounded = Number(value.toFixed(1));
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return sign + Math.abs(rounded).toFixed(1);
}

function ratingChange(before: number | null, after: number | null) {
  return before === null || after === null ? 'Unavailable' : signedPoints(after - before);
}

function nightDate(key: string) {
  return formatDate(`${key}T12:00:00Z`);
}

export function PlayerRatingNight({ nights }: { nights: PlayerData['nights'] }) {
  const [selectedKey, setSelectedKey] = useState('');
  const index = nights.findIndex((night) => night.eventKey === selectedKey);
  const selected = index === -1 ? nights.length - 1 : index;
  const night = nights[selected];
  if (!night) return null;
  const lastPlayed = nights.slice(0, selected).findLast((previous) => previous.played);
  const returned = night.played && lastPlayed !== undefined && !nights[selected - 1]?.played;

  return (
    <section className="section rating-night" aria-label="Rating changes by night">
      <div className="rating-night-heading">
        <h2>
          Rating changes by night{' '}
          <InfoTip label="How nightly rating changes work">
            The WHR comparison uses fits before and after this club night, with the recorded results
            and current settings. Results from other players can revise the estimate during an
            absence. We show estimates and changes when the rating calculation can be verified. The
            attendance penalty changes the club rating separately.
          </InfoTip>
        </h2>
        <Select aria-label="Rating night" value={night.eventKey} onValueChange={setSelectedKey}>
          {[...nights].reverse().map(({ eventKey }) => (
            <SelectItem key={eventKey} value={eventKey}>
              {nightDate(eventKey)}
            </SelectItem>
          ))}
        </Select>
      </div>
      {!night.played && <p className="muted">No rated sets for this player on this night.</p>}
      <dl className="rating-night-values" aria-live="polite">
        <div>
          <dt>WHR estimate</dt>
          <dd className="num">
            {night.preRating === null && night.postRating === null
              ? 'Unavailable'
              : `${night.preRating?.toFixed(1) ?? 'Unavailable'} → ${night.postRating?.toFixed(1) ?? 'Unavailable'}`}
          </dd>
        </div>
        <div>
          <dt>{night.played ? 'This night’s results' : 'Revision from other sets'}</dt>
          <dd className="num">{ratingChange(night.preRating, night.postRating)}</dd>
        </div>
        {returned && (
          <div>
            <dt>Revision while away</dt>
            <dd className="num">{ratingChange(lastPlayed.postRating, night.preRating)}</dd>
          </div>
        )}
        <div>
          <dt>Attendance penalty</dt>
          <dd className="num">
            {night.prePenalty} → {night.postPenalty}
          </dd>
        </div>
      </dl>
    </section>
  );
}
