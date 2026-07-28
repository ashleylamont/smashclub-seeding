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
  },
  aliases: {
    Atlas: 'ATL',
    Atlassian: 'ATL',
    Google: 'GOOG',
    Canva: 'CAN',
    Optiver: 'OPT',
    Woolworths: 'WOW',
    'Relevance AI': 'REL',
    Relevance: 'REL',
    Susquehanna: 'SUS',
    AMD: 'AMD',
    Lyra: 'LYR',
    Deckard: 'DEC',
    Anaplan: 'ANA',
  },
};

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
