import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { publishReleaseRecord } from '../../scripts/publish-release-record.mjs';

const repository = 'smashclub/test-repo';
const notes = '/tmp/release-notes.md';

function registry() {
  const records: { tag_name: string; draft: boolean; prerelease: boolean }[] = [];
  const creates: string[][] = [];
  const lookups: string[][] = [];
  let latest: string | undefined;

  const run = (...args: string[]) => {
    if (args[0] === 'api') {
      lookups.push(args);
      return records.map((record) => JSON.stringify(record)).join('\n');
    }
    const [, action, tag, ...options] = args;
    expect(action).toBe('create');
    expect(options).toContain('--verify-tag');
    expect(options).toContain(notes);
    expect(options).toContain(repository);
    expect(options).toContain(`Nemesis ${tag.slice(1)}`);
    creates.push(args);
    records.push({ tag_name: tag, draft: false, prerelease: false });
    if (options.includes('--latest=true')) latest = tag;
    return '';
  };
  return {
    records,
    creates,
    lookups,
    latest: () => latest,
    publish: (tag: string) => publishReleaseRecord(repository, tag, notes, run),
  };
}

it('keeps the highest published release Latest when an older version finishes later', () => {
  const releases = registry();
  releases.publish('v0.22.10');
  releases.publish('v0.22.9');
  releases.publish('v0.22.10');

  expect(releases.records.map((record) => record.tag_name)).toEqual(['v0.22.10', 'v0.22.9']);
  expect(releases.creates).toHaveLength(2);
  expect(releases.lookups).toEqual(
    Array.from({ length: 3 }, () => [
      'api',
      '--paginate',
      '--jq',
      '.[] | {tag_name, draft, prerelease} | @json',
      `repos/${repository}/releases?per_page=100`,
    ]),
  );
  expect(releases.creates[0]).toContain('--latest=true');
  expect(releases.creates[1]).toContain('--latest=false');
  expect(releases.latest()).toBe('v0.22.10');

  releases.publish('v0.23.0');
  expect(releases.creates[2]).toContain('--latest=true');
  expect(releases.latest()).toBe('v0.23.0');
});

it('ignores drafts and prereleases when deciding whether to promote a published stable version', () => {
  const releases = registry();
  releases.records.push(
    { tag_name: 'v2.0.0', draft: true, prerelease: false },
    { tag_name: 'v1.2.0-rc.1', draft: false, prerelease: true },
  );
  releases.publish('v1.1.0');
  expect(releases.latest()).toBe('v1.1.0');
});

it('does not create a release if GitHub release lookup fails or returns malformed metadata', () => {
  for (const failure of ['transport failure', 'HTTP 403', 'HTTP 404']) {
    const calls: string[] = [];
    const run = (command: string) => {
      calls.push(command);
      throw new Error(failure);
    };
    expect(() => publishReleaseRecord(repository, 'v0.22.10', notes, run)).toThrow(failure);
    expect(calls).toEqual(['api']);
  }

  const calls: string[] = [];
  expect(() =>
    publishReleaseRecord(repository, 'v0.22.10', notes, (command: string) => {
      calls.push(command);
      return '{"tag_name":"v0.22.10","draft":false}';
    }),
  ).toThrow(/release metadata/i);
  expect(calls).toEqual(['api']);
});

it('serializes both GitHub release records and loads release tooling from the main trigger', () => {
  const jobs = parse(readFileSync('.github/workflows/publish.yml', 'utf8')).jobs;
  const queue = {
    group: 'release-record-publication',
    'cancel-in-progress': false,
    queue: 'max',
  };
  expect(jobs.release.concurrency).toEqual(queue);
  expect(jobs['release-snapshot'].concurrency).toEqual(queue);
  const [checkout, releaseStep] = jobs.release.steps;
  expect(checkout.with.ref).toBe('${{ github.sha }}');
  expect(releaseStep.run).toContain('git worktree add --detach "$source_dir" "$VERIFIED_SHA"');
  expect(releaseStep.run).toContain('node "$source_dir/scripts/release-notes.mjs"');
  expect(releaseStep.run).toContain('node scripts/publish-release-record.mjs');
  expect(jobs['release-snapshot'].steps).toEqual(jobs.release.steps);
});
