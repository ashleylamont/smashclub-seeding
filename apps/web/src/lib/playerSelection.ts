import { useState } from 'react';

export type PublicPlayer = { id: string; name: string; label: string };
export function eventPlayers(matches: readonly { player1Id: string | null; player2Id: string | null; player1Name: string | null; player2Name: string | null; division?: string; stage?: string; poolIndex?: number | null }[]): PublicPlayer[] {
  const players = new Map<string, { name: string; pool: string | null }>();
  for (const match of matches) {
    const pool = match.stage === 'group' && match.poolIndex !== null && match.poolIndex !== undefined ? `${match.division === 'upper' ? 'Upper' : 'Lower'} Pool ${String.fromCharCode(65 + match.poolIndex)}` : null;
    if (match.player1Id) players.set(match.player1Id, { name: match.player1Name ?? 'Player', pool: pool ?? players.get(match.player1Id)?.pool ?? null });
    if (match.player2Id) players.set(match.player2Id, { name: match.player2Name ?? 'Player', pool: pool ?? players.get(match.player2Id)?.pool ?? null });
  }
  const sorted = [...players].map(([id, player]) => ({ id, ...player })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const names = new Map<string, number>();
  for (const player of sorted) names.set(player.name, (names.get(player.name) ?? 0) + 1);
  const baseLabel = (player: (typeof sorted)[number]) => (names.get(player.name) ?? 0) > 1 ? `${player.name}${player.pool ? ` · ${player.pool}` : ''}` : player.name;
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const player of sorted) totals.set(baseLabel(player), (totals.get(baseLabel(player)) ?? 0) + 1);
  return sorted.map(player => {
    const label = baseLabel(player);
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return { id: player.id, name: player.name, label: (totals.get(label) ?? 0) > 1 ? `${label} (${count})` : label };
  });
}
export function useDevicePlayer(planId: string) {
  const key = `nemesis:player-filter:${planId}`;
  const [selected, setSelected] = useState(() => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } });
  const update = (id: string) => { setSelected(id); try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* Filtering still works without storage. */ } };
  return [selected, update] as const;
}
