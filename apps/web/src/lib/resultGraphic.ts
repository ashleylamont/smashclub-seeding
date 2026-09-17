/** Public aliases only: callers must use the public event snapshot. */
export interface GraphicResult { place: number; alias: string; detail?: string }
export function escapeSvg(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}
export function resultsSvg(title: string, results: readonly GraphicResult[]): string {
  const rows = results.slice(0, 8);
  const height = 230 + rows.length * 98;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="1200" height="${height}" fill="#10151f"/><rect width="14" height="${height}" fill="#a9ed5b"/><g font-family="Arial, sans-serif"><text x="64" y="64" fill="#a9ed5b" font-size="22" letter-spacing="5">SMASH CLUB · RESULTS</text><text x="64" y="126" fill="white" font-weight="bold" font-size="38">${escapeSvg(title.slice(0, 52))}</text>${rows.map((row, index) => `<rect x="48" y="${166 + index * 98}" width="1104" height="86" rx="8" fill="${index === 0 ? '#28391e' : '#1c2431'}"/><text x="76" y="${220 + index * 98}" fill="#a9ed5b" font-size="32">${row.place}</text><text x="158" y="${211 + index * 98}" fill="white" font-weight="bold" font-size="29">${escapeSvg(row.alias.slice(0, 48))}</text><text x="158" y="${238 + index * 98}" fill="#bbc5d3" font-size="18">${escapeSvg((row.detail ?? '').slice(0, 82))}</text>`).join('')}</g></svg>`;
}

/** Pool placements are never presented as overall event places. */
export function confirmedPoolGraphics(
  placements: readonly { division: string; poolIndex: number; playerId: string; place: number }[],
  entrants: readonly { id: string; name: string }[],
): Array<{ title: string; results: GraphicResult[] }> {
  const names = new Map(entrants.map(entrant => [entrant.id, entrant.name]));
  const pools = new Map<string, GraphicResult[]>();
  for (const placement of placements) {
    const alias = names.get(placement.playerId);
    if (!alias || !Number.isInteger(placement.place) || placement.place < 1) continue;
    const title = `${placement.division === 'upper' ? 'Upper' : 'Lower'} · Pool ${String.fromCharCode(65 + placement.poolIndex)}`;
    const rows = pools.get(title) ?? [];
    rows.push({ place: placement.place, alias, detail: 'Confirmed pool placement' });
    pools.set(title, rows);
  }
  return [...pools].sort(([a], [b]) => a.localeCompare(b)).map(([title, results]) => ({ title, results: results.sort((a, b) => a.place - b.place) }));
}
