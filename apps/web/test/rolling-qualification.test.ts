import { describe, expect, it } from 'vitest';
import type { LiveMatch, PoolQualifierSlot } from '../src/lib/eventDisplay';
import { liveBracketSide, liveBracketStatus } from '../src/lib/eventBracket';
import { matchParticipantName, matchPresentation } from '../src/lib/matchPresentation';
import { qualificationSummary } from '../src/lib/qualification';
import { playerHubView, playerBracketPath } from '../src/lib/playerHubView';

const slot: PoolQualifierSlot = {
  poolId: 'pool-a',
  poolIndex: 0,
  division: 'upper',
  place: 1,
  status: 'pending',
  entrantId: null,
  eligibleEntrantIds: ['a', 'b'],
};
const pending: LiveMatch = {
  id: 'final',
  division: 'upper',
  stage: 'main',
  poolIndex: null,
  label: 'Championship final',
  player1Id: null,
  player2Id: 'c',
  player1Name: 'TBD',
  player2Name: 'C',
  score1: null,
  score2: null,
  winnerId: null,
  status: 'blocked',
  stationId: null,
  nativeBracketId: 'main',
  player1Qualifier: slot,
  qualificationBlocks: [slot],
};

describe('rolling qualification display', () => {
  it('names a reserved pool place without assigning an entrant or awarding a bye', () => {
    expect(liveBracketSide(pending, 0, new Map())).toBe('Upper Pool A · place 1');
    expect(matchParticipantName(pending, 0)).toBe('Upper Pool A · place 1');
    expect(liveBracketSide(pending, 1, new Map())).toBe('C');
    expect(liveBracketStatus(pending)).toBe('Waiting for qualifiers');
    expect(matchPresentation(pending)).toMatchObject({
      kind: 'pending',
      canReport: false,
      showScores: false,
    });
    expect(matchPresentation(pending).result).toBe('Waiting for Upper Pool A · place 1.');
    const resolved = {
      ...pending,
      player1Id: 'a',
      player1Name: 'A',
      player1Qualifier: { ...slot, status: 'resolved' as const },
    };
    expect(liveBracketSide(resolved, 0, new Map())).toBe('A');
    expect(matchParticipantName(resolved, 0)).toBe('A');
  });

  it('explains relevant review holds while preserving recorded results and actual calls', () => {
    const reviewed = { ...slot, status: 'review_pending' as const };
    const held = { ...pending, player1Id: 'a', player1Name: 'A', qualificationBlocks: [reviewed] };
    expect(liveBracketStatus(held)).toBe('Qualification under review');
    expect(qualificationSummary(held)).toBe('Waiting for Upper Pool A · place 1 (under review).');
    expect(qualificationSummary({ ...held, player1Qualifier: reviewed })).toBe(
      'Waiting for Upper Pool A · place 1 (under review).',
    );
    expect(liveBracketStatus({ ...held, status: 'playing', called: true })).toBe('Called');
    expect(
      liveBracketStatus({ ...held, status: 'complete', outcome: 'played', winnerId: 'a' }),
    ).toBe('Final result');
    expect(
      liveBracketSide(
        { ...pending, status: 'complete', outcome: 'bye', winnerId: 'c' },
        0,
        new Map(),
      ),
    ).toBe('Bye');
    expect(
      liveBracketSide(
        { ...pending, player1Qualifier: undefined, parent1MatchId: 'semi' },
        0,
        new Map([['semi', 'Semi-final A']]),
      ),
    ).toBe('Winner of Semi-final A');
  });

  it('separates eligible possible draws from assigned personal paths and excludes frozen-out entrants', () => {
    const pool = {
      ...pending,
      id: 'group',
      revision: 0,
      stage: 'group',
      poolIndex: 0,
      nativeBracketId: null,
      player1Id: 'a',
      player1Name: 'A',
      player2Id: 'b',
      player2Name: 'B',
      player1Qualifier: undefined,
      qualificationBlocks: undefined,
      status: 'ready',
    };
    const data = {
      plan: { id: 'event', status: 'underway', bracketMode: 'native', structure: 'pools_finals' },
      matches: [pool, { ...pending, revision: 0 }],
      stations: [],
      poolSchedules: [],
      nativeBrackets: [
        {
          id: 'main',
          division: 'upper',
          stage: 'main',
          entrantIds: ['c'],
          complete: false,
          winnerId: null,
          standings: [],
          qualifierSlots: [slot],
        },
      ],
    };
    const view = playerHubView(data, 'a');
    expect(view.nativeBrackets).toHaveLength(1);
    expect(view.assignedBrackets).toHaveLength(0);
    expect(view.pendingBrackets).toHaveLength(1);
    expect(
      playerBracketPath(
        data.matches.filter((m) => m.stage === 'main'),
        'a',
      ),
    ).toEqual([]);
    expect(view.sections[0]).toBe('pools');
    const frozenOut = {
      ...data,
      entrants: [{ id: 'team', name: 'Team', memberPlayerIds: ['member'] }],
      matches: [{ ...pool, player1Id: 'team', player1MemberIds: ['member'] }],
      nativeBrackets: [
        {
          ...data.nativeBrackets[0]!,
          qualifierSlots: [{ ...slot, eligibleEntrantIds: ['team', 'b'] }],
        },
      ],
    };
    expect(playerHubView(frozenOut, 'member').pendingBrackets).toHaveLength(1);
    expect(playerHubView(frozenOut, 'a').nativeBrackets).toHaveLength(0);
    const assigned = {
      ...data,
      matches: [
        pool,
        { ...pending, revision: 1, status: 'ready', player1Id: 'a', player1Name: 'A' },
      ],
      nativeBrackets: [
        {
          ...data.nativeBrackets[0]!,
          entrantIds: ['a', 'c'],
          qualifierSlots: [{ ...slot, status: 'resolved' as const, entrantId: 'a' }],
        },
      ],
    };
    expect(playerHubView(assigned, 'a').assignedBrackets).toHaveLength(1);
    expect(playerHubView(assigned, 'a').pendingBrackets).toHaveLength(0);
    expect(playerHubView(assigned, 'a').sections[0]).toBe('brackets');
  });
});
