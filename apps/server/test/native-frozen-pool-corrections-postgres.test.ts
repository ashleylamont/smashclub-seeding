import { nativeResultPublications, sets } from '@smashclub/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { nativeFinalsSlotReplayFixture } from './helpers/nativeFinalsSlotReplay';
import { postgresCluster } from './helpers/postgres';

describe('reviewed corrections to frozen multi-pool standings', () => {
  let pg: Awaited<ReturnType<typeof postgresCluster>>;
  let runtime: NativeRuntime;
  let fixture: ReturnType<typeof nativeFinalsSlotReplayFixture>;
  beforeAll(async () => {
    pg = await postgresCluster();
    runtime = await createPostgresNativeRuntime(pg.db, pg.connectionString);
    fixture = nativeFinalsSlotReplayFixture(pg, runtime);
  });
  afterAll(async () => {
    await runtime?.shutdown();
    await pg?.close();
  });

  async function finished() {
    const event = await fixture.prepare({ consolation: false });
    for (;;) {
      const ready = (await event.state()).matches.find((match) => match.status === 'ready');
      if (!ready) break;
      await event.report(ready, ready.player1Id!);
    }
    const state = await event.state();
    const fourth = event.fourth!;
    const lowSet = state.matches.find(
      (match) =>
        match.poolId === event.pool.id &&
        [event.bea, fourth].every((id) => [match.player1Id, match.player2Id].includes(id)),
    )!;
    const { requestId, ...correction } = fixture.score(lowSet, fourth);
    const order = [event.first!, event.alice, fourth, event.bea];
    return { event, state, correction, requestId, order };
  }

  it('reviews and records a changed pool order without changing completed finals', async () => {
    const { event, state, correction, requestId, order } = await finished();
    const { outcome, ...score } = correction;
    await expect(event.eventOps.reportScore({ ...correction, requestId })).rejects.toThrow(
      /Finals already use this pool result or order/,
    );
    const preview = await event.eventOps.live.previewFinalsSlotReplay({
      planId: event.planId,
      ...score,
      reviewVersion: 3,
    });
    expect(preview).toMatchObject({
      allowed: true,
      qualifierChanges: [],
      poolPlacementCorrection: true,
      changes: [
        { entrantId: event.fourth, beforePlace: 4, afterPlace: 3 },
        { entrantId: event.bea, beforePlace: 3, afterPlace: 4 },
      ],
    });
    if (!preview.allowed) throw new Error('Expected a reviewed correction');
    const command = {
      ...score,
      outcome,
      kind: 'score' as const,
      poolGameCorrectionToken: preview.revisionToken,
    };
    await expect(
      event.send({ ...command, poolGameCorrectionToken: '0'.repeat(64) }, requestId),
    ).rejects.toThrow(/Pool evidence changed/);
    expect(await event.state()).toEqual(state);
    const saved = await event.send(command, requestId);
    expect((await event.send(command, requestId)).receipt).toEqual(saved.receipt);
    const corrected = await event.state();
    expect(corrected.pools.find((pool) => pool.id === event.pool.id)).toMatchObject({
      order,
      orderDecision: { source: 'automatic', order },
    });
    expect(corrected.matches.find(({ id }) => id === score.matchId)).toMatchObject({
      winnerId: event.fourth,
      revision: score.expectedRevision + 1,
    });
    expect(corrected.matches.filter((match) => match.bracketId)).toEqual(
      state.matches.filter((match) => match.bracketId),
    );
    expect(corrected.brackets).toEqual(state.brackets);
    expect(corrected.reports.slice(0, -1)).toEqual(state.reports);
    expect(await runtime.replay(event.planId)).toEqual(corrected);
  });

  it('publishes the corrected score and pool order in one sealed replacement', async () => {
    const { event, correction, requestId, order } = await finished();
    await event.eventOps.native.finalize({ planId: event.planId });
    const before = await event.state();

    await event.send(
      {
        kind: 'replaceResult',
        resultId: before.result!.id,
        reason: 'Checked the original scoresheet',
        corrections: [correction],
      },
      requestId,
    );
    const corrected = await event.state();
    expect(corrected.pools.find((pool) => pool.id === event.pool.id)).toMatchObject({
      order,
      orderDecision: { source: 'automatic', order },
    });
    expect(corrected.pools.filter((pool) => pool.id !== event.pool.id)).toEqual(
      before.pools.filter((pool) => pool.id !== event.pool.id),
    );
    expect(corrected.result!.poolOrders).toEqual(
      corrected.pools.map(({ division, order }) => ({ division, order })),
    );
    expect(corrected.result).toMatchObject({
      revision: 2,
      replacesResultId: before.result!.id,
      brackets: before.result!.brackets,
    });
    expect(corrected.matches.filter((match) => match.bracketId)).toEqual(
      before.matches.filter((match) => match.bracketId),
    );
    const publications = await pg.db
      .select()
      .from(nativeResultPublications)
      .where(eq(nativeResultPublications.eventPlanId, event.planId));
    expect(publications.map(({ revision }) => revision).sort()).toEqual([1, 2]);
    const newPublication = publications.find(({ revision }) => revision === 2)!;
    const publishedSet = (await pg.db.select().from(sets)).find(
      (row) =>
        newPublication.tournamentIds.includes(row.tournamentId) &&
        (row.raw as { eventMatchId?: string } | null)?.eventMatchId === correction.matchId,
    );
    const source = before.matches.find(({ id }) => id === correction.matchId)!;
    expect(publishedSet).toMatchObject({
      winner: source.player1Id === event.fourth ? 1 : 2,
      scoresCsv: `${correction.score1}-${correction.score2}`,
      excludedFromRatings: false,
    });
    expect(await runtime.replay(event.planId)).toEqual(corrected);
  });

  it('leaves the published revision untouched if its reviewed change would replace a used qualifier', async () => {
    const { event, correction } = await finished();
    await event.eventOps.native.finalize({ planId: event.planId });
    const before = await event.state();
    const source = before.matches.find(({ id }) => id === event.source.id)!;
    const { requestId, ...changesQualifier } = fixture.score(source, event.bea);
    const lowSet = before.matches.find(({ id }) => id === correction.matchId)!;
    const { requestId: _, ...sameWinner } = fixture.score(lowSet, event.bea);
    const gamesOnly = {
      ...sameWinner,
      score1: sameWinner.score1 === 2 ? 2 : 0,
      score2: sameWinner.score2 === 2 ? 2 : 0,
    };
    const request = {
      kind: 'replaceResult' as const,
      resultId: before.result!.id,
      reason: 'Checked the original scoresheet',
      corrections: [gamesOnly, changesQualifier],
    };

    await expect(event.send(request, requestId)).rejects.toThrow(
      /change a recorded finals qualification assignment/,
    );
    expect(await event.state()).toEqual(before);
    expect(await runtime.replay(event.planId)).toEqual(before);
    expect(
      await pg.db
        .select()
        .from(nativeResultPublications)
        .where(eq(nativeResultPublications.eventPlanId, event.planId)),
    ).toMatchObject([{ resultId: before.result!.id, revision: 1 }]);
  });
});
