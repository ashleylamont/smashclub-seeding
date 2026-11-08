import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, globSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../apps/web', import.meta.url));
const testDir = join(web, 'ui-tests');
const playwright = createRequire(join(web, 'package.json')).resolve('@playwright/test/cli');
// The JSON reporter omits the @ prefix that Playwright uses in the grep input.
const tag = 'darwin-baseline';
const pattern = `(?:^|\\s)@${tag}(?:$|\\s)`;
const partitions = {
  darwin: ['--grep', pattern],
  portable: ['--grep-invert', pattern],
};

for (const file of globSync('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', { cwd: testDir })) {
  if (
    file !== 'darwinScreenshot.ts' &&
    /\b(?:toHaveScreenshot|toMatchSnapshot)\b/.test(readFileSync(join(testDir, file), 'utf8'))
  ) {
    throw new Error(`${file}: use darwinScreenshot for file-based image assertions.`);
  }
}

function discoveredCases(filters = []) {
  const output = execFileSync(
    process.execPath,
    [playwright, 'test', '-c', 'playwright.ui.config.ts', '--list', '--reporter=json', ...filters],
    { cwd: web, encoding: 'utf8' },
  );
  const { suites, errors } = JSON.parse(output);
  if (errors.length) throw new Error('Playwright could not list UI cases.');
  const cases = new Map();
  function visit(suite) {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        const id = `${test.projectId}:${spec.id}`;
        if (cases.has(id)) throw new Error(`Duplicate UI case: ${spec.file} ${spec.title}`);
        cases.set(id, spec);
      }
    }
    for (const nested of suite.suites ?? []) visit(nested);
  }
  for (const suite of suites) visit(suite);
  return cases;
}

const all = discoveredCases();
const darwin = discoveredCases(partitions.darwin);
const portable = discoveredCases(partitions.portable);
if (!darwin.size || !portable.size || darwin.size + portable.size !== all.size)
  throw new Error('Expected nonempty Darwin and portable selections covering every UI case.');
for (const [id, spec] of all) {
  const baseline = spec.tags.includes(tag);
  if (darwin.has(id) !== baseline || portable.has(id) === baseline)
    throw new Error(`Incorrect UI platform selection: ${spec.file} ${spec.title}`);
}
console.log(`UI coverage: ${darwin.size} Darwin baseline cases, ${portable.size} portable cases.`);

const classification = [...all.keys()].sort().map((id) => [id, darwin.has(id)]);
const caseSet = createHash('sha256').update(JSON.stringify(classification)).digest('hex');
console.log(`UI case set: ${caseSet}`);

const mode = process.argv[2];
if (mode !== undefined) {
  if (!Object.hasOwn(partitions, mode)) throw new Error('Choose darwin or portable.');
  if (mode === 'darwin' && process.platform !== 'darwin')
    throw new Error('Darwin baseline tests require macOS.');
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `ui_case_set=${caseSet}\n`);
  execFileSync('pnpm', ['test:ui', '--update-snapshots=none', ...partitions[mode]], {
    cwd: web,
    stdio: 'inherit',
  });
}
