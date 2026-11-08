import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../apps/web', import.meta.url));
const testDir = join(web, 'ui-tests');
// The JSON reporter omits the @ prefix that Playwright uses in the grep input.
const tag = 'darwin-baseline';
const pattern = `(?:^|\\s)@${tag}(?:$|\\s)`;
const partitions = {
  darwin: ['--grep', pattern],
  portable: ['--grep-invert', pattern],
};
const ordinals = ['1/2', '2/2'];
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function reportCases({ suites, errors }) {
  if (errors.length) throw new Error('Playwright reported UI suite errors.');
  const cases = new Map();
  function visit(suite) {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        const id = `${test.projectId}:${spec.id}`;
        if (cases.has(id)) throw new Error(`Duplicate UI case: ${spec.file} ${spec.title}`);
        cases.set(id, { spec, test });
      }
    }
    for (const nested of suite.suites ?? []) visit(nested);
  }
  for (const suite of suites) visit(suite);
  return cases;
}

function discoveredCases(filters = []) {
  const playwright = createRequire(join(web, 'package.json')).resolve('@playwright/test/cli');
  const output = execFileSync(
    process.execPath,
    [playwright, 'test', '-c', 'playwright.ui.config.ts', '--list', '--reporter=json', ...filters],
    { cwd: web, encoding: 'utf8' },
  );
  return reportCases(JSON.parse(output));
}

export function portableShardPlan(portable, shards) {
  const assignments = new Map();
  for (const ordinal of ordinals) {
    const cases = shards.get(ordinal);
    if (!cases?.size) throw new Error(`Portable UI shard ${ordinal} is missing or empty.`);
    for (const id of cases.keys()) {
      if (!portable.has(id) || assignments.has(id))
        throw new Error(
          `Portable UI shard ${ordinal} contains an unexpected or repeated case: ${id}`,
        );
      assignments.set(id, ordinal);
    }
  }
  if (assignments.size !== portable.size)
    throw new Error('Portable UI shards do not cover every portable case.');
  return digest([...portable.keys()].sort().map((id) => [id, assignments.get(id)]));
}

export function assertPassedUiShard(expected, report) {
  const actual = reportCases(report);
  if (actual.size !== expected.size)
    throw new Error('Portable UI shard report does not contain exactly the assigned cases.');
  for (const [id, { spec }] of expected) {
    const test = actual.get(id)?.test;
    if (
      test?.status !== 'expected' ||
      test.expectedStatus !== 'passed' ||
      test.results.length !== 1 ||
      test.results[0]?.status !== 'passed'
    )
      throw new Error(`Portable UI case did not pass: ${spec.file} ${spec.title}`);
  }
}

function runShard(ordinal, expected) {
  const directory = mkdtempSync(join(tmpdir(), 'portable-ui-report-'));
  const report = join(directory, 'execution.json');
  try {
    execFileSync(
      'pnpm',
      ['test:ui', '--update-snapshots=none', ...partitions.portable, `--shard=${ordinal}`],
      { cwd: web, stdio: 'inherit', env: { ...process.env, UI_EXECUTION_REPORT: report } },
    );
    assertPassedUiShard(expected, JSON.parse(readFileSync(report, 'utf8')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main([mode, ordinal, ...extra]) {
  if (
    extra.length ||
    (mode !== undefined && !Object.hasOwn(partitions, mode)) ||
    (ordinal !== undefined && (mode !== 'portable' || !ordinals.includes(ordinal)))
  )
    throw new Error('Choose darwin or portable, optionally with a portable shard of 1/2 or 2/2.');
  if (mode === 'darwin' && process.platform !== 'darwin')
    throw new Error('Darwin baseline tests require macOS.');

  for (const file of globSync('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', { cwd: testDir })) {
    if (
      file !== 'darwinScreenshot.ts' &&
      /\b(?:toHaveScreenshot|toMatchSnapshot)\b/.test(readFileSync(join(testDir, file), 'utf8'))
    ) {
      throw new Error(`${file}: use darwinScreenshot for file-based image assertions.`);
    }
  }

  const all = discoveredCases();
  const darwin = discoveredCases(partitions.darwin);
  const portable = discoveredCases(partitions.portable);
  if (!darwin.size || !portable.size || darwin.size + portable.size !== all.size)
    throw new Error('Expected nonempty Darwin and portable selections covering every UI case.');
  for (const [id, { spec }] of all) {
    const baseline = spec.tags.includes(tag);
    if (darwin.has(id) !== baseline || portable.has(id) === baseline)
      throw new Error(`Incorrect UI platform selection: ${spec.file} ${spec.title}`);
  }
  console.log(
    `UI coverage: ${darwin.size} Darwin baseline cases, ${portable.size} portable cases.`,
  );

  const caseSet = digest([...all.keys()].sort().map((id) => [id, darwin.has(id)]));
  console.log(`UI case set: ${caseSet}`);
  if (mode === undefined) return;

  const outputs = [`ui_case_set=${caseSet}`];
  if (ordinal) {
    const shards = new Map(
      ordinals.map((id) => [id, discoveredCases([...partitions.portable, `--shard=${id}`])]),
    );
    const plan = portableShardPlan(portable, shards);
    const assigned = shards.get(ordinal);
    console.log(`Portable UI shard ${ordinal}: ${assigned.size} cases, plan ${plan}`);
    runShard(ordinal, assigned);
    outputs.push(`ui_portable_plan=${plan}`, `ui_portable_shard=${ordinal}`);
  } else {
    execFileSync('pnpm', ['test:ui', '--update-snapshots=none', ...partitions[mode]], {
      cwd: web,
      stdio: 'inherit',
    });
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
}

if (import.meta.main) main(process.argv.slice(2));
