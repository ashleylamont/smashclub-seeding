import type { TournamentData } from '../lib/apiTypes';
import { hasExportableBracket } from '../lib/bracketGraphic';
import { formatDate } from '../lib/format';
import { BracketGraphic } from './BracketGraphic';

export function ArchiveBracketGraphic({
  graphic,
}: {
  graphic: NonNullable<TournamentData['bracketGraphic']>;
}) {
  const { eventDate, matches, ...context } = graphic;
  if (!hasExportableBracket(matches)) return null;
  return (
    <BracketGraphic
      context={{ ...context, eventDate: eventDate ? formatDate(eventDate) : '', state: 'closed' }}
      matches={matches}
    />
  );
}
