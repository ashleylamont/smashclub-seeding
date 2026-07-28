import { describe, expect, it } from 'vitest';
import parityFixtures from './fixtures/difflib-parity.json';
import { similarityRatio } from '../src/identity/similarity';

describe('similarityRatio (difflib parity)', () => {
  // Fixture ratios generated with CPython's difflib.SequenceMatcher — the
  // scores rank review-queue candidates, so parity with the legacy pipeline
  // matters.
  for (const { a, b, ratio } of parityFixtures as Array<{ a: string; b: string; ratio: number }>) {
    it(`ratio(${JSON.stringify(a.slice(0, 30))}, ${JSON.stringify(b.slice(0, 30))}) = ${ratio.toFixed(4)}`, () => {
      expect(similarityRatio(a, b)).toBeCloseTo(ratio, 10);
    });
  }
});
