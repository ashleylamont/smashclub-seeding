import { describe, expect, it } from 'vitest';
import {
  bracketGraphicSvg,
  bracketPngScale,
  hasExportableBracket,
} from '../src/lib/bracketGraphic';
import { bracketFixture } from './fixtures/brackets';

const context = {
  eventName: 'Club & <"night">',
  eventDate: '4 Oct 2026',
  scope: 'Open championship',
  state: 'published',
  format: 'singles',
} as const;
const measure = (value: string, size: number) => Array.from(value).length * size * 0.58;

describe('public bracket graphics', () => {
  it('exports real winners, losers, cross-lane feeds, conditional reset and byes', () => {
    const matches = bracketFixture(7);
    const losers = matches.find(({ bracketLane }) => bracketLane === 'losers')!;
    Object.assign(losers, { player1Id: 'entrant-2', player1Name: 'Losers entrant' });
    const graphic = bracketGraphicSvg(context, matches, measure)!;
    expect(graphic.svg).toContain('Club &amp; &lt;&quot;night&quot;&gt;');
    expect(graphic.svg).toContain('Winners bracket');
    expect(graphic.svg).toContain('Losers bracket');
    expect(graphic.svg).toContain('Reset · if needed');
    expect(graphic.svg).toContain('Reset final · If needed');
    expect(graphic.svg).toContain('Loser of winners');
    expect(graphic.svg).toContain('· Bye');
    expect(graphic.svg).toContain('stroke-dasharray');
    expect(graphic.svg).not.toMatch(/<image|<script|href=/);
  });

  it('retains recorded zero and hides live, automatic and unplayed score values', () => {
    const matches = bracketFixture(7, false);
    const ready = matches.filter(({ status }) => status === 'ready');
    Object.assign(ready[0]!, {
      status: 'complete',
      outcome: 'played',
      score1: 0,
      score2: 2,
      winnerId: ready[0]!.player2Id,
      player1Name: '<script> & 艾麗',
    });
    Object.assign(ready[1]!, { status: 'playing', score1: 927, score2: 928 });
    Object.assign(ready[2]!, {
      status: 'complete',
      outcome: 'forfeit',
      score1: 929,
      winnerId: ready[2]!.player1Id,
    });
    const result = bracketGraphicSvg({ ...context, state: 'closed' }, matches, measure)!;
    expect(result.svg).toContain('Recorded draw');
    expect(result.svg).toContain('>0</text>');
    expect(result.svg).toContain('>2</text>');
    expect(result.svg).toContain('&lt;script&gt; &amp; 艾麗');
    expect(result.svg).toContain('· Forfeit');
    expect(result.svg).not.toMatch(/>(927|928|929)<\/text>/);
    expect(result.svg).not.toContain('<script>');
  });

  it('rejects empty, unknown, oversize, duplicate and unresolved topology', () => {
    const matches = bracketFixture(8, false);
    expect(hasExportableBracket(matches)).toBe(true);
    expect(hasExportableBracket([])).toBe(false);
    expect(hasExportableBracket(matches.slice(1))).toBe(false);
    for (const unsupported of [
      { bracketLane: 'somewhere' },
      { nativeRound: 18, nativeSlot: 511 },
      { nativeSlot: -1 },
      { parent1MatchId: 'missing-source' },
      { stage: 'group' },
    ])
      expect(hasExportableBracket([{ ...matches[0]!, ...unsupported }, ...matches.slice(1)])).toBe(
        false,
      );
    expect(hasExportableBracket([...matches, { ...matches[0]!, id: 'duplicate-position' }])).toBe(
      false,
    );
  });

  it('shows a recorded reset only when that match exists and preserves an untaken call', () => {
    const matches = bracketFixture(4);
    const called = matches.find(({ status }) => status === 'ready')!;
    Object.assign(called, { status: 'playing', started: false, called: false });
    const reset = matches.find(({ bracketLane }) => bracketLane === 'reset')!;
    Object.assign(reset, {
      status: 'complete',
      outcome: 'played',
      label: 'Reset final (if needed)',
      player1Id: 'entrant-0',
      player2Id: 'entrant-1',
      player1Name: 'First player',
      player2Name: 'Second player',
      winnerId: 'entrant-1',
      score1: 1,
      score2: 2,
    });
    const played = bracketGraphicSvg(context, matches, measure)!;
    expect(played.svg).toContain('· Called');
    expect(played.svg).not.toContain('Playing now');
    expect(played.svg).not.toContain('if needed');
    const noReset = bracketGraphicSvg(
      { ...context, state: 'closed' },
      matches.filter((match) => match !== reset),
      measure,
    )!;
    expect(noReset.svg).toContain('Grand final');
    expect(noReset.svg).not.toContain('and reset');
    expect(noReset.svg).not.toContain('Reset final');
  });

  it('bounds the PNG dimensions and pixel budget without constraining SVG', () => {
    for (const image of [
      { width: 1200, height: 1800 },
      { width: 4000, height: 6000 },
      { width: 2200, height: 20000 },
    ]) {
      const scale = bracketPngScale({ ...image, svg: '' });
      expect(Math.max(image.width, image.height) * scale).toBeLessThanOrEqual(4096);
      expect(image.width * image.height * scale ** 2).toBeLessThanOrEqual(12_000_001);
    }
  });
});
