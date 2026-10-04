import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { assertRequiredJobs, requiredJobs } from '../../scripts/check-required-jobs.mjs';
import { publicationPolicy } from '../../scripts/publication-policy.mjs';
import { assertPostgresReport } from '../../scripts/postgres-report-policy.mjs';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const publish = parse(readFileSync('.github/workflows/publish.yml', 'utf8'));
const sha = 'a'.repeat(40);
const input = { event: 'push', ref: 'refs/heads/main', sha, mainSha: sha, onMain: true };

it('all required jobs run and every skipped, missing, cancelled or failed dependency blocks the gate', () => {
  expect(ci.jobs['all-checks'].needs.toSorted()).toEqual(requiredJobs.toSorted());
  expect(ci.jobs['all-checks'].if).toBe('always()');
  const results = Object.fromEntries(requiredJobs.map((name) => [name, { result: 'success' }]));
  expect(() => assertRequiredJobs(results)).not.toThrow(
    /PostgreSQL gate|Missing required|publication|commit|main|Expected/,
  );
  for (const job of requiredJobs) {
    expect(ci.jobs[job].if).toBeUndefined();
    for (const result of ['skipped', 'failure', 'cancelled', undefined])
      expect(() => assertRequiredJobs({ ...results, [job]: { result } })).toThrow(job);
  }
});

it('PostgreSQL gate rejects omitted suites and skipped tests even when the runner exits zero', () => {
  const report = `<testsuites tests="10" skipped="0">${[
    'event-attachment',
    'event-concurrency',
    'event-lifecycle',
    'migration-upgrade',
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
    expect(publicationPolicy({ ...input, ref: 'refs/tags/v2.3.4' }).tags).toEqual(['2.3.4']);
  });
  it.each([
    { event: 'pull_request', ref: 'refs/pull/5/merge' },
    { event: 'pull_request_target', ref: 'refs/heads/main' },
    { event: 'workflow_dispatch', ref: 'refs/heads/topic' },
    { event: 'workflow_dispatch', ref: 'refs/tags/v1.0.0' },
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
  const checkout = publish.jobs.publish.steps.find(
    (step: { uses: string }) => step.uses === 'actions/checkout@v4',
  );
  expect(checkout.with.ref).toBe('${{ github.sha }}');
  const artifact = publish.jobs.publish.steps.find(
    (step: { uses: string }) => step.uses === 'actions/download-artifact@v4',
  );
  expect(artifact.with.name).toBe('verified-production-image');
  expect(
    publish.jobs.publish.steps.some(
      (step: { uses: string }) => step.uses === 'docker/build-push-action@v7',
    ),
  ).toBe(false);
  expect(publish.jobs.publish.concurrency).toEqual({
    group: 'registry-publication',
    'cancel-in-progress': false,
  });
});
