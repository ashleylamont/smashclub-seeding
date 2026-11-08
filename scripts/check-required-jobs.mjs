import { skippableJobs } from './plan-pr-checks.mjs';

export const requiredJobs = [
  'typecheck',
  'lint',
  'format',
  'changeset',
  'test',
  'e2e',
  'e2e-report',
  'ui-portable',
  'ui-portable-2',
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
  const first = results['ui-portable'].outputs;
  const second = results['ui-portable-2'].outputs;
  const darwinCases = results['ui-quality'].outputs?.ui_case_set;
  if (
    !/^[a-f0-9]{64}$/.test(darwinCases) ||
    first?.ui_case_set !== darwinCases ||
    second?.ui_case_set !== darwinCases
  )
    throw new Error('Portable and Darwin jobs did not verify the same UI case set.');
  if (
    first.ui_portable_shard !== '1/2' ||
    second.ui_portable_shard !== '2/2' ||
    !/^[a-f0-9]{64}$/.test(first.ui_portable_plan) ||
    first.ui_portable_plan !== second.ui_portable_plan
  )
    throw new Error('Portable UI jobs did not pass both shards of the same plan.');
}
if (process.env.RESULTS) {
  assertRequiredJobs(JSON.parse(process.env.RESULTS), {
    event: process.env.GITHUB_EVENT_NAME,
    reportOnly: process.env.CI_REPORT_ONLY === 'true',
  });
}
