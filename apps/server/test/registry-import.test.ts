import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { companies, playerAliases, playerCharacters, players, type Db } from '@smashclub/db';
import { importCompanyTaxonomy } from '../src/registry/import';
import { characterSlugFor, parseRegistryYaml } from '../src/registry/parse';
import { createTestDb } from './helpers/testDb';
import { adminCaller } from './helpers/adminCaller';

let db: Db;
let close: () => Promise<void>;

/** The shape of the club's real players.yaml, warts and all. */
const REGISTRY_YAML = `players:
  - id: vincent
    canonical_name: Vincent
    company: AMD
    aliases: []
    numeric_id: 1
  - id: alex-h
    canonical_name: Alex Hogue
    company: N/A
    past_companies: [N/A, Atlassian]
    aliases: [Alex H, Alex]
    main_character: Ness
    numeric_id: 2
  - id: belinda-wong
    canonical_name: Belinda Wong
    company: Atlassian
    aliases: [Bel W, Belinda W, Belinda]
    main_character: "Bowser Jr."
    numeric_id: 107
`;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function companyCodeOf(legacyId: string): Promise<string | null> {
  const [row] = await db
    .select({ code: companies.code })
    .from(players)
    .leftJoin(companies, eq(players.companyId, companies.id))
    .where(eq(players.legacyId, legacyId));
  return row?.code ?? null;
}

async function aliasesOf(legacyId: string): Promise<Array<{ alias: string; company: string | null }>> {
  const [player] = await db.select().from(players).where(eq(players.legacyId, legacyId));
  const rows = await db
    .select({ alias: playerAliases.aliasNorm, company: companies.code })
    .from(playerAliases)
    .leftJoin(companies, eq(playerAliases.companyId, companies.id))
    .where(eq(playerAliases.playerId, player!.id));
  return rows
    .map((row) => ({ alias: row.alias, company: row.company ?? null }))
    .sort((a, b) => a.alias.localeCompare(b.alias) || String(a.company).localeCompare(String(b.company)));
}

describe('registry import — preview', () => {
  it('plans a create per entry and names the companies it would add', async () => {
    const plan = await adminCaller(db).previewRegistryImport({ yaml: REGISTRY_YAML });

    expect(plan.issues).toEqual([]);
    expect(plan.counts.create).toBe(3);
    expect(plan.counts.update).toBe(0);
    expect(plan.counts.unchanged).toBe(0);
    expect(plan.entries.map((entry) => entry.id)).toEqual(['vincent', 'alex-h', 'belinda-wong']);
    expect(plan.entries.every((entry) => entry.action === 'create')).toBe(true);

    // "N/A" is a marker, not an employer: it must never become a company.
    expect(plan.companiesToCreate.map((company) => company.name).sort()).toEqual(['AMD', 'Atlassian']);
    expect(plan.entries.find((entry) => entry.id === 'alex-h')!.companyCode).toBeNull();

    const belinda = plan.entries.find((entry) => entry.id === 'belinda-wong')!;
    expect(belinda.charactersToAdd).toEqual(['bowser-jr']);
    expect(belinda.aliasesToAdd.map((alias) => alias.alias)).toContain('bel w');
  });

  it('writes nothing', async () => {
    await adminCaller(db).previewRegistryImport({ yaml: REGISTRY_YAML });
    expect(await db.select().from(players)).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
  });

  it('reuses a company that already exists instead of creating a second one', async () => {
    await importCompanyTaxonomy(db);
    const plan = await adminCaller(db).previewRegistryImport({ yaml: REGISTRY_YAML });
    expect(plan.companiesToCreate).toEqual([]);
    expect(plan.entries.find((entry) => entry.id === 'belinda-wong')!.companyCode).toBe('ATL');
  });
});

describe('registry import — apply', () => {
  it('maps ids, companies, aliases and characters onto the schema', async () => {
    await importCompanyTaxonomy(db);
    const result = await adminCaller(db).applyRegistryImport({ yaml: REGISTRY_YAML });
    expect(result.created).toBe(3);
    expect(result.companiesCreated).toBe(0);

    // id -> legacy_id, the idempotency key.
    const rows = await db.select().from(players);
    expect(rows.map((row) => row.legacyId).sort()).toEqual(['alex-h', 'belinda-wong', 'vincent']);

    expect(await companyCodeOf('vincent')).toBe('AMD');
    expect(await companyCodeOf('belinda-wong')).toBe('ATL');
    // company: N/A means no company, not a company called "N/A".
    expect(await companyCodeOf('alex-h')).toBeNull();
    expect(await db.select().from(companies).where(eq(companies.name, 'N/A'))).toHaveLength(0);

    // The canonical name is an alias too, and past employers add alias scope.
    const alexAliases = await aliasesOf('alex-h');
    expect(alexAliases).toContainEqual({ alias: 'alex hogue', company: null });
    expect(alexAliases).toContainEqual({ alias: 'alex h', company: null });
    expect(alexAliases).toContainEqual({ alias: 'alex h', company: 'ATL' });
    expect(alexAliases.every((row) => row.alias === row.alias.toLowerCase())).toBe(true);

    const [alex] = await db.select().from(players).where(eq(players.legacyId, 'alex-h'));
    const alexCharacters = await db
      .select()
      .from(playerCharacters)
      .where(eq(playerCharacters.playerId, alex!.id));
    expect(alexCharacters.map((row) => row.characterSlug)).toEqual(['ness']);
  });

  it('creates the companies the preview promised, and only those', async () => {
    const result = await adminCaller(db).applyRegistryImport({ yaml: REGISTRY_YAML });
    expect(result.companiesCreated).toBe(2);
    const rows = await db.select().from(companies);
    expect(rows.map((row) => row.name).sort()).toEqual(['AMD', 'Atlassian']);
    expect(await companyCodeOf('belinda-wong')).toBe('ATL');
  });

  it('is idempotent: applying the same file twice changes nothing the second time', async () => {
    await importCompanyTaxonomy(db);
    const caller = adminCaller(db);
    await caller.applyRegistryImport({ yaml: REGISTRY_YAML });

    const before = {
      players: await db.select().from(players),
      aliases: await db.select().from(playerAliases),
      characters: await db.select().from(playerCharacters),
      companies: await db.select().from(companies),
    };

    const plan = await caller.previewRegistryImport({ yaml: REGISTRY_YAML });
    expect(plan.counts).toMatchObject({ create: 0, update: 0, unchanged: 3, aliases: 0, characters: 0, companies: 0 });

    const second = await caller.applyRegistryImport({ yaml: REGISTRY_YAML });
    expect(second).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 3,
      aliasesAdded: 0,
      charactersAdded: 0,
      companiesCreated: 0,
    });

    expect(await db.select().from(players)).toHaveLength(before.players.length);
    expect(await db.select().from(playerAliases)).toHaveLength(before.aliases.length);
    expect(await db.select().from(playerCharacters)).toHaveLength(before.characters.length);
    expect(await db.select().from(companies)).toHaveLength(before.companies.length);
  });

  it('updates an existing player rather than duplicating them', async () => {
    await importCompanyTaxonomy(db);
    const caller = adminCaller(db);
    await caller.applyRegistryImport({ yaml: REGISTRY_YAML });

    const renamed = REGISTRY_YAML.replace('canonical_name: Belinda Wong', 'canonical_name: Belinda Wong-Smith');
    const plan = await caller.previewRegistryImport({ yaml: renamed });
    const belinda = plan.entries.find((entry) => entry.id === 'belinda-wong')!;
    expect(belinda.action).toBe('update');
    expect(belinda.nameChange).toEqual({ from: 'Belinda Wong', to: 'Belinda Wong-Smith' });

    await caller.applyRegistryImport({ yaml: renamed });
    const rows = await db.select().from(players).where(eq(players.legacyId, 'belinda-wong'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonicalName).toBe('Belinda Wong-Smith');
    // The old spelling stays aliased, so brackets that still use it resolve.
    expect((await aliasesOf('belinda-wong')).map((row) => row.alias)).toContain('belinda wong');
  });

  it('adds a registry main without discarding characters set in the UI', async () => {
    await importCompanyTaxonomy(db);
    const caller = adminCaller(db);
    const { playerId } = await caller.createPlayer({
      canonicalName: 'Belinda Wong',
      characters: ['fox'],
      aliases: [],
      companyCode: null,
      displayName: null,
    });
    // Give the manually-created player the registry id, as a merge would.
    await db.update(players).set({ legacyId: 'belinda-wong' }).where(eq(players.id, playerId));

    await caller.applyRegistryImport({ yaml: REGISTRY_YAML });
    const rows = await db
      .select()
      .from(playerCharacters)
      .where(eq(playerCharacters.playerId, playerId));
    expect(rows.sort((a, b) => a.position - b.position).map((row) => row.characterSlug)).toEqual([
      'fox',
      'bowser-jr',
    ]);
  });
});

describe('registry import — validation', () => {
  it('reports the offending id for each bad entry and refuses to apply', async () => {
    const yaml = `players:
  - id: ok-player
    canonical_name: Fine Person
  - id: no-name
    canonical_name: ""
  - id: ok-player
    canonical_name: Duplicated Id
  - id: bad-character
    canonical_name: Someone Else
    main_character: Waluigi
`;
    const caller = adminCaller(db);
    const plan = await caller.previewRegistryImport({ yaml });

    expect(plan.issues.map((issue) => issue.id).sort()).toEqual(['bad-character', 'no-name', 'ok-player']);
    expect(plan.issues.find((issue) => issue.id === 'ok-player')!.message).toMatch(/Duplicate id/);
    expect(plan.issues.find((issue) => issue.id === 'bad-character')!.message).toMatch(/Waluigi/);
    // The one good entry is still previewed, so the admin sees the whole picture.
    expect(plan.entries.map((entry) => entry.id)).toEqual(['ok-player']);

    await expect(caller.applyRegistryImport({ yaml })).rejects.toThrow(/problem/);
    expect(await db.select().from(players)).toHaveLength(0);
  });

  it('rejects a document that is not a players list', async () => {
    const plan = await adminCaller(db).previewRegistryImport({ yaml: 'nope: true\n' });
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]!.message).toMatch(/players/);
  });

  it('reports unparseable YAML instead of throwing', async () => {
    const plan = await adminCaller(db).previewRegistryImport({ yaml: 'players:\n  - id: "unterminated\n' });
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]!.message).toMatch(/YAML could not be parsed/);
  });
});

describe('registry parsing', () => {
  it('ignores numeric_id and keeps past_companies as alias context', () => {
    const parsed = parseRegistryYaml(REGISTRY_YAML);
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries[1]).toEqual({
      id: 'alex-h',
      canonical_name: 'Alex Hogue',
      company: 'N/A',
      aliases: ['Alex H', 'Alex'],
      past_companies: ['N/A', 'Atlassian'],
      main_character: 'Ness',
    });
  });

  it('resolves character labels to roster slugs', () => {
    expect(characterSlugFor('Bowser Jr.')).toBe('bowser-jr');
    expect(characterSlugFor('bowser-jr')).toBe('bowser-jr');
    expect(characterSlugFor('Mr. Game & Watch')).toBe('mr-game-and-watch');
    expect(characterSlugFor('Pokémon Trainer')).toBe('pokemon-trainer');
    expect(characterSlugFor('R.O.B.')).toBe('rob');
    expect(characterSlugFor('Waluigi')).toBeNull();
  });
});
