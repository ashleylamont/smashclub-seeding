import { skippableJobs } from './plan-pr-checks.mjs';

export const requiredJobs = [
  'typecheck',
  'lint',
  'format',
  'changeset',
  'test',
  'e2e',
  'e2e-report',
  'ui-quality',
  'build',
  'bundle-smoke',
  'legacy-python',
  'postgres',
  'production-image',
];
export function assertRequiredJobs(results, { event, reportOnly } = {}) {
  const output = results.changeset?.outputs?.skips;
  const skips = event === 'pull_request' ? JSON.parse(output ?? 'null') : [];
  if (
    !Array.isArray(skips) ||
    skips.some((name) => !skippableJobs.includes(name)) ||
    new Set(skips).size !== skips.length ||
    (reportOnly && skips.length) ||
    (event !== 'pull_request' && output && output !== '[]')
  ) {
    throw new Error('Invalid affected check plan');
  }
  for (const name of requiredJobs) {
    const result = results[name]?.result;
    if (result !== 'success' && !(result === 'skipped' && skips.includes(name)))
      throw new Error(`${name} did not pass (${result ?? 'missing'})`);
  }
}
if (process.env.RESULTS) {
  assertRequiredJobs(JSON.parse(process.env.RESULTS), {
    event: process.env.GITHUB_EVENT_NAME,
    reportOnly: process.env.CI_REPORT_ONLY === 'true',
  });
}
