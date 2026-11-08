import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('classifies the exact build against its first parent and leaves uncertain builds in the original queue', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nemesis-publish-lane-'));
  const output = join(cwd, 'output');
  const script = fileURLToPath(
    new URL('../../scripts/publish-verification-lane.mjs', import.meta.url),
  );
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      },
    ).trim();
  const commit = (version: string, message: string) => {
    writeFileSync(join(cwd, 'apps/web/package.json'), JSON.stringify({ version }));
    git('add', 'apps/web/package.json');
    git('commit', '--quiet', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const classify = (sha: string) => {
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: sha, GITHUB_OUTPUT: output },
    });
    return { status: result.status, output: readFileSync(output, 'utf8') };
  };
  try {
    mkdirSync(join(cwd, 'apps/web'), { recursive: true });
    git('init', '--quiet', '--initial-branch=main');
    commit('0.2.4', 'Initial');
    const ordinary = commit('0.2.4', 'Ordinary push');
    expect(classify(ordinary)).toEqual({ status: 0, output: 'lane=ordinary\n' });

    git('switch', '--quiet', '--create', 'version');
    commit('0.2.5', 'Version Nemesis');
    git('switch', '--quiet', 'main');
    git('merge', '--quiet', '--no-ff', '--no-edit', 'version');
    const release = git('rev-parse', 'HEAD');
    const tip = commit('0.2.5', 'Later main push');
    expect(classify(tip)).toEqual({ status: 0, output: 'lane=ordinary\n' });
    expect(classify(release)).toEqual({ status: 1, output: '' });
    git('switch', '--quiet', '--detach', release);
    expect(classify(release)).toEqual({ status: 0, output: 'lane=version\n' });
    git('switch', '--quiet', 'main');
    expect(classify(commit('invalid', 'Invalid version'))).toEqual({ status: 1, output: '' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
