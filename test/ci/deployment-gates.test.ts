import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { assertAppChangeset } from '../../scripts/check-changeset.mjs';
import { assertRequiredJobs, requiredJobs } from '../../scripts/check-required-jobs.mjs';
import { assertReleaseTag, publicationPolicy } from '../../scripts/publication-policy.mjs';
import { assertPostgresReport } from '../../scripts/postgres-report-policy.mjs';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const publish = parse(readFileSync('.github/workflows/publish.yml', 'utf8'));
const versionWorkflow = parse(readFileSync('.github/workflows/version.yml', 'utf8'));
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
    expect(ci.jobs[job].if).toBe(job === 'e2e-report' ? 'always()' : undefined);
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
    'native-live',
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
  expect(() => assertPostgresReport(report.replace('native-live', 'missing'))).toThrow(
    /Missing required/,
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
    expect(
      publicationPolicy({ ...input, ref: 'refs/tags/v2.3.4', appVersion: '2.3.4' }).tags,
    ).toEqual(['2.3.4']);
  });
  it('publishes a new version on a verified main push, even if another merge is newer', () => {
    const change = { ...input, versionChanged: true, appVersion: '2.3.4' };
    expect(publicationPolicy(change)).toEqual({
      sha,
      tags: ['main', '2.3.4'],
      releaseVersion: '2.3.4',
    });
    expect(publicationPolicy({ ...change, mainSha: 'b'.repeat(40) }).tags).toEqual(['2.3.4']);
    expect(
      publicationPolicy({ ...change, event: 'workflow_dispatch' }).releaseVersion,
    ).toBeUndefined();
    expect(() => publicationPolicy({ ...change, appVersion: '2.3.4-beta.1' })).toThrow(/Expected/);
  });
  it('rejects an existing version tag pointing at a different build', () => {
    expect(() => assertReleaseTag('v2.3.4', sha, sha)).not.toThrow();
    expect(() => assertReleaseTag('v2.3.4', sha, 'b'.repeat(40))).toThrow(/already points to/);
  });
  it.each([
    { event: 'pull_request', ref: 'refs/pull/5/merge' },
    { event: 'pull_request_target', ref: 'refs/heads/main' },
    { event: 'workflow_dispatch', ref: 'refs/heads/topic' },
    { event: 'workflow_dispatch', ref: 'refs/tags/v1.0.0' },
    { ref: 'refs/tags/v2.3.4', appVersion: '2.3.5' },
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

it('uses repository-scoped credentials for version PRs and publishes releases after image publication', () => {
  expect(versionWorkflow.on.push.branches).toEqual(['main']);
  expect(versionWorkflow.on).not.toHaveProperty('pull_request');
  expect(versionWorkflow.permissions).toEqual({ contents: 'read' });
  const steps = versionWorkflow.jobs.version.steps;
  const token = steps.find((step: { id?: string }) => step.id === 'release-token');
  expect(token.with).toMatchObject({
    'permission-contents': 'write',
    'permission-pull-requests': 'write',
    'client-id':
      '${{ vars.NEMESIS_RELEASE_APP_CLIENT_ID || secrets.NEMESIS_RELEASE_APP_CLIENT_ID }}',
  });
  const changesets = steps.find((step: { id?: string }) => step.id === 'changesets');
  expect(changesets.with).toMatchObject({
    'github-token': '${{ steps.release-token.outputs.token }}',
    'version-script': 'pnpm changeset version',
    'push-git-tags': false,
    'create-github-releases': false,
  });
  expect(
    steps.find((step: { name?: string }) => step.name?.startsWith('Queue the version PR')).run,
  ).toContain('--auto --merge');
  expect(publish.jobs.release.needs).toBe('publish');
  expect(publish.jobs.release.if).toContain('needs.publish.outputs.version');
  expect(publish.jobs.release.permissions).toEqual({ contents: 'write' });
});

it('extracts the current app version notes for publication', () => {
  const { version } = JSON.parse(readFileSync('apps/web/package.json', 'utf8'));
  const notes = execFileSync(process.execPath, ['scripts/release-notes.mjs', version], {
    encoding: 'utf8',
  });
  expect(notes).toMatch(/^### (Major|Minor|Patch) Changes$/m);
  expect(notes).not.toContain('Before versioned releases');
});

describe('Changeset merge gate', () => {
  const appPackage = 'apps/web/package.json';
  const changelog = 'apps/web/CHANGELOG.md';
  const note = '.changeset/example.md';
  const valid = "---\n'@smashclub/web': patch\n---\n\n**Fix** · Keep the QR visible.\n";
  const read = (revision: string, path: string) => {
    if (path === note) return valid;
    if (path === appPackage) {
      return JSON.stringify({ version: revision === 'base' ? '0.1.0' : '0.1.1' });
    }
    return '## 0.1.1\n\n### Patch Changes\n\n- Keep the QR visible.';
  };

  it('validates the tested merge when main has advanced through a release', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nemesis-changeset-gate-'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', ...args],
        { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } },
      ).trim();
    const write = (path: string, contents: string) => {
      const destination = join(cwd, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    };
    const commit = (message: string) => {
      git('add', '--all');
      git('commit', '--quiet', '-m', message);
      return git('rev-parse', 'HEAD');
    };
    const script = fileURLToPath(new URL('../../scripts/check-changeset.mjs', import.meta.url));
    const check = (expectedHead: string) =>
      spawnSync(process.execPath, [script, expectedHead], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_HEAD_REF: 'feature' },
      });

    try {
      git('init', '--quiet', '--initial-branch=main');
      write(appPackage, JSON.stringify({ version: '0.1.4' }));
      write(changelog, '## 0.1.4\n');
      write('.changeset/previous.md', valid);
      const eventBase = commit('Before release');
      git('switch', '--quiet', '--create', 'feature');
      write(note, valid);
      const feature = commit('Feature with Changeset');
      const nonMerge = check(feature);

      git('switch', '--quiet', 'main');
      write(appPackage, JSON.stringify({ version: '0.1.5' }));
      write(changelog, '## 0.1.5\n\n## 0.1.4\n');
      git('rm', '--quiet', '.changeset/previous.md');
      const testedBase = commit('Version Nemesis');
      git('merge', '--quiet', '--no-ff', '--no-edit', 'feature');

      expect(git('rev-parse', 'HEAD^1')).toBe(testedBase);
      expect(git('diff', '--name-only', eventBase, 'HEAD')).toContain(appPackage);
      const result = check(feature);
      expect(result.status, result.stderr).toBe(0);
      expect(nonMerge.stderr).toContain('two-parent pull request merge commit');
      expect(check(eventBase).stderr).toContain('does not match the expected pull request head');
      const checkStep = ci.jobs.changeset.steps.find(
        (step: { name?: string }) => step.name === 'Check release note',
      );
      expect(checkStep.env).toEqual({ PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}' });
      expect(checkStep.run).toBe('node scripts/check-changeset.mjs "$PR_HEAD_SHA"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('requires a new valid note for regular changes', () => {
    expect(() =>
      assertAppChangeset(
        [
          ['A', note],
          ['M', 'src/app.ts'],
        ],
        read,
      ),
    ).not.toThrow();
    expect(() => assertAppChangeset([['M', note]], read)).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['A', note]], read, { releaseOnly: true })).toThrow(
      /Add a new/,
    );
    expect(() =>
      assertAppChangeset(
        [
          ['A', note],
          ['M', appPackage],
        ],
        read,
      ),
    ).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['A', '.changeset/README.md']], read)).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['A', note]], () => '---\n---\n')).toThrow(/Invalid/);
    expect(() =>
      assertAppChangeset([['A', note]], () => valid.replace('@smashclub/web', '@smashclub/server')),
    ).toThrow(/Invalid/);
  });

  it('accepts a version bump and notes generated by consuming existing Changesets', () => {
    const release = [
      ['D', note],
      ['M', appPackage],
      ['M', changelog],
    ];
    expect(() => assertAppChangeset(release, read)).not.toThrow();
    expect(() => assertAppChangeset(release, read, { releaseOnly: true })).not.toThrow();
    expect(() =>
      assertAppChangeset(release, (revision, path) =>
        path === appPackage && revision === 'HEAD'
          ? JSON.stringify({ version: '0.1.1', scripts: { build: 'other' } })
          : read(revision, path),
      ),
    ).toThrow(/Add a new/);
    expect(() => assertAppChangeset([['D', note]], read)).toThrow(/Add a new/);
    expect(() => assertAppChangeset([...release, ['M', 'src/app.ts']], read)).toThrow(/Add a new/);
    expect(() =>
      assertAppChangeset(release, (revision, path) =>
        path === changelog ? '## 0.1.0' : read(revision, path),
      ),
    ).toThrow(/Add a new/);
  });

  it('requires the exact highest version bump among consumed Changesets', () => {
    const release = (oldVersion: string, newVersion: string, bumps: string[]) => {
      const notes = new Map(
        bumps.map((bump) => [`.changeset/${bump}.md`, valid.replace('patch', bump)]),
      );
      const changes = [
        ...[...notes.keys()].map((path) => ['D', path]),
        ['M', appPackage],
        ['M', changelog],
      ];
      return () =>
        assertAppChangeset(
          changes,
          (revision, path) => {
            if (path === appPackage)
              return JSON.stringify({ version: revision === 'base' ? oldVersion : newVersion });
            if (path === changelog) return `## ${newVersion}\n`;
            return notes.get(path)!;
          },
          { releaseOnly: true },
        );
    };
    expect(release('0.1.7', '0.1.8', ['patch'])).not.toThrow();
    expect(release('0.1.7', '0.1.9', ['patch'])).toThrow(/require Nemesis 0\.1\.8/);
    expect(release('0.1.7', '0.2.0', ['patch', 'minor'])).not.toThrow();
    expect(release('0.1.7', '0.1.8', ['patch', 'minor'])).toThrow(/require Nemesis 0\.2\.0/);
    expect(release('0.1.7', '0.2.7', ['patch', 'minor'])).toThrow(/require Nemesis 0\.2\.0/);
    expect(release('0.1.7', '1.0.0', ['patch', 'minor', 'major'])).not.toThrow();
    expect(release('1.2.3', '2.0.0', ['major', 'patch'])).not.toThrow();
  });
});
