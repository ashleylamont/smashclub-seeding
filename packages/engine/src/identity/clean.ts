import { DEFAULT_COMPANY_TAXONOMY, isNonCompanyLabel, type CompanyTaxonomy } from './companies';

export interface CleanedPlayerEntry {
  name: string;
  /** Company code (e.g. ATL) when recognised; raw bracket text when not; null when absent. */
  companyCode: string | null;
  /**
   * A company-shaped label that the taxonomy does not recognise, e.g. a new
   * employer appearing for the first time. Surfaced so an admin can add it
   * rather than silently losing the player's company — which also weakens
   * company-scoped identity matching.
   */
  unknownCompanyLabel?: string;
}

/**
 * Clean a messy player entry (sign-up-sheet paste or Challonge display name)
 * and extract the name and company. Ported verbatim from the legacy
 * clean_player_entry — this encodes hard-won knowledge about real inputs:
 *
 * - "1 [Atlas]@Lucina"                                -> Lucina, ATL
 * - "[Google] Mako RutledgeGoogle"                    -> Mako Rutledge, GOOG
 * - "Jack Morrison (Susquehanna alum) (Host @Robin)"  -> Jack Morrison, null
 *   (parentheticals are removed *before* the @ check so a host mention
 *   doesn't mark someone as Atlassian)
 * - "[Atlas] @Pit Switch"                             -> Pit, ATL
 * - "[Atlas]@Lucina - Ready to taunt"                 -> Lucina, ATL
 */
export function cleanPlayerEntry(line: string, taxonomy: CompanyTaxonomy = DEFAULT_COMPANY_TAXONOMY): CleanedPlayerEntry {
  // Remove leading numbers (like "1 ", "12 ")
  let working = line.replace(/^\s*\d+\s*/, '');

  // Extract company from [brackets]
  let company: string | null = null;
  const bracketMatch = working.match(/\[([^\]]+)\]/);
  if (bracketMatch) {
    company = bracketMatch[1]!.trim();
    working = working.replace(/\[[^\]]+\]/g, '');
  }

  // Remove parenthetical information FIRST (like "(Host ...)"), so an @ in a
  // parenthetical (someone else's handle) is not attributed to this player.
  working = working.replace(/\([^)]*\)/g, '');

  // NOW check for @ symbol (indicates Atlassian employee)
  const hasAtSymbol = working.includes('@');
  working = working.replaceAll('@', '');

  // Remove everything after " - " (comment/description)
  const dashIndex = working.indexOf(' - ');
  if (dashIndex !== -1) {
    working = working.slice(0, dashIndex).trim();
  }

  let unknownCompanyLabel: string | undefined;
  if (company) {
    const lower = company.toLowerCase();
    let resolved: string | null = null;
    for (const [alias, code] of Object.entries(taxonomy.aliases)) {
      if (lower === alias.toLowerCase()) {
        resolved = code;
        break;
      }
    }
    if (!resolved && Object.hasOwn(taxonomy.codes, company.toUpperCase())) {
      resolved = company.toUpperCase();
    }
    if (resolved) {
      company = resolved;
    } else if (isNonCompanyLabel(company)) {
      // A marker like "N/A" or "DQ", not an employer.
      company = null;
    } else {
      // Keep the raw text as the company (legacy behaviour) but flag it so it
      // can be added to the taxonomy instead of quietly disappearing.
      unknownCompanyLabel = company;
    }
  }

  working = working.trim();

  // Remove duplicate company name glued to the end (e.g. "Mako RutledgeGoogle")
  if (company) {
    for (const alias of Object.keys(taxonomy.aliases)) {
      if (working.toLowerCase().endsWith(alias.toLowerCase())) {
        working = working.slice(0, -alias.length).trim();
        break;
      }
    }
  }

  // Remove "Switch" at the end (console preference notation)
  if (working.toLowerCase().endsWith(' switch')) {
    working = working.slice(0, -7).trim();
  }

  // Remove "Relevance" at the end if company is Relevance AI
  if (company === 'REL' && working.toLowerCase().endsWith(' relevance')) {
    working = working.slice(0, -10).trim();
  }

  const name = working.split(/\s+/).filter(Boolean).join(' ');

  if (!company && hasAtSymbol) {
    company = 'ATL';
  }

  return unknownCompanyLabel ? { name, companyCode: company, unknownCompanyLabel } : { name, companyCode: company };
}

/**
 * Pre-normalise Challonge-style company prefixes/suffixes into the bracket
 * form cleanPlayerEntry understands: "ATL|Name", "(ATL) Name" and
 * "Name (ATL)" all become "[ATL] Name". Ported from _prepare_player_entry.
 */
export function preparePlayerEntry(rawName: string, taxonomy: CompanyTaxonomy = DEFAULT_COMPANY_TAXONOMY): string {
  const stripped = rawName.trim();

  const pipeMatch = stripped.match(/^([^|]+)\|\s*(.+)$/);
  if (pipeMatch) {
    const code = resolveCode(pipeMatch[1]!, taxonomy);
    if (code) return `[${code}] ${pipeMatch[2]!.trim()}`;
  }

  const leadingParenMatch = stripped.match(/^\(([^)]+)\)\s*(.+)$/);
  if (leadingParenMatch) {
    const code = resolveCode(leadingParenMatch[1]!, taxonomy);
    if (code) return `[${code}] ${leadingParenMatch[2]!.trim()}`;
  }

  const trailingParenMatch = stripped.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (trailingParenMatch) {
    const code = resolveCode(trailingParenMatch[2]!, taxonomy);
    if (code) return `[${code}] ${trailingParenMatch[1]!.trim()}`;
  }

  return stripped;
}

function resolveCode(candidate: string, taxonomy: CompanyTaxonomy): string | null {
  const trimmed = candidate.trim();
  for (const code of Object.keys(taxonomy.codes)) {
    if (trimmed.toUpperCase() === code) return code;
  }
  for (const [alias, code] of Object.entries(taxonomy.aliases)) {
    if (trimmed.toLowerCase() === alias.toLowerCase()) return code;
  }
  return null;
}
