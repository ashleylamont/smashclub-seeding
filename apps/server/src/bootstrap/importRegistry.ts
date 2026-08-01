import type { Db } from '@smashclub/db';
import { tournaments } from '@smashclub/db';
import { DEFAULT_COMPANY_TAXONOMY, normalizeTournamentId, type CompanyTaxonomy } from '@smashclub/engine';
import { applyRegistryEntries, importCompanyTaxonomy, type RegistryImportResult } from '../registry/import';
import type { RegistryPlayerInput } from '../registry/parse';

/**
 * One-off bootstrap import, idempotent (safe to re-run):
 * - company taxonomy -> companies/company_aliases
 * - players.yaml -> players (keyed by legacy id) + aliases + characters
 * - tournament slugs -> registered tournaments
 *
 * The player half is the same code the admin import wizard runs (see
 * ../registry/import.ts); this module is the CLI's entry point into it, and
 * differs only in seeding the built-in company taxonomy first — which is the
 * bootstrap's whole job, and not something a UI import should do behind an
 * admin's back.
 */

export type { RegistryPlayerInput };
export { importCompanyTaxonomy };
export { parseRegistryYaml } from '../registry/parse';

export async function importRegistryPlayers(
  db: Db,
  registryPlayers: RegistryPlayerInput[],
  taxonomy: CompanyTaxonomy = DEFAULT_COMPANY_TAXONOMY,
): Promise<RegistryImportResult> {
  return applyRegistryEntries(db, registryPlayers, { seedTaxonomy: taxonomy });
}

export async function registerTournamentSlugs(db: Db, slugsOrUrls: string[]): Promise<number> {
  let registered = 0;
  for (const raw of slugsOrUrls) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const slug = normalizeTournamentId(trimmed);
    const result = await db
      .insert(tournaments)
      .values({ challongeSlug: slug, name: slug, isRookie: slug.toLowerCase().includes('rookie') })
      .onConflictDoNothing()
      .returning({ id: tournaments.id });
    if (result.length > 0) registered += 1;
  }
  return registered;
}
