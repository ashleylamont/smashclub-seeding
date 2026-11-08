import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { git, readPrMerge } from './pr-merge.mjs';

export const skippableJobs = ['legacy-python', 'postgres'];
const appChecks = ['e2e', 'e2e-report', 'ui-quality', 'build', 'bundle-smoke', 'production-image'];
const prose = /^(?:README\.md|AGENTS\.md|docs\/[^\n]+\.md|\.changeset\/[^/\n]+\.md)$/;

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
    reason: 'The change is empty or outside the known isolated scopes.',
    skips: [],
    candidates: [],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { merge, base } = readPrMerge(process.argv[2]);
  const reportOnly = process.env.CI_REPORT_ONLY === 'true';
  // A move across scopes must include its old path, even when Git detects a rename.
  const paths = git('diff', '--no-renames', '--name-only', '-z', base, merge)
    .split('\0')
    .slice(0, -1);
  const { reason, skips, candidates } = planPrChecks(paths, reportOnly);
  // The workspace graph is advisory. Job-level inputs include migrations and test harnesses.
  const workspaces = JSON.parse(
    execFileSync('pnpm', ['--filter', `...[${base}]`, 'list', '--depth', '-1', '--json'], {
      encoding: 'utf8',
    }),
  ).map(({ name }) => name);
  const list = (items) => (items.length ? items.map((item) => `\`${item}\``).join(', ') : 'None');
  appendFileSync(process.env.GITHUB_OUTPUT, `skips=${JSON.stringify(skips)}\n`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Affected PR checks',
      '',
      reason,
      '',
      `- Mode: ${reportOnly ? 'Report only' : 'Conservative PR skips'}`,
      `- Affected pnpm workspaces (including dependents): ${list(workspaces)}`,
      `- Skipped by policy: ${list(skips)}`,
      `- Additional candidates (still run): ${list(candidates.filter((job) => !skips.includes(job)))}`,
      '',
    ].join('\n'),
  );
}
