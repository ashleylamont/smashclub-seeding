import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrChanges, readPrMerge } from './pr-merge.mjs';

export const skippableJobs = ['legacy-python', 'postgres'];
const appChecks = [
  'e2e',
  'e2e-report',
  'ui-portable',
  'ui-portable-2',
  'ui-quality',
  'build',
  'bundle-smoke',
  'production-image',
];
const prose = /^(?:README\.md|AGENTS\.md|docs\/[^\n]+\.md|\.changeset\/[^/\n]+\.md)$/;
const unitProjects = new Map([
  ['@smashclub/engine', 'engine'],
  ['@smashclub/server', 'server'],
  ['@smashclub/shared', 'shared'],
  ['@smashclub/tournament-formats', 'tournament-formats'],
  ['@smashclub/web', 'web'],
]);
const coverageOwners = [
  [/^packages\/tournament-formats\/(?:src|test)\//, '@smashclub/tournament-formats'],
  [
    /^packages\/engine\/src\/(?:whr|whrRun|doubles|breakthrough|models|evaluate)\.ts$/,
    '@smashclub/engine',
  ],
  [
    /^packages\/engine\/test\/(?:whr[^/]*|doubles|breakthrough|evaluate)\.test\.ts$/,
    '@smashclub/engine',
  ],
  [/^packages\/engine\/test\/fixtures\/whr-before-removal\.json$/, '@smashclub/engine'],
  [/^packages\/shared\/(?:src|test)\//, '@smashclub/shared'],
  [/^apps\/web\/(?:src|test|e2e|e2e-shards|ui-tests)\//, '@smashclub/web'],
];

// Advisory only. The pnpm graph covers workspace consumers, while the app jobs
// also read migrations, bundled output and browser fixtures across workspaces.
export function planAdvisoryCoverage(paths, workspaces) {
  const owners = paths
    .filter((path) => !prose.test(path))
    .map((path) => coverageOwners.find(([pattern]) => pattern.test(path))?.[1]);
  const names = new Set(workspaces.map(({ name }) => name));
  if (!owners.length || owners.some((owner) => !names.has(owner))) return null;

  return {
    typecheck: workspaces
      .filter(({ typecheck }) => typecheck)
      .map(({ name }) => name)
      .sort(),
    projects: [...names]
      .map((name) => unitProjects.get(name))
      .filter(Boolean)
      .sort(),
    downstream: owners.every((owner) => owner === '@smashclub/web')
      ? appChecks
      : ['postgres', ...appChecks],
  };
}

export function planPrChecks(paths, reportOnly) {
  const code = paths.filter((path) => !prose.test(path));
  if (paths.length && !code.length) {
    return {
      reason: 'Only prose or release notes changed.',
      skips: reportOnly ? [] : skippableJobs,
      candidates: [...skippableJobs, ...appChecks],
    };
  }
  if (code.length && code.every((path) => path.startsWith('apps/web/'))) {
    return {
      reason:
        'Only web files and optional prose changed. Browser checks still exercise the full app.',
      skips: reportOnly ? [] : skippableJobs,
      candidates: skippableJobs,
    };
  }
  if (code.length && code.every((path) => path.startsWith('legacy/'))) {
    return {
      reason: 'Only legacy Python files and optional prose changed.',
      skips: [],
      candidates: ['postgres', ...appChecks],
    };
  }
  return {
    reason: 'The existing skip policy calls for all required checks.',
    skips: [],
    candidates: [],
  };
}

export function listWorkspaces(filter) {
  return JSON.parse(
    execFileSync('pnpm', ['--filter', filter, 'list', '--depth', '-1', '--json'], {
      encoding: 'utf8',
    }),
  ).map(({ name, path }) => ({
    name,
    typecheck: Boolean(
      JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).scripts?.typecheck,
    ),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { shouldDeferVersionBrowser } = await import('./version-pr-browser-plan.mjs');
  const tested = readPrMerge(process.argv[2]);
  const reportOnly = process.env.CI_REPORT_ONLY === 'true';
  const changes = readPrChanges(tested);
  const paths = changes.map(([, path]) => path);
  const { reason, skips, candidates } = planPrChecks(paths, reportOnly);
  const deferBrowser = shouldDeferVersionBrowser(tested, changes);
  const workspaces = listWorkspaces(`...[${tested.base}]`);
  const advisory = planAdvisoryCoverage(paths, workspaces);
  const list = (items) => (items.length ? items.map((item) => `\`${item}\``).join(', ') : 'None');
  appendFileSync(process.env.GITHUB_OUTPUT, `skips=${JSON.stringify(skips)}\n`);
  if (deferBrowser) appendFileSync(process.env.GITHUB_OUTPUT, 'defer_browser=true\n');
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Affected PR checks',
      '',
      reason,
      '',
      `- Mode: ${reportOnly ? 'Report only' : 'Conservative PR skips'}`,
      `- Affected pnpm workspaces (including dependents): ${list(workspaces.map(({ name }) => name).sort())}`,
      ...(advisory
        ? [
            `- Proposed typecheck workspaces: ${list(advisory.typecheck)}`,
            `- Proposed Vitest projects: ${list(advisory.projects)}`,
            `- Proposed downstream checks: ${list(advisory.downstream)}`,
          ]
        : ['- Proposed workspace scope: Full verification']),
      '- Actual typecheck and unit test jobs: Full workspace scope',
      `- Skipped by policy: ${list(skips)}`,
      ...(deferBrowser
        ? ['- Browser event flows and report run on the final main SHA for this version PR.']
        : []),
      `- Additional candidates (still run): ${list(candidates.filter((job) => !skips.includes(job)))}`,
      '',
    ].join('\n'),
  );
}
