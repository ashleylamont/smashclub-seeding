import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertAppChangeset } from '../../scripts/check-changeset.mjs';
import { assertRequiredJobs, requiredJobs } from '../../scripts/check-required-jobs.mjs';
import {
  listWorkspaces,
  planAdvisoryCoverage,
  planPrChecks,
  skippableJobs,
} from '../../scripts/plan-pr-checks.mjs';
import { assertReleaseTag, publicationPolicy } from '../../scripts/publication-policy.mjs';
import { assertPostgresReport } from '../../scripts/postgres-report-policy.mjs';
import { assertPassedUiShard, portableShardPlan } from '../../scripts/run-ui-platform.mjs';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const publish = parse(readFileSync('.github/workflows/publish.yml', 'utf8'));
const versionWorkflow = parse(readFileSync('.github/workflows/version.yml', 'utf8'));
const sha = 'a'.repeat(40);
const input = { event: 'push', ref: 'refs/heads/main', sha, mainSha: sha, onMain: true };

const ui_case_set = 'a'.repeat(64);
const ui_portable_plan = 'b'.repeat(64);
const portableJobs = [
  ['ui-portable', '1'],
  ['ui-portable-2', '2'],
  ['ui-portable-3', '3'],
] as const;
const successfulJobs = {
  ...Object.fromEntries(requiredJobs.map((name) => [name, { result: 'success' }])),
  ...Object.fromEntries(
    portableJobs.map(([id, ordinal]) => [
      id,
      {
        result: 'success',
        outputs: { ui_case_set, ui_portable_plan, ui_portable_shard: `${ordinal}/3` },
      },
    ]),
  ),
  'ui-quality': { result: 'success', outputs: { ui_case_set } },
};

it('keeps the full Publish gate and scopes PR job conditions to their plans', () => {
  expect(ci.jobs['all-checks'].needs.toSorted()).toEqual(requiredJobs.toSorted());
  expect(ci.jobs['all-checks'].if).toBe('always()');
  expect(() => assertRequiredJobs(successfulJobs, { event: 'push' })).not.toThrow();
  const browserCondition =
    "(github.event_name != 'pull_request' || needs.changeset.result != 'success' || needs.changeset.outputs.defer_browser != 'true')";
  const conditions = {
    e2e: `\${{ !cancelled() && ${browserCondition} }}`,
    'e2e-report': `\${{ always() && ${browserCondition} }}`,
    ...Object.fromEntries(
      skippableJobs.map((job) => [
        job,
        `\${{ !cancelled() && (github.event_name != 'pull_request' || !contains(fromJSON(needs.changeset.outputs.skips || '[]'), '${job}')) }}`,
      ]),
    ),
  };
  for (const job of skippableJobs) expect(ci.jobs[job].needs).toBe('changeset');
  for (const job of requiredJobs) {
    expect(ci.jobs[job].if).toBe(conditions[job]);
    for (const result of ['skipped', 'failure', 'cancelled', undefined])
      expect(() => assertRequiredJobs({ ...successfulJobs, [job]: { result } })).toThrow(job);
  }
});

it('accepts only explicit PR skips from a successful plan', () => {
  const options = { event: 'pull_request' };
  const planned = {
    ...successfulJobs,
    changeset: { result: 'success', outputs: { skips: '["postgres"]' } },
    postgres: { result: 'skipped' },
  };
  expect(() => assertRequiredJobs(planned, options)).not.toThrow();
  expect(() => assertRequiredJobs(planned, { ...options, reportOnly: true })).toThrow(/plan/);
  expect(() => assertRequiredJobs(planned, { event: 'push' })).toThrow(/plan/);
  expect(() => assertRequiredJobs({ ...planned, e2e: { result: 'skipped' } }, options)).toThrow(
    'e2e',
  );
  for (const result of ['failure', 'cancelled', undefined]) {
    expect(() => assertRequiredJobs({ ...planned, postgres: { result } }, options)).toThrow(
      'postgres',
    );
    expect(() =>
      assertRequiredJobs({ ...planned, changeset: { ...planned.changeset, result } }, options),
    ).toThrow('changeset');
  }
  for (const skips of [
    undefined,
    'false',
    '["e2e"]',
    '["postgres","postgres"]',
    ...portableJobs.map(([id]) => JSON.stringify([id])),
  ]) {
    expect(() =>
      assertRequiredJobs(
        { ...planned, changeset: { result: 'success', outputs: { skips } } },
        options,
      ),
    ).toThrow(/plan/);
  }
});

it('accepts version browser deferral only as a validated PR pair', () => {
  const options = { event: 'pull_request' };
  const planned = {
    ...successfulJobs,
    changeset: { result: 'success', outputs: { skips: '[]', defer_browser: 'true' } },
    e2e: { result: 'skipped' },
    'e2e-report': { result: 'skipped' },
  };
  expect(() => assertRequiredJobs(planned, options)).not.toThrow();
  for (const event of ['push', 'workflow_dispatch', 'workflow_call']) {
    expect(() => assertRequiredJobs(successfulJobs, { event })).not.toThrow();
    expect(() => assertRequiredJobs(planned, { event })).toThrow(/plan/);
    expect(() =>
      assertRequiredJobs({ ...successfulJobs, e2e: { result: 'skipped' } }, { event }),
    ).toThrow('e2e');
  }
  expect(() => assertRequiredJobs(planned, { ...options, reportOnly: true })).toThrow(/plan/);
  for (const job of ['e2e', 'e2e-report']) {
    for (const result of ['success', 'failure', 'cancelled', undefined]) {
      expect(() => assertRequiredJobs({ ...planned, [job]: { result } }, options)).toThrow(job);
    }
  }
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    expect(() =>
      assertRequiredJobs({ ...planned, changeset: { ...planned.changeset, result } }, options),
    ).toThrow('changeset');
  }
  for (const defer_browser of [undefined, 'false', true, []]) {
    expect(() =>
      assertRequiredJobs(
        {
          ...planned,
          changeset: { ...planned.changeset, outputs: { skips: '[]', defer_browser } },
        },
        options,
      ),
    ).toThrow(/e2e|plan/);
  }
  for (const job of [...portableJobs.map(([id]) => id), 'ui-quality', 'production-image']) {
    expect(() => assertRequiredJobs({ ...planned, [job]: { result: 'skipped' } }, options)).toThrow(
      job,
    );
  }
});

it('runs browser shards after only the PR plan, independently of full typecheck and build', () => {
  expect(ci.jobs.e2e.needs).toBe('changeset');
  expect(ci.jobs['e2e-report'].needs).toEqual(['changeset', 'e2e']);
  expect(ci.jobs.changeset.outputs.defer_browser).toBe('${{ steps.plan.outputs.defer_browser }}');
  expect(ci.jobs.typecheck.steps).toContainEqual(
    expect.objectContaining({ run: 'pnpm typecheck' }),
  );
  expect(ci.jobs.build.steps).toContainEqual(expect.objectContaining({ run: 'pnpm build' }));
});

it('previews Nx tasks after the full typecheck on PRs', () => {
  expect(ci.jobs.typecheck.steps[0].with).toEqual({
    'fetch-depth': "${{ github.event_name == 'pull_request' && 2 || 1 }}",
  });
  expect(ci.jobs.typecheck.steps.slice(-2)).toEqual([
    { run: 'pnpm typecheck' },
    {
      name: 'Preview Nx affected tasks',
      if: "github.event_name == 'pull_request'",
      'continue-on-error': true,
      'timeout-minutes': 1,
      env: { PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}' },
      run: 'node scripts/report-nx-affected.mjs "$PR_HEAD_SHA"',
    },
  ]);
  expect(ci.jobs.test.steps.at(-1)).toEqual({ run: 'pnpm test' });
});

it('scopes PR skips to web or prose and keeps broader candidates advisory', () => {
  const note = '.changeset/example.md';
  const web = 'apps/web/src/pages/Example.tsx';
  expect(planPrChecks([web, note], false).skips).toEqual(skippableJobs);
  expect(planPrChecks([web, note], true)).toMatchObject({ skips: [], candidates: skippableJobs });
  expect(planPrChecks(['docs/development.md', note], false)).toMatchObject({
    skips: skippableJobs,
    candidates: expect.arrayContaining([
      'e2e',
      'e2e-report',
      'ui-portable',
      'ui-portable-2',
      'ui-portable-3',
      'ui-quality',
      'production-image',
    ]),
  });
  expect(planPrChecks(['legacy/main.py', note], false)).toMatchObject({
    skips: [],
    candidates: expect.arrayContaining(['postgres']),
  });
  expect(planPrChecks([], false).skips).toEqual([]);
  for (const path of [
    'apps/server/src/app.ts',
    'packages/db/migrations/0001.sql',
    'packages/shared/src/events.ts',
    'tools/rank-eval/src/index.ts',
    'docs/bracket-renderer-reproduction/run.sh',
    '.github/workflows/ci.yml',
    '.changeset/config.json',
    'pnpm-lock.yaml',
    'unexpected.txt',
  ]) {
    expect(planPrChecks([web, note, path], false).skips, path).toEqual([]);
  }
});

describe('advisory workspace coverage', () => {
  const graph = (pkg: string) => listWorkspaces(`...@smashclub/${pkg}`);

  it.each([
    [
      'tournament-formats',
      'packages/tournament-formats/src/elimination.ts',
      ['server', 'tournament-formats', 'web'],
    ],
    ['engine', 'packages/engine/src/whr.ts', ['engine', 'server', 'web']],
    [
      'shared',
      'packages/shared/src/competition.ts',
      ['engine', 'server', 'shared', 'tournament-formats', 'web'],
    ],
  ])('uses the %s dependency graph while preserving all actual gates', (pkg, path, projects) => {
    const paths = [path, '.changeset/example.md'];
    const coverage = planAdvisoryCoverage(paths, graph(pkg));
    expect(coverage?.projects).toEqual(projects);
    expect(coverage?.typecheck).toContain('@smashclub/server');
    expect(coverage?.typecheck.includes('@smashclub/rank-eval')).toBe(pkg !== 'tournament-formats');
    expect(coverage?.downstream).toEqual(
      expect.arrayContaining([
        'e2e',
        ...portableJobs.map(([id]) => id),
        'ui-quality',
        'postgres',
        'production-image',
      ]),
    );
    expect(planPrChecks(paths, false).skips).toEqual([]);
  });

  it('combines known rename endpoints and falls back for uncertain or global changes', () => {
    const format = 'packages/tournament-formats/src/advancement.ts';
    const rating = 'packages/engine/src/whr.ts';
    const workspaces = graph('shared');
    expect(planAdvisoryCoverage([format, rating], workspaces)?.projects).toEqual(
      expect.arrayContaining(['engine', 'tournament-formats']),
    );
    expect(planAdvisoryCoverage([format], [])).toBeNull();
    for (const path of [
      'packages/db/migrations/0001.sql',
      'packages/engine/src/challonge/extract.ts',
      'packages/tournament-formats/package.json',
      'pnpm-lock.yaml',
      'vitest.config.ts',
      'scripts/plan-pr-checks.mjs',
      'unexpected.txt',
    ]) {
      expect(planAdvisoryCoverage([format, path], workspaces), path).toBeNull();
      expect(planPrChecks([format, path], false).skips, path).toEqual([]);
    }
  });
});

it('keeps three required portable shards and Darwin independent with separate review artifacts', async () => {
  const { default: uiConfig } = await import('../../apps/web/playwright.ui.config');
  const sharedCaseOutput = '${{ steps.browser.outputs.ui_case_set }}';
  expect(uiConfig).toMatchObject({ fullyParallel: true, workers: 2, retries: 0 });
  for (const [id, ordinal] of portableJobs) {
    const job = ci.jobs[id];
    expect(ci.jobs['all-checks'].needs).toContain(id);
    expect(job).toMatchObject({
      name: `UI behavior and accessibility (${ordinal}/3)`,
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 20,
      env: { UI_PORTABLE_SHARD: ordinal },
      outputs: {
        ui_case_set: sharedCaseOutput,
        ui_portable_plan: '${{ steps.browser.outputs.ui_portable_plan }}',
        ui_portable_shard: '${{ steps.browser.outputs.ui_portable_shard }}',
      },
      steps: expect.arrayContaining([
        {
          name: 'Install portable UI browser',
          run: 'time pnpm --filter @smashclub/web exec playwright install --with-deps chromium',
        },
        {
          name: 'Run portable UI shard',
          id: 'browser',
          run: 'time node scripts/run-ui-platform.mjs portable "$UI_PORTABLE_SHARD/3"',
        },
        expect.objectContaining({
          if: 'always()',
          with: expect.objectContaining({
            name: 'ui-portable-review-${{ env.UI_PORTABLE_SHARD }}',
            path: 'apps/web/playwright-report/ui\napps/web/ui-test-results\n',
          }),
        }),
      ]),
    });
    expect(job.needs).toBeUndefined();
    expect(job.steps).toEqual(ci.jobs['ui-portable'].steps);
  }
  expect(ci.jobs['ui-quality']).toMatchObject({
    'runs-on': 'macos-15',
    'timeout-minutes': 15,
    outputs: { ui_case_set: sharedCaseOutput },
    steps: expect.arrayContaining([
      { id: 'browser', run: 'node scripts/run-ui-platform.mjs darwin' },
      expect.objectContaining({
        if: 'always()',
        with: expect.objectContaining({ name: 'ui-review' }),
      }),
    ]),
  });
});

it.each(portableJobs)(
  'rejects an incomplete or unsuccessful %s in PR and Publish verification',
  (id) => {
    const jobs = {
      ...successfulJobs,
      changeset: { result: 'success', outputs: { skips: '[]' } },
    };
    for (const event of ['pull_request', 'push']) {
      expect(() => assertRequiredJobs(jobs, { event })).not.toThrow();
      for (const result of [undefined, 'skipped', 'failure', 'cancelled']) {
        const shard = result === undefined ? undefined : { ...successfulJobs[id], result };
        expect(() => assertRequiredJobs({ ...jobs, [id]: shard }, { event })).toThrow(id);
      }
    }
  },
);

it('requires a common case set for all portable shards and Darwin', () => {
  for (const id of [...portableJobs.map(([job]) => job), 'ui-quality'])
    for (const outputs of [undefined, { ui_case_set: 'c'.repeat(64) }])
      expect(() =>
        assertRequiredJobs({ ...successfulJobs, [id]: { result: 'success', outputs } }),
      ).toThrow(/same UI case set/);
});

it.each(portableJobs)(
  'requires %s to report its own ordinal and the common plan',
  (id, ordinal) => {
    const otherOrdinal = ordinal === '1' ? '2/3' : '1/3';
    for (const change of [
      { ui_portable_plan: undefined },
      { ui_portable_plan: 'c'.repeat(64) },
      { ui_portable_shard: undefined },
      { ui_portable_shard: `${ordinal}/2` },
      { ui_portable_shard: otherOrdinal },
    ])
      expect(() =>
        assertRequiredJobs({
          ...successfulJobs,
          [id]: {
            result: 'success',
            outputs: { ...successfulJobs[id].outputs, ...change },
          },
        }),
      ).toThrow(/all three shards of the same plan/);
  },
);

it('rejects a shared malformed portable plan digest', () => {
  const invalidJobs = Object.fromEntries(
    portableJobs.map(([id]) => [
      id,
      {
        ...successfulJobs[id],
        outputs: { ...successfulJobs[id].outputs, ui_portable_plan: 'invalid' },
      },
    ]),
  );
  expect(() => assertRequiredJobs({ ...successfulJobs, ...invalidJobs })).toThrow(
    /all three shards of the same plan/,
  );
});

it('rejects an out-of-range portable UI ordinal before discovery', () => {
  const result = spawnSync(process.execPath, ['scripts/run-ui-platform.mjs', 'portable', '4/3'], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'Choose darwin or portable, optionally with a portable shard of 1/3, 2/3, 3/3.',
  );
});

it('executes the UI runner through a symlinked worktree path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ui-runner-path-'));
  try {
    const alias = join(directory, 'worktree');
    symlinkSync(process.cwd(), alias, 'dir');
    const result = spawnSync(
      process.execPath,
      [join(alias, 'scripts/run-ui-platform.mjs'), 'invalid-mode'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Choose darwin or portable');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('requires three nonempty shard assignments covering each portable case exactly once', () => {
  const cases = (...ids: string[]) => new Map(ids.map((id) => [id, true]));
  const portable = cases('a', 'b', 'c', 'd');
  const shards = new Map([
    ['1/3', cases('a', 'b')],
    ['2/3', cases('c')],
    ['3/3', cases('d')],
  ]);
  const plan = portableShardPlan(portable, shards);
  expect(plan).toBe(portableShardPlan(portable, new Map(shards).set('1/3', cases('b', 'a'))));
  expect(plan).not.toBe(
    portableShardPlan(portable, new Map(shards).set('2/3', cases('d')).set('3/3', cases('c'))),
  );
  for (const ordinal of shards.keys()) {
    const missing = new Map(shards);
    missing.delete(ordinal);
    expect(() => portableShardPlan(portable, missing)).toThrow(`${ordinal} is missing or empty`);
    expect(() => portableShardPlan(portable, new Map(shards).set(ordinal, cases()))).toThrow(
      `${ordinal} is missing or empty`,
    );
  }
  expect(() => portableShardPlan(portable, new Map(shards).set('3/3', cases('c', 'd')))).toThrow(
    /repeated case/,
  );
  expect(() => portableShardPlan(portable, new Map(shards).set('1/3', cases('a')))).toThrow(
    /cover every portable case/,
  );
  expect(() =>
    portableShardPlan(portable, new Map(shards).set('3/3', cases('d', 'darwin'))),
  ).toThrow(/unexpected/);
});

it('rejects missing, skipped, expected-to-fail and errored executions', () => {
  const spec = { file: 'fixture.spec.ts', title: 'one case' };
  const expected = new Map([['chromium:case', { spec }]]);
  const pass = {
    projectId: 'chromium',
    status: 'expected',
    expectedStatus: 'passed',
    results: [{ status: 'passed' }],
  };
  const report = (test = pass, id = 'case') => ({
    errors: [],
    suites: [{ specs: [{ ...spec, id, tests: [test] }] }],
  });
  expect(() => assertPassedUiShard(expected, report())).not.toThrow();
  expect(() => assertPassedUiShard(expected, { ...report(), suites: [] })).toThrow(
    /assigned cases/,
  );
  expect(() => assertPassedUiShard(expected, report(pass, 'other'))).toThrow(/did not pass/);
  expect(() => assertPassedUiShard(expected, { ...report(), errors: ['unexpected'] })).toThrow(
    /suite errors/,
  );
  expect(() =>
    assertPassedUiShard(expected, {
      ...report(),
      suites: [...report().suites, ...report().suites],
    }),
  ).toThrow(/Duplicate UI case/);
  for (const failed of [
    { ...pass, status: 'skipped', expectedStatus: 'skipped', results: [{ status: 'skipped' }] },
    { ...pass, expectedStatus: 'failed', results: [{ status: 'failed' }] },
    { ...pass, status: 'unexpected', results: [{ status: 'timedOut' }] },
    { ...pass, status: 'flaky', results: [{ status: 'failed' }, ...pass.results] },
  ])
    expect(() => assertPassedUiShard(expected, report(failed))).toThrow(/did not pass/);
});

it('PostgreSQL gate rejects omitted suites and skipped tests even when the runner exits zero', () => {
  const report = `<testsuites tests="10" skipped="0">${[
    'event-attachment',
    'event-concurrency',
    'event-lifecycle',
    'migration-upgrade',
    'native-live',
  ]
    .map((name) => `<testsuite name="${name}-postgres.test.ts" tests="1"></testsuite>`)
    .join('')} </testsuites>`;
  expect(() => assertPostgresReport(report)).not.toThrow(
    /PostgreSQL gate|Missing required|publication|commit|main|Expected/,
  );
  expect(() => assertPostgresReport(report.replace('skipped="0"', 'skipped="2"'))).toThrow(
    /PostgreSQL gate|Missing required|publication|commit|main|Expected/,
  );
  expect(() => assertPostgresReport(report.replace('event-lifecycle', 'missing'))).toThrow(
    /PostgreSQL gate|Missing required|publication|commit|main|Expected/,
  );
  expect(() => assertPostgresReport(report.replace('native-live', 'missing'))).toThrow(
    /Missing required/,
  );
  expect(() => assertPostgresReport(report.replace('tests="1"', 'tests="0"'))).toThrow(
    /PostgreSQL gate|Missing required|publication|commit|main|Expected/,
  );
  expect(
    ci.jobs.postgres.steps.find((step: { run: string }) => step.run === 'pnpm test:postgres').env
      .POSTGRES_TEST_CONTAINER,
  ).toBe('1');
});

describe('publication ref policy', () => {
  it('publishes current main and omits the mutable tag for superseded commits', () => {
    expect(publicationPolicy(input).tags).toEqual(['main']);
    expect(publicationPolicy({ ...input, mainSha: 'b'.repeat(40) }).tags).toEqual([]);
    expect(publicationPolicy({ ...input, event: 'workflow_dispatch' }).sha).toBe(sha);
  });
  it('publishes full version tags on main history without racing major/minor aliases', () => {
    expect(
      publicationPolicy({ ...input, ref: 'refs/tags/v2.3.4', appVersion: '2.3.4' }).tags,
    ).toEqual(['2.3.4']);
  });
  it('publishes a new version on a verified main push, even if another merge is newer', () => {
    const change = { ...input, versionChanged: true, appVersion: '2.3.4' };
    expect(publicationPolicy(change)).toEqual({
      sha,
      tags: ['main', '2.3.4'],
      releaseVersion: '2.3.4',
    });
    expect(publicationPolicy({ ...change, mainSha: 'b'.repeat(40) }).tags).toEqual(['2.3.4']);
    expect(
      publicationPolicy({ ...change, event: 'workflow_dispatch' }).releaseVersion,
    ).toBeUndefined();
    expect(() => publicationPolicy({ ...change, appVersion: '2.3.4-beta.1' })).toThrow(/Expected/);
  });
  it('rejects an existing version tag pointing at a different build', () => {
    expect(() => assertReleaseTag('v2.3.4', sha, sha)).not.toThrow();
    expect(() => assertReleaseTag('v2.3.4', sha, 'b'.repeat(40))).toThrow(/already points to/);
  });
  it.each([
    { event: 'pull_request', ref: 'refs/pull/5/merge' },
    { event: 'pull_request_target', ref: 'refs/heads/main' },
    { event: 'workflow_dispatch', ref: 'refs/heads/topic' },
    { event: 'workflow_dispatch', ref: 'refs/tags/v1.0.0' },
    { ref: 'refs/tags/v2.3.4', appVersion: '2.3.5' },
    { ref: 'refs/tags/vwrong' },
    { ref: 'refs/tags/v01.0.0' },
    { onMain: false },
    { sha: 'short' },
  ])('rejects unsafe or ambiguous input %j', (change) => {
    expect(() => publicationPolicy({ ...input, ...change })).toThrow(
      /PostgreSQL gate|Missing required|publication|commit|main|Expected/,
    );
  });
});

it('publication runs reusable CI with read permissions and publishes its tested image for the same SHA', () => {
  expect(ci.on).toHaveProperty('workflow_call');
  expect(ci.on).toHaveProperty('pull_request');
  expect(publish.on).not.toHaveProperty('pull_request_target');
  expect(publish.on).not.toHaveProperty('workflow_run');
  expect(publish.jobs.verify.uses).toBe('./.github/workflows/ci.yml');
  expect(publish.jobs.verify.permissions).toEqual({ contents: 'read' });
  expect(publish.jobs.publish.needs).toBe('verify');
  expect(publish.jobs.publish.if).toContain("needs.verify.result == 'success'");
  const checkout = publish.jobs.publish.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  expect(checkout.with.ref).toBe('${{ github.sha }}');
  const artifact = publish.jobs.publish.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  expect(artifact.with.name).toBe('verified-production-image');
  expect(
    publish.jobs.publish.steps.some((step: { uses?: string }) =>
      step.uses?.startsWith('docker/build-push-action@'),
    ),
  ).toBe(false);
});

it('queues exact-build verification and registry writes while superseding PR checks', () => {
  expect(ci.concurrency).toEqual({
    group:
      "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}-verification",
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  expect(publish.jobs.classify).toMatchObject({
    if: "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    permissions: { contents: 'read' },
    'continue-on-error': true,
    outputs: { lane: '${{ steps.classify.outputs.lane }}' },
  });
  expect(publish.jobs.classify.steps[0].with).toEqual({
    ref: '${{ github.sha }}',
    'fetch-depth': 2,
    'persist-credentials': false,
  });
  expect(publish.jobs.verify.needs).toBe('classify');
  expect(publish.jobs.verify.if).toBe('${{ !cancelled() }}');
  expect(publish.jobs.verify.concurrency).toEqual({
    group: [
      "${{ (github.event_name == 'workflow_dispatch' || needs.classify.outputs.lane == 'ordinary') && 'publish-verification-main-ordinary'",
      "|| (needs.classify.outputs.lane == 'ordinary-2' && 'publish-verification-main-ordinary-2')",
      "|| 'publish-verification-refs/heads/main' }}",
    ].join(' '),
    queue: 'max',
  });
  expect(publish.jobs.publish.concurrency).toEqual({
    group: 'registry-publication',
    'cancel-in-progress': false,
    queue: 'max',
  });
});

it('uses repository-scoped credentials for version PRs and publishes releases after image publication', () => {
  expect(versionWorkflow.on.push.branches).toEqual(['main']);
  expect(versionWorkflow.on).not.toHaveProperty('pull_request');
  expect(versionWorkflow.permissions).toEqual({ contents: 'read' });
  const steps = versionWorkflow.jobs.version.steps;
  const token = steps.find((step: { id?: string }) => step.id === 'release-token');
  expect(token.with).toMatchObject({
    'permission-contents': 'write',
    'permission-pull-requests': 'write',
    'client-id':
      '${{ vars.NEMESIS_RELEASE_APP_CLIENT_ID || secrets.NEMESIS_RELEASE_APP_CLIENT_ID }}',
  });
  const changesets = steps.find((step: { id?: string }) => step.id === 'changesets');
  expect(changesets.with).toMatchObject({
    'github-token': '${{ steps.release-token.outputs.token }}',
    'version-script': 'pnpm changeset version',
    'push-git-tags': false,
    'create-github-releases': false,
  });
  expect(
    steps.find((step: { name?: string }) => step.name?.startsWith('Queue the version PR')).run,
  ).toContain('--auto --merge');
  expect(publish.jobs.release.needs).toBe('publish');
  expect(publish.jobs.release.if).toContain('needs.publish.outputs.version');
  expect(publish.jobs.release.permissions).toEqual({ contents: 'write' });
});

describe('version preflight', () => {
  const steps = versionWorkflow.jobs.version.steps;
  const preflight = steps.find((step: { id?: string }) => step.id === 'empty-changesets');

  it('checks the exact trigger before setup and rechecks immediately before versioning', () => {
    expect(versionWorkflow.on).toHaveProperty('workflow_dispatch');
    expect(steps[0].with).toEqual({
      ref: '${{ github.sha }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(
      steps.slice(1, 7).map((step: { id?: string; uses?: string }) => step.id ?? step.uses),
    ).toEqual([
      'version-source',
      'empty-changesets',
      './.github/actions/setup-node-pnpm',
      'release-token',
      'version-source-final',
      'changesets',
    ]);
    for (const guard of [steps[1], steps[5]]) {
      expect(guard).toMatchObject({
        env: { GH_TOKEN: '${{ github.token }}' },
        run: 'bash scripts/check-version-source.sh',
      });
    }
    expect(steps[1].if).toBe("env.RELEASE_APP_CONFIGURED == 'true'");
    expect(preflight.if).toBe(
      "steps.version-source.outputs.ready == 'true' && github.event_name == 'push'",
    );
    for (const step of [steps[3], steps[4], steps[5]]) {
      expect(step.if).toBe(
        "steps.version-source.outputs.ready == 'true' && steps.empty-changesets.outputs.skip != 'true'",
      );
    }
    expect(steps[6].if).toBe("steps.version-source-final.outputs.ready == 'true'");
    expect(
      steps.find((step: { name?: string }) => step.name?.startsWith('Queue the version PR')).run,
    ).toContain('--match-head-commit "$head"');
  });

  it('accepts a fresh trigger and stops stale or unverifiable sources', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nemesis-version-source-'));
    const output = join(cwd, 'output');
    const script = fileURLToPath(new URL('../../scripts/check-version-source.sh', import.meta.url));
    const newer = 'b'.repeat(40);
    try {
      writeFileSync(
        join(cwd, 'git'),
        '#!/bin/sh\n[ "$*" = "rev-parse HEAD" ] || exit 1\nprintf "%s\\n" "$CHECKOUT_SHA"\n',
        { mode: 0o700 },
      );
      writeFileSync(
        join(cwd, 'gh'),
        [
          '#!/bin/sh',
          '[ "$*" = "api repos/test/nemesis/git/ref/heads/main --jq .object.sha" ] || exit 1',
          '[ "$GH_TOKEN" = read-token ] || exit 1',
          '[ "$LOOKUP_FAILS" = false ] || exit 1',
          'printf "%s\\n" "$MAIN_SHA"',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      const guard = (main: string, event = 'push', checkout = sha, lookupFails = false) => {
        writeFileSync(output, '');
        const run = spawnSync('/bin/bash', [script], {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${cwd}:${process.env.PATH}`,
            GITHUB_REPOSITORY: 'test/nemesis',
            GITHUB_SHA: sha,
            GITHUB_EVENT_NAME: event,
            GITHUB_OUTPUT: output,
            GH_TOKEN: 'read-token',
            CHECKOUT_SHA: checkout,
            MAIN_SHA: main,
            LOOKUP_FAILS: String(lookupFails),
          },
        });
        return { status: run.status, output: readFileSync(output, 'utf8'), stdout: run.stdout };
      };
      expect(guard(sha)).toMatchObject({ status: 0, output: 'ready=true\n' });
      expect(guard(newer)).toMatchObject({ status: 0, output: 'ready=false\n' });
      expect(guard(sha, 'workflow_dispatch')).toMatchObject({ status: 0, output: 'ready=true\n' });
      const staleDispatch = guard(newer, 'workflow_dispatch');
      expect(staleDispatch).toMatchObject({ status: 0, output: 'ready=false\n' });
      expect(staleDispatch.stdout).toContain('Run Version Nemesis again on main');
      for (const result of [guard(sha, 'push', newer), guard(sha, 'push', sha, true), guard('')]) {
        expect(result).toMatchObject({ status: 1, output: '' });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { entries: [], expected: 'skip=true\n' },
    { entries: ['candidate.md'], expected: '' },
    { entries: ['pre.json'], expected: '' },
    { entries: ['pre/note.md'], expected: '' },
    { entries: ['unexpected'], expected: '' },
    { entries: [], missingDirectory: true, expected: '' },
    { entries: [], failedInspection: true, expected: '' },
  ])('emits a skip only for a known empty directory (%j)', (scenario) => {
    const cwd = mkdtempSync(join(tmpdir(), 'nemesis-version-preflight-'));
    const output = join(cwd, 'output');
    try {
      if (!scenario.missingDirectory) {
        for (const name of ['README.md', 'config.json', 'changelog.mjs', ...scenario.entries]) {
          const file = join(cwd, '.changeset', name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, '');
        }
      }
      writeFileSync(output, '');
      const result = spawnSync('/bin/bash', ['-eo', 'pipefail', '-c', preflight.run], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          ...(scenario.failedInspection && { PATH: '' }),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(scenario.expected);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

it('extracts the current app version notes for publication', () => {
  const { version } = JSON.parse(readFileSync('apps/web/package.json', 'utf8'));
  const notes = execFileSync(process.execPath, ['scripts/release-notes.mjs', version], {
    encoding: 'utf8',
  });
  expect(notes).toMatch(/^### (Major|Minor|Patch) Changes$/m);
  expect(notes).not.toContain('Before versioned releases');
});

describe('Changeset merge gate', () => {
  const appPackage = 'apps/web/package.json';
  const changelog = 'apps/web/CHANGELOG.md';
  const note = '.changeset/example.md';
  const valid = "---\n'@smashclub/web': patch\n---\n\n**Fix** · Keep the QR visible.\n";
  const read = (revision: string, path: string) => {
    if (path === note) return valid;
    if (path === appPackage) {
      return JSON.stringify({ version: revision === 'base' ? '0.1.0' : '0.1.1' });
    }
    return '## 0.1.1\n\n### Patch Changes\n\n- Keep the QR visible.';
  };

  // Git, Node and pnpm process startup can exceed five seconds during parallel runs.
  describe.sequential('tested merge checkout', { timeout: 15_000 }, () => {
    let cwd: string;
    let eventBase: string;
    let testedBase: string;
    let feature: string;
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', ...args],
        { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
      ).trim();
    const write = (path: string, contents: string) => {
      const destination = join(cwd, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    };
    const script = fileURLToPath(new URL('../../scripts/check-changeset.mjs', import.meta.url));
    const planner = fileURLToPath(new URL('../../scripts/plan-pr-checks.mjs', import.meta.url));
    const check = (expectedHead: string) =>
      spawnSync(process.execPath, [script, expectedHead], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_HEAD_REF: 'feature' },
      });
    const plan = (expectedHead: string, reportOnly: boolean) => {
      const output = join(cwd, '.git', 'plan-output');
      const summary = join(cwd, '.git', 'plan-summary');
      writeFileSync(output, '');
      writeFileSync(summary, '');
      const result = spawnSync(process.execPath, [planner, expectedHead], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          CI_REPORT_ONLY: String(reportOnly),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      return { output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8') };
    };

    beforeAll(() => {
      cwd = mkdtempSync(join(tmpdir(), 'nemesis-changeset-gate-'));
      git('init', '--quiet', '--initial-branch=main');
      write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
      write('package.json', JSON.stringify({ name: 'nemesis', private: true }));
      write(appPackage, JSON.stringify({ name: '@smashclub/web', version: '0.1.4' }));
      write('apps/server/config.txt', 'test configuration\n');
      write(changelog, '## 0.1.4\n');
      write('.changeset/previous.md', valid);
      git('add', '--all');
      git('commit', '--quiet', '-m', 'Before release');

      git('switch', '--quiet', '--create', 'feature');
      write(note, valid);
      write('apps/web/src/feature.ts', 'export const feature = true;\n');
      git('add', '--all');
      git('commit', '--quiet', '-m', 'Feature with Changeset');

      git('switch', '--quiet', 'main');
      write(appPackage, JSON.stringify({ name: '@smashclub/web', version: '0.1.5' }));
      write(changelog, '## 0.1.5\n\n## 0.1.4\n');
      rmSync(join(cwd, '.changeset/previous.md'));
      git('commit', '--quiet', '--all', '-m', 'Version Nemesis');
      [eventBase, testedBase, feature] = git('rev-parse', 'feature^', 'main', 'feature').split(
        '\n',
      );
      git('merge', '--quiet', '--no-ff', '--no-edit', 'feature');
    });

    afterAll(() => {
      if (cwd) rmSync(cwd, { recursive: true, force: true });
    });

    it('accepts a feature Changeset after main has advanced through a release', () => {
      expect(git('rev-parse', 'HEAD^1')).toBe(testedBase);
      expect(git('diff', '--name-only', eventBase, 'HEAD')).toContain(appPackage);
      const result = check(feature);
      expect(result.status, result.stderr).toBe(0);
    });

    it('rejects a stale PR head on a tested merge', () => {
      const stale = check(eventBase);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('does not match the expected pull request head');
    });

    it('rejects a checkout that is not a two-parent merge', () => {
      git('switch', '--quiet', 'feature');
      try {
        const nonMerge = check(feature);
        expect(nonMerge.status).toBe(1);
        expect(nonMerge.stderr).toContain('two-parent pull request merge commit');
      } finally {
        git('switch', '--quiet', 'main');
      }
    });

    it('plans conservative skips from the tested merge after main advances', () => {
      const { output, summary } = plan(feature, false);
      expect(output).toBe(`skips=${JSON.stringify(skippableJobs)}\n`);
      expect(summary).toContain('Proposed Vitest projects: `web`');
      expect(summary).toContain('Actual typecheck and unit test jobs: Full workspace scope');
    });

    it('reports skip candidates while keeping all checks enabled', () => {
      const { output, summary } = plan(feature, true);
      expect(output).toBe('skips=[]\n');
      expect(summary).toContain('Additional candidates (still run): `legacy-python`, `postgres`');
    });

    describe('cross-workspace rename', () => {
      let moved: string;

      beforeAll(() => {
        git('switch', '--quiet', '--create', 'rename');
        git('mv', 'apps/server/config.txt', 'apps/web/config.txt');
        git('commit', '--quiet', '-m', 'Move configuration across scopes');
        moved = git('rev-parse', 'HEAD');
        git('switch', '--quiet', '--detach', 'main');
        git('merge', '--quiet', '--no-ff', '--no-edit', 'rename');
      });

      afterAll(() => {
        git('switch', '--quiet', 'main');
      });

      it('keeps full verification', () => {
        const { output, summary } = plan(moved, false);
        expect(output).toBe('skips=[]\n');
        expect(summary).toContain('Proposed workspace scope: Full verification');
      });
    });
  });

  it('passes the expected PR head to both workflow CLI steps', () => {
    const checkStep = ci.jobs.changeset.steps.find(
      (step: { name?: string }) => step.name === 'Check release note',
    );
    expect(checkStep.env).toEqual({ PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}' });
    expect(checkStep.run).toBe('node scripts/check-changeset.mjs "$PR_HEAD_SHA"');
    const planStep = ci.jobs.changeset.steps.find((step: { id?: string }) => step.id === 'plan');
    expect(ci.jobs.changeset.outputs.skips).toBe('${{ steps.plan.outputs.skips }}');
    expect(planStep.env.PR_HEAD_SHA).toBe(checkStep.env.PR_HEAD_SHA);
    expect(planStep.run).toBe('node scripts/plan-pr-checks.mjs "$PR_HEAD_SHA"');
  });

  it('requires a new valid note for regular changes', () => {
    expect(() =>
      assertAppChangeset(
        [
          ['A', note],
          ['M', 'src/app.ts'],
        ],
        read,
      ),
    ).not.toThrow();
    expect(() => assertAppChangeset([['M', note]], read)).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['A', note]], read, { releaseOnly: true })).toThrow(
      /Add a new/,
    );
    expect(() =>
      assertAppChangeset(
        [
          ['A', note],
          ['M', appPackage],
        ],
        read,
      ),
    ).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['A', '.changeset/README.md']], read)).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['A', note]], () => '---\n---\n')).toThrow(/Invalid/);
    expect(() =>
      assertAppChangeset([['A', note]], () => valid.replace('@smashclub/web', '@smashclub/server')),
    ).toThrow(/Invalid/);
  });

  it('accepts a version bump and notes generated by consuming existing Changesets', () => {
    const release = [
      ['D', note],
      ['M', appPackage],
      ['M', changelog],
    ];
    expect(() => assertAppChangeset(release, read)).not.toThrow();
    expect(() => assertAppChangeset(release, read, { releaseOnly: true })).not.toThrow();
    expect(() =>
      assertAppChangeset(release, (revision, path) =>
        path === appPackage && revision === 'HEAD'
          ? JSON.stringify({ version: '0.1.1', scripts: { build: 'other' } })
          : read(revision, path),
      ),
    ).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['D', note]], read)).toThrow(/Add a new/);
    expect(() => assertAppChangeset([...release, ['M', 'src/app.ts']], read)).toThrow(/Add a new/);
    expect(() =>
      assertAppChangeset(release, (revision, path) =>
        path === changelog ? '## 0.1.0' : read(revision, path),
      ),
    ).toThrow(/Add a new/);
  });

  it('requires the exact highest version bump among consumed Changesets', () => {
    const release = (oldVersion: string, newVersion: string, bumps: string[]) => {
      const notes = new Map(
        bumps.map((bump) => [`.changeset/${bump}.md`, valid.replace('patch', bump)]),
      );
      const changes = [
        ...[...notes.keys()].map((path) => ['D', path]),
        ['M', appPackage],
        ['M', changelog],
      ];
      return () =>
        assertAppChangeset(
          changes,
          (revision, path) => {
            if (path === appPackage)
              return JSON.stringify({ version: revision === 'base' ? oldVersion : newVersion });
            if (path === changelog) return `## ${newVersion}\n`;
            return notes.get(path)!;
          },
          { releaseOnly: true },
        );
    };
    expect(release('0.1.7', '0.1.8', ['patch'])).not.toThrow();
    expect(release('0.1.7', '0.1.9', ['patch'])).toThrow(/require Nemesis 0\.1\.8/);
    expect(release('0.1.7', '0.2.0', ['patch', 'minor'])).not.toThrow();
    expect(release('0.1.7', '0.1.8', ['patch', 'minor'])).toThrow(/require Nemesis 0\.2\.0/);
    expect(release('0.1.7', '0.2.7', ['patch', 'minor'])).toThrow(/require Nemesis 0\.2\.0/);
    expect(release('0.1.7', '1.0.0', ['patch', 'minor', 'major'])).not.toThrow();
    expect(release('1.2.3', '2.0.0', ['major', 'patch'])).not.toThrow();
  });
});
