import { gamesIndicateUnplayed } from '@smashclub/shared';
import type { EngineSet } from './types';

/** An unplayed bracket outcome is never WHR evidence, even with a resolved winner. */
export function isPlayedSet(set: EngineSet): boolean {
  return (
    set.outcome !== 'forfeit' &&
    set.outcome !== 'bye' &&
    !gamesIndicateUnplayed(set.p1Games, set.p2Games)
  );
}
