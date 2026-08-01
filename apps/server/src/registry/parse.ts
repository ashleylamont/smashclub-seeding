import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { CHARACTERS, isCharacterSlug } from '@smashclub/shared';

/**
 * players.yaml parsing and validation, shared by the CLI importer and the
 * admin import wizard. Pure — no database, so the wizard can show every
 * problem with a pasted file before anything is written.
 *
 * The registry format carries two fields the schema has no home for:
 *
 * - `numeric_id` is **ignored**. It was the legacy pipeline's stable ordering
 *   key; nothing in this app reads it, and players are keyed on `id` ->
 *   `players.legacy_id` instead. It is accepted (not an error) so real files
 *   import unchanged.
 * - `past_companies` is **not stored as history**. It is used as extra alias
 *   scope: a player's names are also aliased under each past employer, so
 *   "[Atlas] Sample P" still resolves after Sample moves on. This mirrors the
 *   legacy alias_map semantics and is what the previous CLI importer did.
 */

export interface RegistryPlayerInput {
  id: string;
  canonical_name: string;
  company?: string | null;
  aliases?: string[] | null;
  past_companies?: string[] | null;
  /** Legacy ordering key. Accepted and ignored — see the module comment. */
  numeric_id?: number | null;
  /** Smash character label or slug, used for leaderboard avatars. */
  main_character?: string | null;
}

/** A problem with one entry (or with the file as a whole, when `index` is -1). */
export interface RegistryIssue {
  /** Position in the `players:` list, or -1 for a whole-file problem. */
  index: number;
  /** The offending registry id when it could be read at all. */
  id: string | null;
  message: string;
}

export interface ParsedRegistry {
  entries: RegistryPlayerInput[];
  issues: RegistryIssue[];
}

/** Trim a value that may legitimately be absent or explicitly null. */
const optionalText = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .nullish();

const entrySchema = z.object({
  // Registry ids are sometimes bare numbers in YAML; accept and stringify.
  id: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .refine((value) => value.length > 0, { message: 'id must not be empty' }),
  canonical_name: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message: 'canonical_name must not be empty' })
    .refine((value) => value.length <= 120, { message: 'canonical_name is too long' }),
  company: optionalText,
  aliases: z.array(z.union([z.string(), z.number()]).transform((value) => String(value).trim())).nullish(),
  past_companies: z.array(z.union([z.string(), z.number()]).transform((value) => String(value).trim())).nullish(),
  numeric_id: z.number().nullish(),
  main_character: optionalText,
});

/**
 * Character label -> roster slug. The rule, in order:
 *   1. an exact slug ("bowser-jr") passes through,
 *   2. a roster display name or known alternate spelling matches
 *      case-insensitively ("Bowser Jr.", "R.O.B.", "Pokémon Trainer"),
 *   3. otherwise the label is slugified — lowercase, accents stripped, "&" ->
 *      "and", every other run of non-alphanumerics collapsed to a single "-",
 *      leading/trailing "-" removed ("Bowser Jr." -> "bowser-jr").
 * A slugified value still has to exist in the roster; unknown fighters are
 * reported against the entry rather than stored.
 */
export function characterSlugFor(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  if (isCharacterSlug(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  for (const character of CHARACTERS) {
    if (character.name.toLowerCase() === lower) return character.slug;
    if (character.aka?.some((spelling) => spelling.toLowerCase() === lower)) return character.slug;
  }

  const slug = slugifyCharacterName(trimmed);
  return isCharacterSlug(slug) ? slug : null;
}

export function slugifyCharacterName(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse a players.yaml document. Never throws: malformed YAML, a missing
 * `players:` list, a bad entry and a duplicate id all come back as issues so
 * the wizard can show them next to the id they belong to.
 */
export function parseRegistryYaml(text: string): ParsedRegistry {
  if (text.trim() === '') {
    return { entries: [], issues: [{ index: -1, id: null, message: 'The document is empty.' }] };
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entries: [], issues: [{ index: -1, id: null, message: `YAML could not be parsed: ${message}` }] };
  }

  // Both `players: [...]` and a bare top-level list are accepted; the club's
  // real file uses the former, and a pasted fragment is usually the latter.
  const list = Array.isArray(document)
    ? document
    : document && typeof document === 'object' && Array.isArray((document as { players?: unknown }).players)
      ? ((document as { players: unknown[] }).players)
      : null;
  if (list === null) {
    return {
      entries: [],
      issues: [{ index: -1, id: null, message: 'Expected a `players:` list at the top level.' }],
    };
  }

  const entries: RegistryPlayerInput[] = [];
  const issues: RegistryIssue[] = [];
  const seenIds = new Set<string>();

  list.forEach((raw, index) => {
    const rawId = readRawId(raw);
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.');
        issues.push({ index, id: rawId, message: field ? `${field}: ${issue.message}` : issue.message });
      }
      return;
    }

    const entry = parsed.data;
    if (seenIds.has(entry.id)) {
      issues.push({ index, id: entry.id, message: `Duplicate id “${entry.id}” — ids must be unique.` });
      return;
    }
    seenIds.add(entry.id);

    if (entry.main_character) {
      if (characterSlugFor(entry.main_character) === null) {
        issues.push({
          index,
          id: entry.id,
          message: `Unknown character “${entry.main_character}”.`,
        });
        return;
      }
    }

    const aliases = (entry.aliases ?? []).filter((alias) => alias !== '');
    const pastCompanies = (entry.past_companies ?? []).filter((company) => company !== '');
    entries.push({
      id: entry.id,
      canonical_name: entry.canonical_name,
      company: entry.company ?? null,
      aliases,
      past_companies: pastCompanies,
      main_character: entry.main_character ?? null,
    });
  });

  return { entries, issues };
}

/** Best-effort id for error reporting, before the entry has been validated. */
function readRawId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = (raw as { id?: unknown }).id;
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  if (typeof id === 'number') return String(id);
  return null;
}
