import type { SetCharacterPick } from '@smashclub/shared';

/** Count a fighter once per played set. A tied lead leaves the choice open. */
export function leadingCharacters(sets: Iterable<readonly SetCharacterPick[]>, minimum = 1) {
  const counts = new Map<string, Map<string, number>>();
  for (const picks of sets) {
    for (const { playerId, characters } of picks) {
      const tally = counts.get(playerId) ?? new Map<string, number>();
      for (const slug of new Set(characters)) tally.set(slug, (tally.get(slug) ?? 0) + 1);
      counts.set(playerId, tally);
    }
  }
  const leaders = new Map<string, { character: string; sets: number }>();
  for (const [playerId, tally] of counts) {
    const [first, second] = [...tally].sort((a, b) => b[1] - a[1]);
    if (first && first[1] >= minimum && first[1] > (second?.[1] ?? 0)) {
      leaders.set(playerId, { character: first[0], sets: first[1] });
    }
  }
  return leaders;
}

export function agreedCharacters(reports: Iterable<readonly SetCharacterPick[]>) {
  const evidence = new Map<
    string,
    { characters: string[]; signature: string; conflict: boolean }
  >();
  for (const picks of reports) {
    for (const { playerId, characters } of picks) {
      const signature = JSON.stringify([...characters].sort());
      const previous = evidence.get(playerId);
      if (!previous) evidence.set(playerId, { characters, signature, conflict: false });
      else if (previous.signature !== signature) previous.conflict = true;
    }
  }
  return [...evidence].flatMap(([playerId, value]) =>
    value.conflict ? [] : [{ playerId, characters: value.characters }],
  );
}
