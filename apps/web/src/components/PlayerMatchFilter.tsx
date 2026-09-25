import type { PublicPlayer } from '../lib/playerSelection';

export function PlayerMatchFilter({ players, value, onChange }: { players: PublicPlayer[]; value: string; onChange: (id: string) => void }) {
  return <div className="card"><label>Find my matches<select className="select" aria-label="Player on this device" value={players.some(player => player.id === value) ? value : ''} onChange={event => onChange(event.target.value)}><option value="">All players</option>{players.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label><p className="muted">Saves a match filter on this device only. This does not link a profile or prove your identity. Choose All players to browse everyone’s matches.</p></div>;
}
