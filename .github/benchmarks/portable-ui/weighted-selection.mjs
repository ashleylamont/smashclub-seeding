import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const weights = JSON.parse(readFileSync(new URL('./weighted-timings.json', import.meta.url)));

export function weightedUiSelections(portable, ordinals, directory) {
  const byFile = new Map();
  for (const [id, { spec }] of portable) {
    if (!byFile.has(spec.file)) byFile.set(spec.file, []);
    byFile.get(spec.file).push(id);
  }

  const files = [...byFile].map(([path, ids]) => ({
    path,
    ids,
    cost: ids.length * (weights.millisecondsPerCase[path] ?? weights.fallbackMilliseconds),
  }));
  files.sort((left, right) => right.cost - left.cost || left.path.localeCompare(right.path, 'en'));

  const shards = ordinals.map((ordinal) => ({ ordinal, cost: 0, paths: [], ids: new Set() }));
  for (const { path, ids, cost } of files) {
    const shard = shards.reduce((lightest, current) => current.cost < lightest.cost ? current : lightest);
    shard.cost += cost;
    shard.paths.push(path);
    for (const id of ids) shard.ids.add(id);
  }

  return new Map(shards.map(({ ordinal, paths, ids }) => {
    const testList = join(directory, `weighted-${ordinal.split('/')[0]}.txt`);
    writeFileSync(testList, `${paths.sort().join('\n')}\n`);
    return [ordinal, { ids, args: [`--test-list=${testList}`] }];
  }));
}
