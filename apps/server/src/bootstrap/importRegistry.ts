import { eq } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import { companies, companyAliases, players, tournaments } from '@smashclub/db';
import { DEFAULT_COMPANY_TAXONOMY, normalizeTournamentId, type CompanyTaxonomy } from '@smashclub/engine';
import { ensureAlias } from '../identity/matching';

/**
 * One-off bootstrap import, idempotent (safe to re-run):
 * - company taxonomy -> companies/company_aliases
 * - players.yaml -> players (keyed by legacy id) + aliases
 * - tournament slugs -> registered tournaments
 */

export interface RegistryPlayerInput {
  id: string;
  canonical_name: string;
  company?: string | null;
  aliases?: string[] | null;
  past_companies?: string[] | null;
}

export async function importCompanyTaxonomy(db: Db, taxonomy: CompanyTaxonomy = DEFAULT_COMPANY_TAXONOMY): Promise<Map<string, string>> {
  const idByCode = new Map<string, string>();
  for (const [code, name] of Object.entries(taxonomy.codes)) {
    const [row] = await db
      .insert(companies)
      .values({ code, name })
      .onConflictDoUpdate({ target: companies.code, set: { name } })
      .returning({ id: companies.id });
    idByCode.set(code, row!.id);
  }
  for (const [alias, code] of Object.entries(taxonomy.aliases)) {
    const companyId = idByCode.get(code);
    if (companyId) {
      await db.insert(companyAliases).values({ companyId, aliasNorm: alias }).onConflictDoNothing();
    }
  }
  return idByCode;
}

export async function importRegistryPlayers(
  db: Db,
  registryPlayers: RegistryPlayerInput[],
  taxonomy: CompanyTaxonomy = DEFAULT_COMPANY_TAXONOMY,
): Promise<{ created: number; updated: number }> {
  const idByCode = await importCompanyTaxonomy(db, taxonomy);
  const resolveCompanyId = (value: string | null | undefined): string | null => {
    if (!value || value.toUpperCase() === 'N/A') return null;
    const upper = value.toUpperCase();
    if (idByCode.has(upper)) return idByCode.get(upper)!;
    for (const [alias, code] of Object.entries(taxonomy.aliases)) {
      if (alias.toLowerCase() === value.toLowerCase()) return idByCode.get(code) ?? null;
    }
    return null;
  };

  let created = 0;
  let updated = 0;
  for (const entry of registryPlayers) {
    const companyId = resolveCompanyId(entry.company);
    const [existing] = await db.select().from(players).where(eq(players.legacyId, entry.id));
    let playerId: string;
    if (existing) {
      await db
        .update(players)
        .set({ canonicalName: entry.canonical_name, companyId, updatedAt: new Date() })
        .where(eq(players.id, existing.id));
      playerId = existing.id;
      updated += 1;
    } else {
      const [row] = await db
        .insert(players)
        .values({ canonicalName: entry.canonical_name, companyId, legacyId: entry.id })
        .returning({ id: players.id });
      playerId = row!.id;
      created += 1;
    }

    // Canonical name and aliases resolve under the player's company, each
    // past company, and company-less (legacy registry alias_map semantics).
    const aliasNames = [entry.canonical_name, ...(entry.aliases ?? [])];
    const companyIds = new Set<string | null>([companyId, null]);
    for (const past of entry.past_companies ?? []) {
      companyIds.add(resolveCompanyId(past));
    }
    for (const aliasName of aliasNames) {
      for (const aliasCompanyId of companyIds) {
        await ensureAlias(db, playerId, aliasName.toLowerCase(), aliasCompanyId, 'registry');
      }
    }
  }
  return { created, updated };
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
