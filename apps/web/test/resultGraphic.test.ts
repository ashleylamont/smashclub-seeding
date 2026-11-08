import { describe, expect, it } from 'vitest';
import { confirmedPoolGraphics, escapeSvg, resultsSvg } from '../src/lib/resultGraphic';

describe('downloadable public results', () => {
  it('escapes names, titles and descriptions so aliases cannot introduce SVG markup', () => {
    const svg = resultsSvg('<script>event</script>', [
      { place: 1, alias: '<image href="bad"/>', detail: 'A & B' },
    ]);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('&lt;image href=&quot;bad&quot;/&gt;');
    expect(svg).toContain('A &amp; B');
    expect(escapeSvg("a'b")).toBe('a&apos;b');
  });
  it('includes all tied eighth places and preserves full pool standings', () => {
    const rows = [1, 2, 3, 3, 5, 6, 7, 8, 8, 10].map((place, i) => ({
      place,
      alias: `Entrant ${i}`,
    }));
    const svg = resultsSvg('Finals', rows);
    expect(svg).toContain('Entrant 7');
    expect(svg).toContain('Entrant 8');
    expect(svg).not.toContain('Entrant 9');
    expect(svg.match(/font-size="32">8<\/text>/g)).toHaveLength(2);
    expect(resultsSvg('Pool', rows, 'pool')).toContain('Entrant 9');
  });
});

it('exports confirmed placements separately by pool and only resolves public aliases', () => {
  const pools = confirmedPoolGraphics(
    [
      { division: 'upper', poolIndex: 0, playerId: 'a', place: 2 },
      { division: 'upper', poolIndex: 1, playerId: 'b', place: 1 },
      { division: 'upper', poolIndex: 0, playerId: 'missing', place: 1 },
    ],
    [
      { id: 'a', name: 'Alias A' },
      { id: 'b', name: 'Alias B' },
    ],
  );
  expect(pools).toHaveLength(2);
  expect(pools[0]).toEqual({
    title: 'Upper · Pool A',
    results: [{ place: 2, alias: 'Alias A', entryKey: 'a', detail: 'Confirmed pool placement' }],
  });
  expect(pools[1]!.title).toBe('Upper · Pool B');
});

it('names confirmed pools by actual structure and continues lettering after Z', () => {
  const entries = [{ id: 'a', name: 'Alias A' }];
  const open = [{ division: 'upper', poolIndex: 26, playerId: 'a', place: 1 }];
  expect(confirmedPoolGraphics(open, entries, 'pools_finals')[0]?.title).toBe('Open · Pool AA');
  expect(confirmedPoolGraphics(open, entries, 'dual_division')[0]?.title).toBe('Upper · Pool AA');
  const roundRobin = [{ ...open[0]!, poolIndex: 0 }];
  expect(confirmedPoolGraphics(roundRobin, entries, 'round_robin')[0]?.title).toBe(
    'Open round robin',
  );
});
