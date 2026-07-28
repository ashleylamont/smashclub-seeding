import { describe, expect, it } from 'vitest';
import { cleanPlayerEntry, preparePlayerEntry } from '../src/identity/clean';

// These cases are ported verbatim from legacy tests/test_smart_parsing.py —
// they encode real messy sign-up-sheet inputs the pipeline must survive.
describe('cleanPlayerEntry', () => {
  const cases: Array<[input: string, name: string, company: string | null]> = [
    ['1 [Atlas]@Lucina', 'Lucina', 'ATL'],
    ['[Atlas]@Robin', 'Robin', 'ATL'],
    // @ inside parentheses is someone else's handle (their host), so no company
    ['Jack Morrison (Susquehanna, Smashclub alum) (Host @Robin)', 'Jack Morrison', null],
    ['[Google] Mako RutledgeGoogle', 'Mako Rutledge', 'GOOG'],
    ['[Google] Reinhardt Wilhelm Google', 'Reinhardt Wilhelm', 'GOOG'],
    ['[Relevance AI] Satya Vaswani', 'Satya Vaswani', 'REL'],
    ['[Atlas]@Shulk', 'Shulk', 'ATL'],
    ['  [ATL]   Bob    Smith  ', 'Bob Smith', 'ATL'],
    ['[Atlas] @Pit Switch', 'Pit', 'ATL'],
    ['[Atlas]@Lucina - Ready to taunt and spike Donkeykong', 'Lucina', 'ATL'],
    ['[Relevance AI] Jack Morrison Relevance', 'Jack Morrison', 'REL'],
    ['[Atlas]@Solid Snake (Dietary: Gluten Free)', 'Solid Snake', 'ATL'],
    // @ outside parentheses infers Atlassian
    ['@Jack Morrison', 'Jack Morrison', 'ATL'],
  ];

  for (const [input, name, company] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      const result = cleanPlayerEntry(input);
      expect(result.name).toBe(name);
      expect(result.companyCode).toBe(company);
    });
  }
});

describe('preparePlayerEntry', () => {
  it('normalises pipe-prefixed company', () => {
    expect(preparePlayerEntry('ATL|Fox McCloud')).toBe('[ATL] Fox McCloud');
  });

  it('normalises leading parenthesised company', () => {
    expect(preparePlayerEntry('(ATL) Fox McCloud')).toBe('[ATL] Fox McCloud');
  });

  it('normalises trailing parenthesised company', () => {
    expect(preparePlayerEntry('Fox McCloud (Canva)')).toBe('[CAN] Fox McCloud');
  });

  it('leaves non-company parentheticals alone', () => {
    expect(preparePlayerEntry('Fox McCloud (the fast one)')).toBe('Fox McCloud (the fast one)');
  });

  it('leaves plain names alone', () => {
    expect(preparePlayerEntry('  Fox McCloud ')).toBe('Fox McCloud');
  });
});
