import { characterName, type SetCharacterPick } from '@smashclub/shared';
import type { ScoreReportPlayer } from '../lib/scoreReportPlayers';

export function ReportedCharacters({
  picks,
  players,
}: {
  picks?: SetCharacterPick[] | null;
  players: ScoreReportPlayer[];
}) {
  if (!picks?.length) return null;
  return (
    <ul className="muted" aria-label="Reported characters">
      {picks.map(({ playerId, characters }) => (
        <li key={playerId}>
          {players.find(({ id }) => id === playerId)?.name ?? 'Player'} ·{' '}
          {characters.map(characterName).join(', ')}
        </li>
      ))}
    </ul>
  );
}
