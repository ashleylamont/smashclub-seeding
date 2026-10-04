import { nativeResultPublications, type Db } from '@smashclub/db';

/** Publication receipts define effective history without deleting prior revisions. */
export async function nativeHistory(db: Db) {
  const receipts = await db.select().from(nativeResultPublications);
  const latest = new Map<string, (typeof receipts)[number]>();
  for (const receipt of receipts) {
    const prior = latest.get(receipt.eventPlanId);
    if (!prior || prior.revision < receipt.revision) latest.set(receipt.eventPlanId, receipt);
  }
  const byTournament = new Map<string, string[]>();
  const superseded = new Set<string>();
  for (const receipt of receipts) {
    const effective = latest.get(receipt.eventPlanId)!.tournamentIds;
    for (const id of receipt.tournamentIds) {
      byTournament.set(id, effective);
      if (!effective.includes(id)) superseded.add(id);
    }
  }
  return { byTournament, superseded };
}
