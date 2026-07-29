/**
 * Company taxonomy. These defaults mirror the legacy hardcoded tables; the
 * app stores the live taxonomy in the DB (admin-editable) and passes it in,
 * so the engine never needs a code change to add a company.
 */
export interface CompanyTaxonomy {
  /** code -> full display name, e.g. ATL -> Atlassian */
  codes: Record<string, string>;
  /** alias (any casing) -> code, e.g. Atlas -> ATL */
  aliases: Record<string, string>;
}

export const DEFAULT_COMPANY_TAXONOMY: CompanyTaxonomy = {
  codes: {
    ATL: 'Atlassian',
    CAN: 'Canva',
    OPT: 'Optiver',
    GOOG: 'Google',
    WOW: 'Woolworths',
    REL: 'Relevance AI',
    SUS: 'Susquehanna',
    AMD: 'AMD',
    LYR: 'Lyra',
    DEC: 'Deckard',
    ANA: 'Anaplan',
    // Present in the club's real history but absent from the original
    // hardcoded list, so these players were losing their company entirely.
    IMC: 'IMC',
    MAC: 'Macquarie',
    TIK: 'TikTok',
    AWS: 'AWS',
    MDB: 'MongoDB',
    CBA: 'CBA',
    ORC: 'Oracle',
  },
  aliases: {
    Atlas: 'ATL',
    Atlassian: 'ATL',
    Google: 'GOOG',
    Canva: 'CAN',
    Optiver: 'OPT',
    Woolworths: 'WOW',
    Woolies: 'WOW',
    'Relevance AI': 'REL',
    Relevance: 'REL',
    Susquehanna: 'SUS',
    AMD: 'AMD',
    Lyra: 'LYR',
    Deckard: 'DEC',
    Anaplan: 'ANA',
    IMC: 'IMC',
    Macquarie: 'MAC',
    Macq: 'MAC',
    TikTok: 'TIK',
    Tiktok: 'TIK',
    AWS: 'AWS',
    Amazon: 'AWS',
    Mongo: 'MDB',
    MongoDB: 'MDB',
    CBA: 'CBA',
    Commbank: 'CBA',
    Oracle: 'ORC',
  },
};

/**
 * Labels that appear where a company would but are not employers — the club's
 * sign-up sheets use them as markers. Recognised so they are not mistaken for
 * a new company, and not reported as unknown.
 */
export const NON_COMPANY_LABELS = new Set(['n/a', 'na', 'unknown', 'none', 'dq', 'tbd', 'guest']);

export function isNonCompanyLabel(text: string): boolean {
  return NON_COMPANY_LABELS.has(text.trim().toLowerCase());
}

/** Resolve free text (a code, full name, or alias) to a company code, if known. */
export function resolveCompanyCode(text: string, taxonomy: CompanyTaxonomy = DEFAULT_COMPANY_TAXONOMY): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (upper in taxonomy.codes) return upper;
  const lower = trimmed.toLowerCase();
  for (const [alias, code] of Object.entries(taxonomy.aliases)) {
    if (alias.toLowerCase() === lower) return code;
  }
  return null;
}
