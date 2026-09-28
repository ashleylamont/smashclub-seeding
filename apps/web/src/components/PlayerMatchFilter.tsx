import type { PublicPlayer } from '../lib/playerSelection';

export function PlayerMatchFilter({
  players,
  value,
  onChange,
}: {
  players: PublicPlayer[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="card player-match-filter">
      <label htmlFor="player-match-select">Show matches for</label>
      <select
        id="player-match-select"
        className="select"
        value={players.some((player) => player.id === value) ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Everyone</option>
        {players.map((player) => (
          <option key={player.id} value={player.id}>
            {player.label}
          </option>
        ))}
      </select>
      <p className="muted">
        {value
          ? 'Showing only this player’s matches. '
          : 'Choose your name to see your matches first. '}
        Your choice is saved on this device; it does not verify your identity.
      </p>
    </div>
  );
}
