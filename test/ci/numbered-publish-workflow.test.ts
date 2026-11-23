import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { publicationPolicy } from '../../scripts/publication-policy.mjs';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const publish = parse(readFileSync('.github/workflows/publish.yml', 'utf8'));

it('runs full isolated verification before publishing a separately selected numbered snapshot', () => {
  const jobs = publish.jobs;
  const source = '${{ needs.numbered-source.outputs.source_sha }}';
  expect(jobs['numbered-source']).toMatchObject({
    needs: 'classify',
    if: "needs.classify.outputs.lane == 'version'",
    permissions: { contents: 'read', 'pull-requests': 'read' },
  });
  expect(jobs['verify-snapshot']).toMatchObject({
    needs: 'numbered-source',
    if: expect.stringContaining('source_sha != github.sha'),
    uses: './.github/workflows/ci.yml',
    permissions: { contents: 'read' },
    with: { snapshot_sha: source },
  });
  expect(jobs['publish-snapshot']).toMatchObject({
    needs: ['verify-snapshot', 'numbered-source'],
    if: "needs.verify-snapshot.result == 'success'",
    concurrency: jobs.publish.concurrency,
    permissions: jobs.publish.permissions,
    steps: jobs.publish.steps,
    env: {
      VERIFIED_SHA: source,
      NUMBERED_RELEASE_SHA: source,
      ARTIFACT_PREFIX: 'numbered-',
    },
  });
  expect(jobs['release-snapshot']).toMatchObject({
    needs: 'publish-snapshot',
    env: {
      VERSION: '${{ needs.publish-snapshot.outputs.version }}',
      VERIFIED_SHA: '${{ needs.publish-snapshot.outputs.source_sha }}',
    },
    steps: jobs.release.steps,
  });
  expect(ci.env).toEqual({
    VERIFIED_SHA: '${{ inputs.snapshot_sha || github.sha }}',
    ARTIFACT_PREFIX: "${{ inputs.snapshot_sha && 'numbered-' || '' }}",
  });
  for (const job of Object.values(ci.jobs) as {
    steps: { uses?: string; with?: { ref?: string } }[];
  }[]) {
    for (const step of job.steps.filter(({ uses }) => uses?.startsWith('actions/checkout@')))
      expect(step.with?.ref).toBe("${{ inputs.snapshot_sha || '' }}");
  }
});

it('isolates every artifact uploaded by concurrent rolling and numbered verification', () => {
  const expression = '${{ env.ARTIFACT_PREFIX }}';
  const steps = (
    Object.values(ci.jobs) as {
      steps: { uses?: string; with?: { name?: string; pattern?: string } }[];
    }[]
  ).flatMap((job) => job.steps);
  const uploads = steps.filter(({ uses }) => uses?.startsWith('actions/upload-artifact@'));
  const downloads = steps.filter(({ uses }) => uses?.startsWith('actions/download-artifact@'));
  expect(uploads.length).toBeGreaterThan(0);
  for (const action of uploads)
    expect(action.with?.name).toMatch(/^\$\{\{ env\.ARTIFACT_PREFIX \}\}/);
  for (const action of downloads) {
    expect(action.with?.name ?? action.with?.pattern).toMatch(/^\$\{\{ env\.ARTIFACT_PREFIX \}\}/);
  }
  const reportPattern = downloads.find(({ with: options }) => options?.pattern)?.with?.pattern;
  expect(reportPattern?.replace(expression, '')).toBe('browser-blob-report-*');
  expect(reportPattern?.replace(expression, 'numbered-')).toBe('numbered-browser-blob-report-*');
});

it('publishes an approved snapshot only as an exact numeric version, never as rolling main', () => {
  const sha = 'a'.repeat(40);
  const input = { sha, event: 'push', ref: 'refs/heads/main', onMain: true, mainSha: sha };
  const snapshot = {
    ...input,
    numberedSnapshot: true,
    versionChanged: true,
    appVersion: '2.3.4',
  };
  expect(publicationPolicy(snapshot)).toEqual({
    sha,
    tags: ['2.3.4'],
    releaseVersion: '2.3.4',
  });
  expect(() => publicationPolicy({ ...snapshot, versionChanged: false })).toThrow(/validated/);
  expect(() => publicationPolicy({ ...snapshot, event: 'workflow_dispatch' })).toThrow(/validated/);
});
