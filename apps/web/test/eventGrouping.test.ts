import { describe, expect, it } from 'vitest';
import { groupTournamentsByEvent } from '../src/lib/eventGrouping';
import type { TournamentListItem } from '../src/lib/apiTypes';

const item = (id: string, overrides: Partial<TournamentListItem> = {}): TournamentListItem => ({
  id,
  slug: id,
  name: id,
  eventDate: '2026-09-04T08:00:00.000Z',
  isRookie: false,
  challongeState: 'complete',
  syncState: 'synced',
  lastSyncedAt: null,
  liveUntil: null,
  ...overrides,
});

describe('groupTournamentsByEvent', () => {
  it('separates singles, doubles, and distinct native plans sharing one date', () => {
    const groups = groupTournamentsByEvent(
      [
        item('singles'),
        item('doubles', { competitionFormat: 'doubles' }),
        item('native-a', {
          competitionFormat: 'doubles',
          nativeEventId: 'a',
          nativeEventName: 'A',
        }),
        item('native-a-finals', { competitionFormat: 'doubles', nativeEventId: 'a' }),
        item('native-b', { competitionFormat: 'doubles', nativeEventId: 'b' }),
      ],
      Date.parse('2026-09-05'),
    );
    expect(groups).toHaveLength(4);
    expect(groups.find((g) => g.key === 'native:a')?.items).toHaveLength(2);
    expect(groups.find((g) => g.key === 'native:a')?.title).toBe('A');
  });
  it('groups same-date brackets and makes any live bracket make the event live', () => {
    const groups = groupTournamentsByEvent(
      [
        item('upper'),
        item('lower', { liveUntil: '2026-09-04T10:00:00.000Z' }),
        item('old', { eventDate: '2026-09-03T08:00:00.000Z' }),
        item('undated', { eventDate: null }),
      ],
      Date.parse('2026-09-04T09:00:00.000Z'),
    );
    expect(groups.find((g) => g.key === '2026-09-04')?.items).toHaveLength(2);
    expect(groups.find((g) => g.key === '2026-09-04')?.bucket).toBe('live');
    expect(groups.find((g) => g.key === 'undated:undated')?.items).toHaveLength(1);
  });
});
