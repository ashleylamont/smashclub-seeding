export const requiredJobs = [
  'typecheck',
  'lint',
  'format',
  'test',
  'e2e',
  'ui-quality',
  'build',
  'bundle-smoke',
  'legacy-python',
  'postgres',
  'production-image',
];
export function assertRequiredJobs(results) {
  for (const name of requiredJobs) {
    if (results[name]?.result !== 'success')
      throw new Error(`${name} did not pass (${results[name]?.result ?? 'missing'})`);
  }
}
if (process.env.RESULTS) assertRequiredJobs(JSON.parse(process.env.RESULTS));
