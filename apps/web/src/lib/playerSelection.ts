import { useState } from 'react';

export type PublicPlayer = { id: string; name: string };
export function eventPlayers(matches: readonly { player1Id: string | null; player2Id: string | null; player1Name: string | null; player2Name: string | null }[]): PublicPlayer[] {
  const players = new Map<string, string>();
  for (const match of matches) {
    if (match.player1Id) players.set(match.player1Id, match.player1Name ?? 'Player');
    if (match.player2Id) players.set(match.player2Id, match.player2Name ?? 'Player');
  }
  return [...players].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
export function useDevicePlayer(planId: string) {
  const key = `nemesis:player-filter:${planId}`;
  const [selected, setSelected] = useState(() => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } });
  const update = (id: string) => { setSelected(id); try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* Filtering still works without storage. */ } };
  return [selected, update] as const;
}
