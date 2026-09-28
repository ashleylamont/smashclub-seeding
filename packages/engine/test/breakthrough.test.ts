import { describe, expect, it } from 'vitest';
import { defaultGlickoSettings } from '@smashclub/shared';
import { breakthroughEvidence } from '../src/breakthrough';
import type { EngineSet, EngineTournament } from '../src/types';

const tournaments: EngineTournament[] = [
  { id: 'past', eventDate: '2026-01-01', isRookie: false },
  { id: 'night', eventDate: '2026-02-01T08:00:00Z', isRookie: false },
  { id: 'consolation', eventDate: '2026-02-01T10:00:00Z', isRookie: false },
  { id: 'future', eventDate: '2026-03-01', isRookie: false },
];
const set = (id: string, tournamentId: string, winner: 1 | 2, p2PlayerId = 'b'): EngineSet =>
  ({ id, tournamentId, p1PlayerId: 'a', p2PlayerId, winner });
const past = Array.from({ length: 6 }, (_, i) => set(`past-${i}`, 'past', 2));

describe.each(['whr', 'glicko2'] as const)('breakthrough evidence (%s)', (activeModel) => {
  const analyse = (sets: EngineSet[]) => breakthroughEvidence({ eventKey: '2026-02-01', tournaments, sets, settings: { ...defaultGlickoSettings, activeModel } });

  it('freezes expectations across live results, same-night brackets and future history', () => {
    const first = analyse([...past, set('live1', 'night', 1)]);
    const later = analyse([...past, set('live1', 'night', 1), set('live2', 'consolation', 1), ...Array.from({ length: 20 }, (_, i) => set(`future${i}`, 'future', 1))]);
    const a = first.rows.find((r) => r.playerId === 'a')!;
    const updated = later.rows.find((r) => r.playerId === 'a')!;
    expect(a.sets[0]!.expected).toBeLessThan(0.5);
    expect(updated.baseline).toEqual(a.baseline);
    expect(updated.sets.map((s) => s.expected)).toEqual([a.sets[0]!.expected, a.sets[0]!.expected]);
    expect(updated.priorNights).toBe(1);
    expect(updated.priorSets).toBe(6);
    expect(updated.sets).toHaveLength(2);
    expect(analyse([...past, set('live1', 'night', 2)]).rows[0]!.sets[0]!.expected).toBe(a.sets[0]!.expected);
  });

  it('does not invent a comparison for a debut, and gives complementary probabilities', () => {
    const result = analyse([...past, set('known', 'night', 1), set('new', 'night', 1, 'newcomer')]);
    const a = result.rows.find((r) => r.playerId === 'a')!;
    const b = result.rows.find((r) => r.playerId === 'b')!;
    expect(a.sets[0]!.expected! + b.sets[0]!.expected!).toBeCloseTo(1);
    expect(a.sets[1]!.expected).toBeNull();
    expect(result.rows.find((r) => r.playerId === 'newcomer')!.baseline).toBeNull();
  });

  it('counts separate same-day history brackets as one previous night', () => {
    const result = breakthroughEvidence({ eventKey: '2026-03-01', tournaments,
      sets: [...past, set('main', 'night', 1), set('side', 'consolation', 2), set('target', 'future', 1)],
      settings: { ...defaultGlickoSettings, activeModel } });
    expect(result.rows[0]!.priorNights).toBe(2);
    expect(result.rows[0]!.priorSets).toBe(8);
  });
});
