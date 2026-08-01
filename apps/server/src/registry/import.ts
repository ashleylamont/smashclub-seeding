import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@smashclub/db';
import {
  companies,
  companyAliases,
  playerAliases,
  playerCharacters,
  players,
} from '@smashclub/db';
import {
  DEFAULT_COMPANY_TAXONOMY,
  cleanPlayerEntry,
  isNonCompanyLabel,
  preparePlayerEntry,
  type CompanyTaxonomy,
} from '@smashclub/engine';
import { characterSlugFor, parseRegistryYaml, type RegistryIssue, type RegistryPlayerInput } from './parse';

/**
 * players.yaml -> database, as a plan you can look at before it happens.
 *
 * The same code answers both questions the wizard asks — "what would this
 * do?" and "do it" — because apply *is* plan-then-execute inside one
 * transaction. Preview and apply can therefore never disagree, and applying an
 * already-imported file is a genuine no-op rather than a pile of writes that
 * happen to leave the rows looking the same.
 *
 * Idempotency key: `players.legacy_id` (the registry `id`). Re-running updates,
 * never duplicates.
 */

export interface RegistryAliasWrite {
  /** Normalised alias (lowercased cleaned form). */
  alias: string;
  /** Company scope this alias resolves under; null = company-less. */
  companyCode: string | null;
}

export interface RegistryEntryPlan {
  /** Registry id -> players.legacy_id. */
  id: string;
  canonicalName: string;
  action: 'create' | 'update' | 'unchanged';
  playerId: string | null;
  /** Company code the player would end up tagged with. */
  companyCode: string | null;
  /** Company code the player carries today (update/unchanged only). */
  currentCompanyCode: string | null;
  /** Set when the registry would rename an existing player. */
  nameChange: { from: string; to: string } | null;
  /** Set when the registry would re-tag an existing player's company. */
  companyChange: { from: string | null; to: string | null } | null;
  aliasesToAdd: RegistryAliasWrite[];
  charactersToAdd: string[];
  /** Non-blocking notes, e.g. an unrecognised past employer. */
  warnings: string[];
}

export interface RegistryImportPlan {
  entries: RegistryEntryPlan[];
  /** Employers named by the file that do not exist yet. */
  companiesToCreate: Array<{ code: string; name: string }>;
  /** Blocking problems. A plan with issues is never applied. */
  issues: RegistryIssue[];
  counts: {
    create: number;
    update: number;
    unchanged: number;
    aliases: number;
    characters: number;
    companies: number;
  };
}

export interface RegistryImportResult {
  created: number;
  updated: number;
  unchanged: number;
  aliasesAdded: number;
  charactersAdded: number;
  companiesCreated: number;
}

interface ImportOptions {
  /**
   * Seed the built-in company taxonomy first. The CLI bootstrap does (it is
   * the one-off that populates an empty database); the admin wizard does not,
   * because an import should not silently mint eighteen employers nobody
   * mentioned.
   */
  seedTaxonomy?: CompanyTaxonomy | false;
}

// ---------------------------------------------------------------------------
// Company resolution
// ---------------------------------------------------------------------------

interface CompanyRow {
  id: string | null;
  code: string;
  name: string;
}

/** Live company taxonomy, keyed by every string that should resolve to it. */
interface CompanyIndex {
  byKey: Map<string, CompanyRow>;
  byCode: Map<string, CompanyRow>;
  /** Codes already in use, so a derived code never collides. */
  takenCodes: Set<string>;
}

async function loadCompanyIndex(db: Db): Promise<CompanyIndex> {
  const rows = await db.select().from(companies);
  const aliasRows = await db.select().from(companyAliases);
  const index: CompanyIndex = { byKey: new Map(), byCode: new Map(), takenCodes: new Set() };
  for (const row of rows) {
    const entry: CompanyRow = { id: row.id, code: row.code, name: row.name };
    index.byCode.set(row.code, entry);
    index.takenCodes.add(row.code);
    index.byKey.set(row.code.toLowerCase(), entry);
    index.byKey.set(row.name.toLowerCase(), entry);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const alias of aliasRows) {
    const row = byId.get(alias.companyId);
    if (row) index.byKey.set(alias.aliasNorm.toLowerCase(), index.byCode.get(row.code)!);
  }
  return index;
}

/**
 * Derive a code for an employer the taxonomy has never seen: the first three
 * alphanumerics of the name, uppercased ("Figma" -> FIG), suffixed with a
 * counter if that is already taken. Short and stable, matching the hand-picked
 * codes already in use (ATL, CAN, GOOG).
 */
export function deriveCompanyCode(name: string, taken: ReadonlySet<string>): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'CO';
  const stem = base.slice(0, 3);
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Resolve a registry `company:` value against the live taxonomy, planning a new
 * company when it is genuinely unknown. "N/A" (and the other sign-up-sheet
 * markers) mean *no company* — they must never become a company named "N/A".
 */
function resolveCompany(
  value: string | null | undefined,
  index: CompanyIndex,
  pendingNew: Map<string, { code: string; name: string }>,
  create = true,
): { code: string | null; created: boolean } {
  const trimmed = (value ?? '').trim();
  if (!trimmed || isNonCompanyLabel(trimmed)) return { code: null, created: false };

  const existing = index.byKey.get(trimmed.toLowerCase());
  if (existing) return { code: existing.code, created: false };

  const alreadyPlanned = pendingNew.get(trimmed.toLowerCase());
  if (alreadyPlanned) return { code: alreadyPlanned.code, created: true };
  if (!create) return { code: null, created: false };

  const code = deriveCompanyCode(trimmed, index.takenCodes);
  index.takenCodes.add(code);
  pendingNew.set(trimmed.toLowerCase(), { code, name: trimmed });
  return { code, created: true };
}

// ---------------------------------------------------------------------------
// Alias normalisation
// ---------------------------------------------------------------------------

/**
 * The alias form stored in `player_aliases.alias_norm`: the same cleaner sync
 * runs over a bracket entry, lowercased. Sharing it is the point — an alias
 * normalised differently from the participant name it is meant to match would
 * never match anything.
 */
export function registryAliasNorm(text: string, taxonomy: CompanyTaxonomy): string {
  const cleaned = cleanPlayerEntry(preparePlayerEntry(text, taxonomy), taxonomy);
  return cleaned.name.toLowerCase();
}

/** The DB's company taxonomy, in the shape the engine's cleaner expects. */
function taxonomyFromIndex(index: CompanyIndex): CompanyTaxonomy {
  const taxonomy: CompanyTaxonomy = { codes: {}, aliases: {} };
  for (const [key, row] of index.byKey) {
    taxonomy.aliases[key] = row.code;
  }
  for (const [code, row] of index.byCode) {
    taxonomy.codes[code] = row.name;
  }
  return taxonomy;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Diff the registry against the database. Read-only: safe to run on every
 * keystroke of the wizard's preview if it came to that.
 */
export async function planRegistryImport(db: Db, entries: RegistryPlayerInput[]): Promise<RegistryImportPlan> {
  const index = await loadCompanyIndex(db);
  const taxonomy = taxonomyFromIndex(index);
  const pendingNew = new Map<string, { code: string; name: string }>();

  const legacyIds = entries.map((entry) => entry.id);
  const existingPlayers = legacyIds.length
    ? await db.select().from(players).where(inArray(players.legacyId, legacyIds))
    : [];
  const playerByLegacyId = new Map(existingPlayers.map((row) => [row.legacyId!, row]));
  const playerIds = existingPlayers.map((row) => row.id);

  const existingCharacters = playerIds.length
    ? await db.select().from(playerCharacters).where(inArray(playerCharacters.playerId, playerIds))
    : [];
  const characterKeys = new Set(existingCharacters.map((row) => `${row.playerId} ${row.characterSlug}`));

  const companyIdByCode = new Map<string, string | null>();
  const codeById = new Map<string, string>();
  for (const [code, row] of index.byCode) {
    companyIdByCode.set(code, row.id);
    if (row.id) codeById.set(row.id, code);
  }

  // Alias norms are unique per (norm, company) across the WHOLE registry, not
  // per player — a pair another player already owns is not ours to write. Load
  // every norm this file mentions and remember who holds it.
  const allNorms = [
    ...new Set(
      entries.flatMap((entry) =>
        [entry.canonical_name, ...(entry.aliases ?? [])].map((name) => registryAliasNorm(name, taxonomy)),
      ),
    ),
  ].filter((norm) => norm !== '');
  const aliasOwners = new Map<string, string>();
  if (allNorms.length > 0) {
    const rows = await db.select().from(playerAliases).where(inArray(playerAliases.aliasNorm, allNorms));
    for (const row of rows) aliasOwners.set(aliasKey(row.aliasNorm, row.companyId), row.playerId);
  }
  /** Pairs claimed by an earlier entry in this same file. */
  const claimedInPlan = new Map<string, string>();

  const planned: RegistryEntryPlan[] = [];
  for (const entry of entries) {
    const warnings: string[] = [];
    const company = resolveCompany(entry.company, index, pendingNew);
    const existing = playerByLegacyId.get(entry.id);
    const currentCompanyCode = existing?.companyId ? (codeById.get(existing.companyId) ?? null) : null;

    // Alias scopes: the player's company, every past employer, and company-less
    // — the legacy alias_map semantics, so short forms resolve whichever tag a
    // bracket entry happens to carry.
    // A past employer never mints a company: it is history, and the companies
    // list is meant to describe where members work now. An unrecognised one
    // just loses that alias scope, which is worth a note but not a failure.
    const scopeCodes = new Set<string | null>([company.code, null]);
    for (const past of entry.past_companies ?? []) {
      const resolved = resolveCompany(past, index, pendingNew, false);
      if (resolved.code === null) {
        if (past.trim() && !isNonCompanyLabel(past)) {
          warnings.push(`Past employer “${past}” is not a known company; no alias scope was added for it.`);
        }
        continue;
      }
      scopeCodes.add(resolved.code);
    }

    const aliasNames = [entry.canonical_name, ...(entry.aliases ?? [])];
    const aliasesToAdd: RegistryAliasWrite[] = [];
    const seenAliasPairs = new Set<string>();
    const contested = new Set<string>();
    for (const name of aliasNames) {
      const norm = registryAliasNorm(name, taxonomy);
      if (!norm) {
        warnings.push(`Alias “${name}” cleans to an empty name and was skipped.`);
        continue;
      }
      for (const code of scopeCodes) {
        // A company planned for creation has no id yet, so nothing can exist
        // under it: those aliases are always new.
        const companyId = code === null ? null : (companyIdByCode.get(code) ?? null);
        const key = aliasKey(norm, companyId, code);
        if (seenAliasPairs.has(key)) continue;
        seenAliasPairs.add(key);

        const owner = aliasOwners.get(key) ?? claimedInPlan.get(key);
        if (owner !== undefined) {
          // Already ours, or already someone else's - either way there is
          // nothing to write. The latter is worth saying out loud: it is how a
          // registry entry and a player minted from the review queue collide.
          if (owner !== existing?.id && !contested.has(norm)) {
            contested.add(norm);
            warnings.push(
              `“${norm}” already belongs to a different player, so this entry leaves it alone. Merge them from the registry if they are the same person.`,
            );
          }
          continue;
        }
        claimedInPlan.set(key, existing?.id ?? `new:${entry.id}`);
        aliasesToAdd.push({ alias: norm, companyCode: code });
      }
    }

    // Characters are additive: the registry pins a main, but an admin may have
    // added secondaries through the UI and an import must not wipe them.
    const charactersToAdd: string[] = [];
    if (entry.main_character) {
      const slug = characterSlugFor(entry.main_character);
      if (!slug) {
        // The wizard rejects these at parse time; this covers callers that hand
        // over entries directly (the CLI bootstrap, the dev harness).
        warnings.push(`Unknown character “${entry.main_character}” was skipped.`);
      } else if (!existing || !characterKeys.has(`${existing.id} ${slug}`)) {
        charactersToAdd.push(slug);
      }
    }

    const nameChange =
      existing && existing.canonicalName !== entry.canonical_name
        ? { from: existing.canonicalName, to: entry.canonical_name }
        : null;
    const companyChange =
      existing && currentCompanyCode !== company.code
        ? { from: currentCompanyCode, to: company.code }
        : null;

    const action: RegistryEntryPlan['action'] = !existing
      ? 'create'
      : nameChange || companyChange || aliasesToAdd.length > 0 || charactersToAdd.length > 0
        ? 'update'
        : 'unchanged';

    planned.push({
      id: entry.id,
      canonicalName: entry.canonical_name,
      action,
      playerId: existing?.id ?? null,
      companyCode: company.code,
      currentCompanyCode,
      nameChange,
      companyChange,
      aliasesToAdd,
      charactersToAdd,
      warnings,
    });
  }

  const companiesToCreate = [...pendingNew.values()];
  return {
    entries: planned,
    companiesToCreate,
    issues: [],
    counts: {
      create: planned.filter((entry) => entry.action === 'create').length,
      update: planned.filter((entry) => entry.action === 'update').length,
      unchanged: planned.filter((entry) => entry.action === 'unchanged').length,
      aliases: planned.reduce((sum, entry) => sum + entry.aliasesToAdd.length, 0),
      characters: planned.reduce((sum, entry) => sum + entry.charactersToAdd.length, 0),
      companies: companiesToCreate.length,
    },
  };
}

/**
 * Identity of an alias row as the unique index sees it: (norm, company) — note
 * it is not scoped by player, which is why one player can block another's
 * alias. A company that does not exist yet has no id, so its planned code
 * stands in, distinct from the bare null that means "company-less".
 */
function aliasKey(aliasNorm: string, companyId: string | null, pendingCode?: string | null): string {
  if (companyId === null && pendingCode) return `${aliasNorm} pending:${pendingCode}`;
  return `${aliasNorm} ${companyId ?? ''}`;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a registry to the database in one transaction. The plan is recomputed
 * *inside* the transaction rather than trusted from the caller, so a preview
 * the admin looked at five minutes ago can never write stale decisions.
 */
export async function applyRegistryEntries(
  db: Db,
  entries: RegistryPlayerInput[],
  options: ImportOptions = {},
): Promise<RegistryImportResult> {
  return db.transaction(async (tx) => {
    if (options.seedTaxonomy) await importCompanyTaxonomy(tx, options.seedTaxonomy);

    const plan = await planRegistryImport(tx, entries);

    const companyIdByCode = new Map<string, string>();
    for (const row of await tx.select().from(companies)) companyIdByCode.set(row.code, row.id);
    for (const company of plan.companiesToCreate) {
      const [row] = await tx
        .insert(companies)
        .values({ code: company.code, name: company.name })
        .onConflictDoUpdate({ target: companies.code, set: { name: company.name } })
        .returning({ id: companies.id });
      companyIdByCode.set(company.code, row!.id);
      // The employer's own name resolves to it next time a bracket entry
      // carries that tag, exactly as the seeded taxonomy's aliases do.
      await tx
        .insert(companyAliases)
        .values({ companyId: row!.id, aliasNorm: company.name.toLowerCase() })
        .onConflictDoNothing();
    }

    const result: RegistryImportResult = {
      created: 0,
      updated: 0,
      unchanged: 0,
      aliasesAdded: 0,
      charactersAdded: 0,
      companiesCreated: plan.companiesToCreate.length,
    };

    for (const entry of plan.entries) {
      const companyId = entry.companyCode ? (companyIdByCode.get(entry.companyCode) ?? null) : null;
      let playerId = entry.playerId;

      if (entry.action === 'create') {
        const [row] = await tx
          .insert(players)
          .values({ canonicalName: entry.canonicalName, companyId, legacyId: entry.id })
          .returning({ id: players.id });
        playerId = row!.id;
        result.created += 1;
      } else if (entry.action === 'update') {
        if (entry.nameChange || entry.companyChange) {
          await tx
            .update(players)
            .set({ canonicalName: entry.canonicalName, companyId, updatedAt: new Date() })
            .where(eq(players.id, playerId!));
        }
        result.updated += 1;
      } else {
        result.unchanged += 1;
        continue;
      }

      for (const alias of entry.aliasesToAdd) {
        const aliasCompanyId = alias.companyCode ? (companyIdByCode.get(alias.companyCode) ?? null) : null;
        const inserted = await tx
          .insert(playerAliases)
          .values({ playerId: playerId!, aliasNorm: alias.alias, companyId: aliasCompanyId, source: 'registry' })
          .onConflictDoNothing()
          .returning({ id: playerAliases.id });
        if (inserted.length > 0) result.aliasesAdded += 1;
      }

      if (entry.charactersToAdd.length > 0) {
        // Appended after whatever the player already has: the registry names a
        // main, but it does not get to reorder a picker the player set.
        const existing = await tx
          .select({ position: playerCharacters.position })
          .from(playerCharacters)
          .where(eq(playerCharacters.playerId, playerId!));
        let position = existing.reduce((max, row) => Math.max(max, row.position + 1), 0);
        for (const slug of entry.charactersToAdd) {
          const inserted = await tx
            .insert(playerCharacters)
            .values({ playerId: playerId!, characterSlug: slug, position })
            .onConflictDoNothing()
            .returning({ id: playerCharacters.id });
          if (inserted.length > 0) {
            result.charactersAdded += 1;
            position += 1;
          }
        }
      }
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// YAML entry points (what the wizard calls)
// ---------------------------------------------------------------------------

/** Parse + diff a pasted players.yaml. Writes nothing. */
export async function previewRegistryYaml(db: Db, text: string): Promise<RegistryImportPlan> {
  const parsed = parseRegistryYaml(text);
  const plan = parsed.entries.length > 0 ? await planRegistryImport(db, parsed.entries) : emptyPlan();
  return { ...plan, issues: parsed.issues };
}

export class RegistryValidationError extends Error {
  constructor(readonly issues: RegistryIssue[]) {
    const summary = issues
      .slice(0, 5)
      .map((issue) => (issue.id ? `${issue.id}: ${issue.message}` : issue.message))
      .join('; ');
    super(
      `players.yaml has ${issues.length} problem${issues.length === 1 ? '' : 's'}: ${summary}${
        issues.length > 5 ? '; …' : ''
      }`,
    );
    this.name = 'RegistryValidationError';
  }
}

/**
 * Parse + apply a pasted players.yaml. Refuses the whole file if any entry is
 * invalid: an import that silently skipped the three entries it could not read
 * is worse than one that says which three to fix.
 */
export async function applyRegistryYaml(db: Db, text: string): Promise<RegistryImportResult> {
  const parsed = parseRegistryYaml(text);
  if (parsed.issues.length > 0) throw new RegistryValidationError(parsed.issues);
  return applyRegistryEntries(db, parsed.entries);
}

function emptyPlan(): RegistryImportPlan {
  return {
    entries: [],
    companiesToCreate: [],
    issues: [],
    counts: { create: 0, update: 0, unchanged: 0, aliases: 0, characters: 0, companies: 0 },
  };
}

// ---------------------------------------------------------------------------
// Company taxonomy seeding (bootstrap path)
// ---------------------------------------------------------------------------

/** Upsert a whole taxonomy. Idempotent; used by the CLI bootstrap. */
export async function importCompanyTaxonomy(
  db: Db,
  taxonomy: CompanyTaxonomy = DEFAULT_COMPANY_TAXONOMY,
): Promise<Map<string, string>> {
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
