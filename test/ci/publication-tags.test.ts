import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

function publishRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'nemesis-publication-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));

  const cwd = join(directory, 'checkout');
  const output = join(directory, 'output');
  const manifest = join(cwd, 'apps/web/package.json');
  mkdirSync(join(cwd, 'apps/web'), { recursive: true });
  cpSync(new URL('../../scripts/', import.meta.url), join(cwd, 'scripts'), { recursive: true });

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2026-11-22T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-22T00:00:00Z',
    LC_ALL: 'C',
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', ...args],
      { cwd, encoding: 'utf8', env },
    ).trim();

  const origin = join(directory, 'origin.git');
  git('init', '--quiet', '--initial-branch=main', '--object-format=sha1');
  git('init', '--quiet', '--bare', '--initial-branch=main', '--object-format=sha1', origin);
  git('remote', 'add', 'origin', origin);

  const writeVersion = (version: string) => writeFileSync(manifest, JSON.stringify({ version }));
  const commit = (version: string, message: string) => {
    writeVersion(version);
    git('add', 'apps/web/package.json');
    git('commit', '--quiet', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (script: string, sha: string, ref: string, event: string) => {
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [join(cwd, 'scripts', script)], {
      cwd,
      encoding: 'utf8',
      env: {
        ...env,
        GITHUB_SHA: sha,
        GITHUB_REF: ref,
        GITHUB_EVENT_NAME: event,
        GITHUB_OUTPUT: output,
      },
    });
    if (result.error) throw result.error;
    return { status: result.status, output: readFileSync(output, 'utf8'), stderr: result.stderr };
  };

  return {
    git,
    commit,
    writeVersion,
    classify: (sha: string) => run('publish-verification-lane.mjs', sha, 'refs/heads/main', 'push'),
    publish: (sha: string, ref = 'refs/heads/main', event = 'push') =>
      run('publication-tags.mjs', sha, ref, event),
  };
}

function publishedTags(sha: string, tags: string[], version = '') {
  const image = 'ghcr.io/ashleylamont/smashclub-seeding';
  return [
    'tags<<END_TAGS',
    `${image}:sha-${sha}`,
    ...tags.map((tag) => `${image}:${tag}`),
    'END_TAGS',
    `version=${version}`,
    '',
  ].join('\n');
}

it('classifies and publishes a version merge against its first parent after main advances', () => {
  const { git, commit, classify, publish } = publishRepository();
  commit('1.2.3', 'Before release');
  git('switch', '--quiet', '--create', 'version');
  commit('1.2.4', 'Version Nemesis');
  git('switch', '--quiet', 'main');
  git('merge', '--quiet', '--no-ff', '-m', 'Merge version', 'version');
  const release = git('rev-parse', 'HEAD');
  git('push', '--quiet', 'origin', 'main');

  expect(classify(release)).toMatchObject({ status: 0, output: 'lane=version\n' });
  expect(publish(release)).toMatchObject({
    status: 0,
    output: publishedTags(release, ['main', '1.2.4'], '1.2.4'),
  });

  const tip = commit('1.2.4', 'Next main push');
  git('push', '--quiet', 'origin', 'main');
  expect(publish(release)).toMatchObject({
    status: 1,
    output: '',
    stderr: expect.stringContaining('Checkout differs from the verified commit'),
  });
  expect(publish(tip)).toMatchObject({ status: 0, output: publishedTags(tip, ['main']) });

  git('switch', '--quiet', '--detach', release);
  git('update-ref', 'refs/remotes/origin/main', release);
  expect(publish(release)).toMatchObject({
    status: 0,
    output: publishedTags(release, ['1.2.4'], '1.2.4'),
  });
});

it('classifies the committed manifest and publishes from the checked-out manifest', () => {
  const { git, commit, writeVersion, classify, publish } = publishRepository();
  commit('1.2.3', 'Before release');
  const sha = commit('1.2.4', 'Version Nemesis');
  git('push', '--quiet', 'origin', 'main');
  writeVersion('1.2.3');

  expect(classify(sha)).toMatchObject({ status: 0, output: 'lane=version\n' });
  expect(publish(sha)).toMatchObject({ status: 0, output: publishedTags(sha, ['main']) });
});

it('rejects an unstable parent in the classifier and compares its raw version in publication', () => {
  const { git, commit, classify, publish } = publishRepository();
  commit('1.2.4-beta.1', 'Historical prerelease');
  const sha = commit('1.2.4', 'Version Nemesis');
  git('push', '--quiet', 'origin', 'main');

  expect(classify(sha)).toMatchObject({
    status: 1,
    output: '',
    stderr: expect.stringContaining('Expected a MAJOR.MINOR.PATCH app version'),
  });
  expect(publish(sha)).toMatchObject({
    status: 0,
    output: publishedTags(sha, ['main', '1.2.4'], '1.2.4'),
  });
});

it('publishes manual main and matching annotated tags without a first parent', () => {
  const { git, commit, publish } = publishRepository();
  const sha = commit('1.2.3', 'Root release');
  git('push', '--quiet', 'origin', 'main');

  expect(publish(sha, 'refs/heads/main', 'workflow_dispatch')).toMatchObject({
    status: 0,
    output: publishedTags(sha, ['main']),
  });
  expect(publish(sha, 'refs/tags/v1.2.3')).toMatchObject({
    status: 1,
    output: '',
    stderr: expect.stringContaining('Missing release tag refs/tags/v1.2.3'),
  });

  git('tag', '-a', 'v1.2.3', '-m', 'Nemesis 1.2.3');
  git('push', '--quiet', 'origin', 'refs/tags/v1.2.3');
  expect(publish(sha, 'refs/tags/v1.2.3')).toMatchObject({
    status: 0,
    output: publishedTags(sha, ['1.2.3'], '1.2.3'),
  });
});

it('rejects a version-changing main push when the remote tag points at another commit', () => {
  const { git, commit, publish } = publishRepository();
  const root = commit('1.2.3', 'Before release');
  git('tag', '-a', 'v1.2.4', '-m', 'Conflicting release');
  const sha = commit('1.2.4', 'Version Nemesis');
  git('push', '--quiet', 'origin', 'main', 'refs/tags/v1.2.4');

  expect(publish(sha)).toMatchObject({
    status: 1,
    output: '',
    stderr: expect.stringContaining(`Release tag refs/tags/v1.2.4 already points to ${root}`),
  });
});

it('rejects tagged commits outside origin main history', () => {
  const { git, commit, publish } = publishRepository();
  commit('1.2.3', 'Main');
  git('push', '--quiet', 'origin', 'main');
  git('switch', '--quiet', '--create', 'feature');
  const sha = commit('1.2.4', 'Unmerged version');
  git('tag', 'v1.2.4');
  git('push', '--quiet', 'origin', 'refs/tags/v1.2.4');

  expect(publish(sha, 'refs/tags/v1.2.4')).toMatchObject({
    status: 1,
    output: '',
    stderr: expect.stringContaining('Only commits on main may be published'),
  });
});
