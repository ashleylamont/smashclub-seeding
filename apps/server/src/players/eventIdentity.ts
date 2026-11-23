import { companies, players, type Db } from '@smashclub/db';
import { eq } from 'drizzle-orm';

export async function loadEventPlayerIdentity(db: Db) {
  const profiles = await db
    .select({
      id: players.id,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
      status: players.status,
      companyCode: companies.code,
    })
    .from(players)
    .leftJoin(companies, eq(companies.id, players.companyId));
  // Public player search only publishes affiliations for active profiles.
  const companyCodes = new Map<string, string>();
  for (const { id, status, companyCode } of profiles) {
    if (status === 'active' && companyCode) companyCodes.set(id, companyCode);
  }
  return { profiles, companyCodes };
}
