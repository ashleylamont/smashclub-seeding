import { describe, expect, it } from 'vitest';
import {
  candidateNames,
  findSimilarPlayer,
  firstNameCompatible,
  matchStructuredAlias,
  preferMoreSpecificDisplay,
  rankReviewCandidates,
  resolveStructuredAlias,
  scoreNameShape,
} from '../src/identity/alias';

const candidate = (name: string, companyCode: string | null = 'ATL') => ({ name, companyCode });

describe('no-cross-merge invariants (ported from legacy pytest suite)', () => {
  it('never treats Jack Morrison as Jackson through any auto path', () => {
    const pool = [candidate('Jackson')];
    // Structured: two-part name with a full (non-initial) last name never auto-links.
    expect(resolveStructuredAlias('Jack Morrison', 'ATL', pool)).toBeNull();
    // Name shape: first tokens differ, no tier applies.
    expect(scoreNameShape('Jack Morrison', 'Jackson')).toBe(0);
    // Fuzzy: similarity exists but only as a review-queue candidate, and well
    // below any historical auto-merge threshold.
    const fuzzy = findSimilarPlayer('Jack Morrison', 'ATL', pool);
    if (fuzzy) expect(fuzzy.score).toBeLessThan(0.85);
  });

  it('keeps distinct Matthews separate', () => {
    const pool = [candidate('Matthew Jakeman'), candidate('Matthew Chen'), candidate('Matthew Kokolich')];
    // "Matthew" alone is ambiguous across three candidates -> no auto-link.
    expect(resolveStructuredAlias('Matthew', 'ATL', pool)).toBeNull();
    expect(resolveStructuredAlias('Matthew Jakeman', 'ATL', pool)).toBeNull();
  });

  it('does not auto-link a bare first name when exactly one candidate exists only via review scoring', () => {
    const pool = [candidate('Jackson Lin')];
    // Unique first-name short form IS a safe structured link (legacy import
    // behaviour) ...
    expect(resolveStructuredAlias('Jackson', 'ATL', pool)?.name).toBe('Jackson Lin');
    // ... but the review ranking still surfaces it with the 0.84 tier for
    // queue display.
    expect(scoreNameShape('Jackson', 'Jackson Lin')).toBe(0.84);
  });

  it('resolves Josh C to Josh Cortese only when unambiguous', () => {
    expect(resolveStructuredAlias('Josh C', 'ATL', [candidate('Josh Cortese')])?.name).toBe('Josh Cortese');
    expect(
      resolveStructuredAlias('Josh C', 'ATL', [candidate('Josh Cortese'), candidate('Josh Chen')]),
    ).toBeNull();
  });

  it('scopes structured aliases by company', () => {
    const pool = [candidate('Josh Cortese', 'GOOG')];
    expect(resolveStructuredAlias('Josh C', 'ATL', pool)).toBeNull();
    expect(resolveStructuredAlias('Josh C', null, pool)?.name).toBe('Josh Cortese');
  });
});

describe('firstNameCompatible', () => {
  it('accepts equal names and >=4 char prefixes', () => {
    expect(firstNameCompatible('matt', 'matthew')).toBe(true);
    expect(firstNameCompatible('matthew', 'matt')).toBe(true);
    expect(firstNameCompatible('sam', 'samus')).toBe(false); // 3-char prefix
    expect(firstNameCompatible('kai', 'kai')).toBe(true);
  });
});

describe('findSimilarPlayer', () => {
  const pool = [candidate('Samus Aran'), candidate('Fox McCloud'), candidate('King Dedede', 'CAN')];

  it('finds exact and near-exact matches', () => {
    expect(findSimilarPlayer('Samus Aran', 'ATL', pool)?.candidate.name).toBe('Samus Aran');
    const typo = findSimilarPlayer('Samuss Aran', 'ATL', pool);
    expect(typo?.candidate.name).toBe('Samus Aran');
    expect(typo!.score).toBeGreaterThanOrEqual(0.75);
  });

  it('matches on first+last average when a middle token intrudes', () => {
    const result = findSimilarPlayer('Samus X Aran', 'ATL', pool);
    expect(result?.candidate.name).toBe('Samus Aran');
    expect(result!.score).toBeGreaterThanOrEqual(0.6);
  });

  it('scopes by company', () => {
    expect(findSimilarPlayer('King Dedede', 'ATL', pool)?.candidate.name).not.toBe('King Dedede');
  });

  it('returns null below the 0.6 floor', () => {
    expect(findSimilarPlayer('Zaphod Beeblebrox', 'ATL', pool)).toBeNull();
  });
});

describe('scoreNameShape tiers', () => {
  it('scores full first+last match 0.98', () => {
    expect(scoreNameShape('Fox McCloud', 'Fox Mid McCloud')).toBe(0.98);
  });
  it('scores last-initial match 0.92', () => {
    expect(scoreNameShape('Fox M', 'Fox McCloud')).toBe(0.92);
    expect(scoreNameShape('Fox McCloud', 'Fox M')).toBe(0.92);
  });
  it('scores bare-first-name match 0.84 both directions', () => {
    expect(scoreNameShape('Fox McCloud', 'Fox')).toBe(0.84);
    expect(scoreNameShape('Fox', 'Fox McCloud')).toBe(0.84);
  });
  it('scores unrelated names 0', () => {
    expect(scoreNameShape('Fox McCloud', 'Falco Lombardi')).toBe(0);
  });
});

describe('rankReviewCandidates', () => {
  it('puts the exact-name candidate first', () => {
    const pool = [candidate('Josh Cortese'), candidate('Josh Chen'), candidate('Joshua Corts')];
    const ranked = rankReviewCandidates('Josh Cortese', 'ATL', pool);
    expect(ranked[0]!.candidate.name).toBe('Josh Cortese');
    expect(ranked[0]!.score).toBe(1);
    expect(ranked.every((entry) => entry.score <= 1)).toBe(true);
  });

  it('surfaces multiple candidates when a short form is ambiguous', () => {
    const pool = [candidate('Fox McCloud'), candidate('Fox Mulder')];
    const ranked = rankReviewCandidates('Fox', 'ATL', pool);
    // Structured resolution is ambiguous (two Foxes) so nothing auto-links,
    // but both surface as 0.84 name-shape candidates for the human.
    expect(ranked).toHaveLength(2);
    expect(ranked.map((entry) => entry.score)).toEqual([0.84, 0.84]);
  });

  it('returns an empty list when nothing is plausible', () => {
    expect(rankReviewCandidates('Zaphod Beeblebrox', 'ATL', [candidate('Fox McCloud')])).toEqual([]);
  });
});

describe('aliases are matched alongside the canonical name', () => {
  const withAliases = (name: string, aliases: string[], companyCode: string | null = 'ATL') => ({
    name,
    companyCode,
    aliases,
  });

  it('scores a typo of an alias the canonical name could never reach', () => {
    const pool = [withAliases('Fox McCloud', ['starfox'])];
    // "starfoxx" against "Fox McCloud" is far below the floor...
    expect(findSimilarPlayer('starfoxx', 'ATL', [candidate('Fox McCloud')])).toBeNull();
    // ...but the club has already taught the system this player is "starfox".
    const hit = findSimilarPlayer('starfoxx', 'ATL', pool);
    expect(hit?.candidate.name).toBe('Fox McCloud');
    expect(hit?.matchedName).toBe('starfox');
  });

  it('keeps the best-scoring spelling and reports which one it was', () => {
    const pool = [withAliases('Fox McCloud', ['foxy mccloud'])];
    const ranked = rankReviewCandidates('Fox McCloud', 'ATL', pool);
    expect(ranked[0]!.score).toBe(1);
    expect(ranked[0]!.matchedName).toBe('Fox McCloud');
  });

  it('reports the canonical name when no alias is involved', () => {
    const ranked = rankReviewCandidates('Josh Cortese', 'ATL', [candidate('Josh Cortese')]);
    expect(ranked[0]!.matchedName).toBe('Josh Cortese');
  });

  it('resolves a short form of an alias structurally', () => {
    const pool = [withAliases('Ashley Lamont', ['sam vimes'])];
    const match = matchStructuredAlias('Sam V', 'ATL', pool);
    expect(match?.candidate.name).toBe('Ashley Lamont');
    expect(match?.matchedName).toBe('sam vimes');
  });

  it('still refuses to resolve an alias short form that is ambiguous', () => {
    const pool = [withAliases('Ashley Lamont', ['sam vimes']), candidate('Sam Vines')];
    expect(resolveStructuredAlias('Sam V', 'ATL', pool)).toBeNull();
  });

  it('does not double-count an alias that merely restates the name', () => {
    const pool = [withAliases('Fox McCloud', ['fox mccloud', '  '])];
    expect(candidateNames(pool[0]!)).toEqual(['Fox McCloud']);
    // One candidate, one entry — the alias must not split it into two rows.
    expect(rankReviewCandidates('Fox McCloud', 'ATL', pool)).toHaveLength(1);
  });
});

describe('preferMoreSpecificDisplay', () => {
  it('prefers company-tagged, longer names', () => {
    expect(preferMoreSpecificDisplay('[ATL] Fox McCloud', 'Fox McCloud')).toBe('[ATL] Fox McCloud');
    expect(preferMoreSpecificDisplay('Fox', 'Fox McCloud')).toBe('Fox McCloud');
    expect(preferMoreSpecificDisplay('[ATL] Fox', '[ATL] Fox McCloud')).toBe('[ATL] Fox McCloud');
  });
});
