import { afterEach, expect, it, vi } from 'vitest';
import type { DraftOwner, SavedScoreDraft } from '../src/lib/scoreDraftSession';

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const owner: DraftOwner = `account:${'a'.repeat(64)}`;

function draftEntries(count: number): [string, SavedScoreDraft][] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => [
    JSON.stringify([
      uuid(index + 100),
      uuid(1),
      [uuid(2), uuid(3)],
      uuid(4),
      [uuid(5), uuid(6)],
      true,
      ['played', uuid(1), 3, 1],
    ]),
    {
      score1: 3,
      score2: 1,
      revision: 27,
      requestId: uuid(7),
      confirmationId: uuid(8),
      picks: [2, 3, 5, 6].map((player) => ({
        playerId: uuid(player),
        characters: [
          'mr-game-and-watch',
          'rosalina-and-luma',
          'banjo-and-kazooie',
          'mii-swordfighter',
          'zero-suit-samus',
        ],
      })),
      editing: true,
      retryRejected: false,
      attemptedRequestId: uuid(7),
      touchedAt: now - 1000 + index,
    },
  ]);
}

async function tabStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('window', {
    opener: null,
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  vi.resetModules();
  return import('../src/lib/scoreDraftSession');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps the latest large legal edit when the tab draft store fills up', async () => {
  const storage = await tabStorage();
  for (const event of [10, 11, 12, 13])
    storage.saveScoreDrafts(uuid(event), owner, draftEntries(12));
  expect(storage.readScoreDrafts(uuid(10), owner)).toHaveLength(12);

  const entries = draftEntries(16);
  const newest = entries[15]!;
  newest[1].score2 = 2;
  storage.saveScoreDrafts(uuid(13), owner, entries);

  expect(storage.readScoreDrafts(uuid(13), owner)).toContainEqual(newest);
  expect(storage.readScoreDrafts(uuid(10), owner).length).toBeLessThan(12);
});

it('discards cloned drafts when a fresh history document starts with a copied store', async () => {
  const storage = await tabStorage();
  const entries = draftEntries(1);
  storage.saveScoreDrafts(uuid(10), owner, entries);
  expect(storage.readScoreDrafts(uuid(10), owner)).toEqual(entries);

  vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
    { type: 'back_forward' } as PerformanceNavigationTiming,
  ]);
  vi.resetModules();
  const historyDocument = await import('../src/lib/scoreDraftSession');
  expect(historyDocument.readScoreDrafts(uuid(10), owner)).toEqual([]);
});
