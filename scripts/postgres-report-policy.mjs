export function assertPostgresReport(report) {
  const suites = [...report.matchAll(/<testsuite\s([^>]+)>/g)].map((match) => match[1]);
  for (const name of [
    'event-attachment',
    'event-concurrency',
    'event-lifecycle',
    'migration-upgrade',
    'native-live',
  ]) {
    const suite = suites.find((attributes) => attributes.includes(`${name}-postgres.test.ts`));
    if (!suite || !/\btests="[1-9]\d*"/.test(suite))
      throw new Error(`Missing required tests: ${name}`);
  }
  if (/skipped="[1-9]|<skipped\b|failures="[1-9]|errors="[1-9]/.test(report))
    throw new Error('PostgreSQL gate must run passing tests without skips');
}
