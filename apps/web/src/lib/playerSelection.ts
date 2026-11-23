import { useState } from 'react';

export type PublicPlayer = { id: string; name: string; label: string; companyCode?: string };
export function eventPlayers(
  matches: readonly {
    player1Id: string | null;
    player2Id: string | null;
    player1Name: string | null;
    player2Name: string | null;
    division?: string;
    stage?: string;
    poolIndex?: number | null;
  }[],
  entrants: readonly { id: string; companyCode?: string }[] = [],
): PublicPlayer[] {
  const affiliations = new Map(entrants.map(({ id, companyCode }) => [id, companyCode]));
  const players = new Map<string, { name: string; pool: string | null }>();
  for (const match of matches) {
    const pool =
      match.stage === 'group' && match.poolIndex !== null && match.poolIndex !== undefined
        ? `${match.division === 'upper' ? 'Upper' : 'Lower'} Pool ${String.fromCharCode(65 + match.poolIndex)}`
        : null;
    if (match.player1Id)
      players.set(match.player1Id, {
        name: match.player1Name ?? 'Player',
        pool: pool ?? players.get(match.player1Id)?.pool ?? null,
      });
    if (match.player2Id)
      players.set(match.player2Id, {
        name: match.player2Name ?? 'Player',
        pool: pool ?? players.get(match.player2Id)?.pool ?? null,
      });
  }
  const sorted = [...players]
    .map(([id, player]) => ({ id, ...player, companyCode: affiliations.get(id) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const names = new Map<string, number>();
  for (const player of sorted) names.set(player.name, (names.get(player.name) ?? 0) + 1);
  const baseLabel = (player: (typeof sorted)[number]) =>
    (names.get(player.name) ?? 0) > 1
      ? `${player.name}${player.pool ? ` · ${player.pool}` : ''}`
      : player.name;
  const options = sorted.map((player) => {
    const label = baseLabel(player);
    return { ...player, label, key: JSON.stringify([label, player.companyCode]) };
  });
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const { key } of options) totals.set(key, (totals.get(key) ?? 0) + 1);
  return options.map(({ id, name, companyCode, label, key }) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return {
      id,
      name,
      label: (totals.get(key) ?? 0) > 1 ? `${label} (${count})` : label,
      ...(companyCode && { companyCode }),
    };
  });
}
export function useDevicePlayer(planId: string, initialPlayer?: string) {
  const key = `nemesis:player-filter:${planId}`;
  const [selected, setSelected] = useState(() => {
    if (initialPlayer !== undefined) return initialPlayer;
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const update = (id: string) => {
    setSelected(id);
    try {
      // Everyone is an explicit preference. An absent entry permits an account default.
      localStorage.setItem(key, id);
    } catch {
      /* Filtering still works without storage. */
    }
  };
  return [selected, update] as const;
}
