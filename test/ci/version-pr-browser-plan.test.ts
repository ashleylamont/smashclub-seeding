import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasGeneratedReleaseDiff, isVersionAppPr } from '../../scripts/version-pr-browser-plan.mjs';

const appId = 353923899;
const repoId = 1172266037;
const head = 'a'.repeat(40);
const identity = { actorId: String(appId), repositoryId: String(repoId), head };
const event = {
  action: 'opened',
  sender: { id: appId },
  repository: { id: repoId },
  pull_request: {
    user: { id: appId },
    head: { ref: 'changeset-release/main', sha: head, repo: { id: repoId } },
    base: { ref: 'main', repo: { id: repoId } },
  },
};

describe('automatic version PR identity', () => {
  it.each(['opened', 'synchronize'])('accepts the exact release App %s', (action) => {
    expect(isVersionAppPr({ ...event, action }, identity)).toBe(true);
  });

  it('rejects missing or untrusted App, repository, ref and head evidence', () => {
    const pr = event.pull_request;
    for (const candidate of [
      undefined,
      {},
      { ...event, sender: undefined },
      { ...event, sender: { id: 8 } },
      { ...event, sender: { id: String(appId) } },
      { ...event, action: 'reopened' },
      { ...event, repository: { id: 8 } },
      { ...event, pull_request: { ...pr, user: { id: 8 } } },
      { ...event, pull_request: { ...pr, head: { ...pr.head, repo: { id: 8 } } } },
      { ...event, pull_request: { ...pr, head: { ...pr.head, repo: undefined } } },
      { ...event, pull_request: { ...pr, head: { ...pr.head, ref: 'ordinary' } } },
      { ...event, pull_request: { ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } } },
      { ...event, pull_request: { ...pr, base: { ...pr.base, ref: 'other' } } },
      { ...event, pull_request: { ...pr, base: { ...pr.base, repo: { id: 8 } } } },
    ]) {
      expect(isVersionAppPr(candidate, identity), JSON.stringify(candidate)).toBe(false);
    }
    expect(isVersionAppPr(event, { ...identity, actorId: '8' })).toBe(false);
    expect(isVersionAppPr(event, { ...identity, repositoryId: 'undefined' })).toBe(false);
  });
});

const appPackage = 'apps/web/package.json';
const changelog = 'apps/web/CHANGELOG.md';
const note = '.changeset/known-change.md';
const noteContents = "---\n'@smashclub/web': patch\n---\n\n**Fix** · Keep the QR visible.\n";
const preface = '# Nemesis changelog\n\nBuild notes.\n\n';
const history = '## 0.7.2\n\n### Patch Changes\n\n- The previous change.\n';
const release = '## 0.7.3\n\n### Patch Changes\n\n- Keep the QR visible.\n\n';
const releaseChanges = [
  ['D', note],
  ['M', appPackage],
  ['M', changelog],
];
const previous = {
  [appPackage]: '{"version":"0.7.2","private":true}',
  [changelog]: preface + history,
  [note]: noteContents,
};
const versioned = {
  [appPackage]: '{"version":"0.7.3","private":true}',
  [changelog]: preface + release + history,
};

function read(
  before: Record<string, string> = previous,
  after: Record<string, string> = versioned,
) {
  return (revision: string, path: string) => (revision === 'base' ? before : after)[path]!;
}

describe('exact release-only diff', () => {
  it('accepts a generated version with existing history preserved', () => {
    expect(hasGeneratedReleaseDiff(releaseChanges, read())).toBe(true);
  });

  it('rejects code, dependency, tooling, and changeset edits', () => {
    for (const entry of [
      ['M', 'apps/web/src/main.tsx'],
      ['M', 'pnpm-lock.yaml'],
      ['M', '.changeset/config.json'],
      ['A', '.changeset/another-note.md'],
      ['M', 'apps/web/public/changelog/image.png'],
    ]) {
      expect(hasGeneratedReleaseDiff([...releaseChanges, entry], read()), entry.join(' ')).toBe(
        false,
      );
    }
    expect(hasGeneratedReleaseDiff(releaseChanges.slice(1), read())).toBe(false);
    expect(hasGeneratedReleaseDiff(releaseChanges, read({ ...previous, [note]: 'broken' }))).toBe(
      false,
    );
    for (const manifest of ['{', '{"version":"0.7.3","private":false}']) {
      expect(
        hasGeneratedReleaseDiff(
          releaseChanges,
          read(previous, { ...versioned, [appPackage]: manifest }),
        ),
      ).toBe(false);
    }
  });

  it('rejects empty entries, retouched history and altered preface', () => {
    for (const contents of [
      `${preface}## 0.7.3\n\n${history}`,
      preface + release,
      preface + release + history.replace('previous', 'retouched'),
      `${preface}${release}## 0.7.0\n\n- Another release.\n\n${history}`,
      preface.replace('Build notes.', 'Altered notes.') + release + history,
    ]) {
      expect(
        hasGeneratedReleaseDiff(
          releaseChanges,
          read(previous, { ...versioned, [changelog]: contents }),
        ),
      ).toBe(false);
    }
  });
});

it('uses the actual tested parents and tree and only writes deferral for PRs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nemesis-release-browser-plan-'));
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
  const write = (path: string, content: string) => {
    const destination = join(cwd, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  const commit = (message: string) => {
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const eventPath = join(cwd, '.git', 'event.json');
  const probe = `
    import { readPrChanges, readPrMerge } from ${JSON.stringify(
      new URL('../../scripts/pr-merge.mjs', import.meta.url).href,
    )};
    import { shouldDeferVersionBrowser } from ${JSON.stringify(
      new URL('../../scripts/version-pr-browser-plan.mjs', import.meta.url).href,
    )};
    const tested = readPrMerge(process.argv[1]);
    process.stdout.write(String(shouldDeferVersionBrowser(tested, readPrChanges(tested))));
  `;
  const defer = (prHead: string, env: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe, prHead], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTOR_ID: identity.actorId,
        GITHUB_REPOSITORY_ID: identity.repositoryId,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        CI_REPORT_ONLY: 'false',
        ...env,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout === 'true';
  };

  try {
    git('init', '--quiet', '--initial-branch=main');
    for (const [path, contents] of Object.entries(previous)) write(path, contents);
    const base = commit('Main with pending notes');
    git('switch', '--quiet', '--create', 'changeset-release/main');
    for (const [path, contents] of Object.entries(versioned)) write(path, contents);
    git('rm', '--quiet', note);
    const prHead = commit('Version Nemesis');
    const payload = JSON.stringify({
      ...event,
      pull_request: {
        ...event.pull_request,
        head: { ...event.pull_request.head, sha: prHead },
        base: { ...event.pull_request.base, sha: 'b'.repeat(40) },
      },
    });
    write('.git/event.json', payload);

    git('switch', '--quiet', 'main');
    git('merge', '--quiet', '--no-ff', '--no-edit', prHead);
    expect(defer(prHead)).toBe(true);
    expect(defer(prHead, { CI_REPORT_ONLY: 'true' })).toBe(false);
    for (const eventName of ['push', 'workflow_dispatch', 'workflow_call']) {
      expect(defer(prHead, { GITHUB_EVENT_NAME: eventName })).toBe(false);
    }
    write('.git/event.json', '{');
    expect(defer(prHead)).toBe(false);
    write('.git/event.json', payload);

    git('reset', '--hard', base);
    git('merge', '--quiet', '--no-ff', '--no-commit', prHead);
    write(changelog, versioned[changelog].replace('Keep the QR visible.', 'Retouched note.'));
    commit('Synthetic merge with modified release bytes');
    expect(defer(prHead)).toBe(false);

    git('reset', '--hard', base);
    write('unrelated.txt', 'New main content');
    commit('Main advanced');
    git('merge', '--quiet', '--no-ff', '--no-edit', prHead);
    expect(defer(prHead)).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
