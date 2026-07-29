import { describe, expect, it } from 'vitest';
import { defaultGlickoSettings } from '@smashclub/shared';
import { updateRating } from '../src/glicko2';
import fixture from './fixtures/legacy-set-updates.json';

/**
 * Golden-master parity against the legacy Python engine.
 *
 * The fixture holds real per-set outputs recorded by the Python implementation
 * on the club's actual match history — pre-state, outcome and post-state, as
 * numbers only, with no names or identifiers. It is the external ground truth
 * for three things this port must not silently change:
 *
 *   - the Glicko-2 update itself
 *   - the corrected volatility function (the Python code monkeypatched its
 *     library because upstream used the rating where the paper has phi²; this
 *     port implements the corrected form directly)
 *   - applying the match weight by lerping rating and RD while leaving
 *     volatility fully updated
 *
 * The source export rounds the weight to 3 decimals, which alone shifts a
 * rating by ~5e-3, so the weight is solved from the recorded rating movement
 * and then cross-checked: the *same* scalar must also explain the RD movement.
 * That is what makes this a real test of the update rather than of arithmetic.
 */

interface Entry {
  preRating: number;
  preRd: number;
  preVol: number;
  oppPreRating: number;
  oppPreRd: number;
  won: boolean;
  recordedWeight: number;
  postRating: number;
  postRd: number;
  postVol: number;
  isRookieBracket: boolean;
}

const entries = fixture.entries as Entry[];
const { tau } = defaultGlickoSettings;

describe('legacy Python engine parity', () => {
  it('has a representative fixture', () => {
    expect(entries.length).toBeGreaterThanOrEqual(50);
    // Spans provisional through settled players, and both brackets.
    expect(Math.max(...entries.map((e) => e.preRd))).toBeGreaterThan(300);
    expect(Math.min(...entries.map((e) => e.preRd))).toBeLessThan(100);
    expect(entries.some((e) => e.isRookieBracket)).toBe(true);
    expect(entries.some((e) => !e.isRookieBracket)).toBe(true);
  });

  it('reproduces every recorded set update', () => {
    const rdDeltas: number[] = [];
    const volDeltas: number[] = [];
    const weightDeltas: number[] = [];

    for (const [index, entry] of entries.entries()) {
      const pre = { rating: entry.preRating, rd: entry.preRd, vol: entry.preVol };
      const updated = updateRating(
        pre,
        [{ rating: entry.oppPreRating, rd: entry.oppPreRd, outcome: entry.won ? 1 : 0 }],
        tau,
      );

      const ratingSpan = updated.rating - pre.rating;
      expect(Math.abs(ratingSpan), `entry ${index} should move the rating`).toBeGreaterThan(1e-9);
      const weight = (entry.postRating - pre.rating) / ratingSpan;

      // The same weight must explain the RD movement — a wrong Glicko-2 update
      // would break this even though the rating was used to derive the weight.
      const predictedRd = pre.rd + (updated.rd - pre.rd) * weight;
      rdDeltas.push(Math.abs(predictedRd - entry.postRd));

      // Volatility is recorded unlerped, straight from the update.
      volDeltas.push(Math.abs(updated.vol - entry.postVol));

      weightDeltas.push(Math.abs(weight - entry.recordedWeight));
    }

    // Tolerances bounded by the export's precision: 6 decimals on ratings/RD,
    // 3 on the weight.
    expect(Math.max(...rdDeltas)).toBeLessThan(5e-5);
    expect(Math.max(...volDeltas)).toBeLessThan(1e-6);
    expect(Math.max(...weightDeltas)).toBeLessThan(1e-3);
  });

  it('weights above 1 overshoot the Glicko-2 update — the defect the port clamps', () => {
    // Rookie loss tiers of 1.0 and 1.25 multiply into the weight, and the
    // legacy engine used it as an unclamped lerp factor, so a rating moved
    // further than Glicko-2 said and RD shrank more than the evidence allows.
    const pre = { rating: 1500, rd: 200, vol: 0.06 };
    const updated = updateRating(pre, [{ rating: 1500, rd: 200, outcome: 0 }], tau);
    const overshoot = {
      rating: pre.rating + (updated.rating - pre.rating) * 1.25,
      rd: pre.rd + (updated.rd - pre.rd) * 1.25,
    };
    expect(Math.abs(overshoot.rating - pre.rating)).toBeGreaterThan(Math.abs(updated.rating - pre.rating));
    expect(overshoot.rd).toBeLessThan(updated.rd);
  });
});
