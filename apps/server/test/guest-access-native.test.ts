import { afterAll, beforeAll, expect, it } from 'vitest';
import { InMemoryStore } from '@rotorsoft/act';
import type { Db } from '@smashclub/db';
import { createTestDb } from './helpers/testDb';
import { nativeAdmin, seedNativeDraft } from './helpers/nativeLiveFixture';
import { createNativeRuntime, type NativeRuntime } from '../src/tournament/runtime';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { ChallongeClient } from '../src/challonge/client';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { redeemGuest } from '../src/event-operations/guests';

let db: Db, close: () => Promise<void>, runtime: NativeRuntime;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  runtime = createNativeRuntime(db, new InMemoryStore());
});
afterAll(async () => {
  await runtime.shutdown();
  await close();
});
function caller(user: typeof nativeAdmin | null = nativeAdmin) {
  return appRouter.createCaller({
    db,
    nativeRuntime: runtime,
    user,
    env: loadEnv({ DATABASE_URL: 'pglite://memory', NODE_ENV: 'test' }),
    challonge: new ChallongeClient({}),
    recomputeTrigger: new RecomputeTrigger(db),
  });
}
async function night() {
  const planId = await seedNativeDraft(db);
  const to = caller();
  await to.eventOps.softLockPools({ planId, confirm: true });
  await to.eventOps.settings({
    planId,
    published: true,
    playerReports: false,
    scoreReportingMode: 'to_review',
  });
  await to.eventOps.guests.configure({ planId, enabled: true, showOnOverlay: false });
  const invitation = await to.eventOps.guests.invitation({ planId });
  // Exercise a pass redeemed before a full event evening, not just an unaged token.
  const pass = await redeemGuest(
    db,
    { planId, token: invitation!.token },
    'synthetic-venue',
    Date.now() - 8 * 60 * 60_000,
    runtime,
  );
  return { planId, ...pass };
}

it('keeps aged native passes usable, private, idempotent and revocable independently of sign-in reporting', async () => {
  const pass = await night();
  const guest = caller(null);
  const before = await guest.eventOps.guests.matches(pass);
  expect(before.expiresAt).toBeNull();
  const match = before.matches.find((item) => item.status === 'ready')!;
  const input = {
    ...pass,
    matchId: match.id,
    expectedRevision: match.revision,
    requestId: 'aged-guest-report',
    score1: 2,
    score2: 0,
  };
  const result = await guest.eventOps.guests.submit(input);
  expect(result.status).toBe('pending');
  expect(await guest.eventOps.guests.submit(input)).toEqual(result);
  const own = await guest.eventOps.guests.matches(pass);
  expect(own.reports).toHaveLength(1);
  expect(JSON.stringify(await guest.eventOps.snapshot({ planId: pass.planId }))).not.toContain(
    pass.sessionToken,
  );
  expect(JSON.stringify(await runtime.replay(pass.planId))).not.toContain(pass.sessionToken);
  await caller().eventOps.guests.rotate({ planId: pass.planId });
  await expect(guest.eventOps.guests.submit(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(guest.eventOps.guests.matches(pass)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('rejects cross-event passes, disabled guest access and closed native events', async () => {
  const pass = await night();
  const other = await night();
  const guest = caller(null);
  await expect(
    guest.eventOps.guests.matches({ ...pass, planId: other.planId }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await caller().eventOps.guests.configure({
    planId: pass.planId,
    enabled: false,
    showOnOverlay: false,
  });
  await expect(guest.eventOps.guests.matches(pass)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await runtime.command(nativeAdmin, other.planId, 'close-with-pass', {
    kind: 'cancel',
    reason: 'End synthetic event',
  });
  await expect(guest.eventOps.guests.matches(other)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
