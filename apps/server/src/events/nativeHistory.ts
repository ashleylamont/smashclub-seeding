import { eventPlans, nativeResultPublications, type Db } from '@smashclub/db';
import { isNotNull } from 'drizzle-orm';

/** Publication receipts define effective history without deleting prior revisions. */
export async function nativeHistory(db: Db) {
  const receipts = await db.select().from(nativeResultPublications);
  const withdrawnPlans = new Set(
    (
      await db
        .select({ id: eventPlans.id })
        .from(eventPlans)
        .where(isNotNull(eventPlans.resultsWithdrawnAt))
    ).map((p) => p.id),
  );
  const latest = new Map<string, (typeof receipts)[number]>();
  for (const receipt of receipts) {
    const prior = latest.get(receipt.eventPlanId);
    if (!prior || prior.revision < receipt.revision) latest.set(receipt.eventPlanId, receipt);
  }
  const byTournament = new Map<string, string[]>();
  const superseded = new Set<string>();
  const withdrawn = new Set<string>();
  for (const receipt of receipts) {
    const effective = withdrawnPlans.has(receipt.eventPlanId)
      ? []
      : latest.get(receipt.eventPlanId)!.tournamentIds;
    for (const id of receipt.tournamentIds) {
      if (withdrawnPlans.has(receipt.eventPlanId)) withdrawn.add(id);
      byTournament.set(id, effective);
      if (!effective.includes(id)) superseded.add(id);
    }
  }
  return { byTournament, superseded, withdrawn, withdrawnPlans };
}
