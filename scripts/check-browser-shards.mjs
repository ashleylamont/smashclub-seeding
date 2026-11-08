import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const web = new URL('../apps/web/', import.meta.url);
const requireWeb = createRequire(new URL('package.json', web));
const playwright = requireWeb.resolve('@playwright/test/cli');
const { suites } = JSON.parse(
  execFileSync(process.execPath, [playwright, 'test', '--list', '--reporter=json'], {
    cwd: fileURLToPath(web),
    encoding: 'utf8',
  }),
);
const discovered = new Set(suites.map(({ file }) => file));
const assignments = new Map();

for (const shard of [1, 2, 3, 4]) {
  const files = readFileSync(new URL(`e2e-shards/${shard}.txt`, web), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);
  if (!files.length) throw new Error(`Browser shard ${shard} has no spec files.`);
  for (const file of files) {
    const shards = assignments.get(file) ?? [];
    shards.push(shard);
    assignments.set(file, shards);
  }
}

const problems = [];
for (const file of discovered)
  if (!assignments.has(file)) problems.push(`Missing assignment for ${file}`);
for (const [file, shards] of assignments) {
  if (!discovered.has(file))
    problems.push(`Undiscovered spec ${file} in shard ${shards.join(', ')}`);
  if (shards.length > 1) problems.push(`${file} is listed more than once (${shards.join(', ')})`);
}
if (problems.length) throw new Error(`Check apps/web/e2e-shards:\n${problems.join('\n')}`);

console.log(`All ${discovered.size} browser spec files are assigned to exactly one shard.`);
