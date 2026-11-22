import { skippableJobs } from './plan-pr-checks.mjs';
import { portableUiShards } from './portable-ui-shards.mjs';

export const requiredJobs = [
  'typecheck',
  'lint',
  'format',
  'changeset',
  'test',
  'e2e',
  'e2e-report',
  ...Object.keys(portableUiShards),
  'ui-quality',
  'build',
  'bundle-smoke',
  'legacy-python',
  'postgres',
  'production-image',
];
export function assertRequiredJobs(results, { event, reportOnly } = {}) {
  const output = results.changeset?.outputs?.skips;
  const browserPlan = results.changeset?.outputs?.defer_browser;
  const deferBrowser = browserPlan === 'true';
  const skips = event === 'pull_request' ? JSON.parse(output ?? 'null') : [];
  if (
    !Array.isArray(skips) ||
    skips.some((name) => !skippableJobs.includes(name)) ||
    new Set(skips).size !== skips.length ||
    (reportOnly && skips.length) ||
    (event !== 'pull_request' && output && output !== '[]') ||
    (browserPlan != null &&
      browserPlan !== '' &&
      (!deferBrowser || event !== 'pull_request' || reportOnly))
  ) {
    throw new Error('Invalid affected check plan');
  }
  for (const name of requiredJobs) {
    const result = results[name]?.result;
    if (deferBrowser && (name === 'e2e' || name === 'e2e-report')) {
      if (result !== 'skipped') throw new Error(`${name} was not deferred with the browser plan`);
      continue;
    }
    if (result !== 'success' && !(result === 'skipped' && skips.includes(name)))
      throw new Error(`${name} did not pass (${result ?? 'missing'})`);
  }
  const shards = Object.entries(portableUiShards).map(([job, ordinal]) => ({
    ordinal,
    outputs: results[job].outputs,
  }));
  const darwinCases = results['ui-quality'].outputs?.ui_case_set;
  if (
    !/^[a-f0-9]{64}$/.test(darwinCases) ||
    shards.some(({ outputs }) => outputs?.ui_case_set !== darwinCases)
  )
    throw new Error('Portable and Darwin jobs did not verify the same UI case set.');

  const plan = shards[0].outputs.ui_portable_plan;
  if (
    !/^[a-f0-9]{64}$/.test(plan) ||
    shards.some(
      ({ ordinal, outputs }) =>
        outputs.ui_portable_shard !== ordinal || outputs.ui_portable_plan !== plan,
    )
  )
    throw new Error('Portable UI jobs did not pass all three shards of the same plan.');
}
if (process.env.RESULTS) {
  assertRequiredJobs(JSON.parse(process.env.RESULTS), {
    event: process.env.GITHUB_EVENT_NAME,
    reportOnly: process.env.CI_REPORT_ONLY === 'true',
  });
}
