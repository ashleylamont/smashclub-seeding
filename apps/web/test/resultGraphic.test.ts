import { describe, expect, it } from 'vitest';
import { confirmedPoolGraphics, escapeSvg, resultsSvg } from '../src/lib/resultGraphic';

describe('downloadable public results', () => {
  it('escapes names, titles and descriptions so aliases cannot introduce SVG markup', () => {
    const svg = resultsSvg('<script>event</script>', [{ place: 1, alias: '<image href="bad"/>', detail: 'A & B' }]);
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('<image');
    expect(svg).toContain('&lt;image href=&quot;bad&quot;/&gt;');
    expect(svg).toContain('A &amp; B');
    expect(escapeSvg("a'b")).toBe('a&apos;b');
  });
  it('preserves tied places and limits the graphic to eight results', () => {
    const svg = resultsSvg('Finals', Array.from({ length: 9 }, (_, i) => ({ place: i < 2 ? 1 : i, alias: `Entrant ${i}` })));
    expect(svg).toContain('Entrant 7');
    expect(svg).not.toContain('Entrant 8');
    expect(svg.match(/font-size="32">1<\/text>/g)).toHaveLength(2);
  });
});

it('exports confirmed placements separately by pool and only resolves public aliases', () => {
  const pools = confirmedPoolGraphics([
    { division: 'upper', poolIndex: 0, playerId: 'a', place: 2 },
    { division: 'upper', poolIndex: 1, playerId: 'b', place: 1 },
    { division: 'upper', poolIndex: 0, playerId: 'missing', place: 1 },
  ], [{ id: 'a', name: 'Alias A' }, { id: 'b', name: 'Alias B' }]);
  expect(pools).toHaveLength(2);
  expect(pools[0]).toEqual({ title: 'Upper · Pool A', results: [{ place: 2, alias: 'Alias A', detail: 'Confirmed pool placement' }] });
  expect(pools[1]!.title).toBe('Upper · Pool B');
});
