import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadReleasePullRequests,
  resolveNumberedPublish,
} from '../../scripts/resolve-numbered-publish.mjs';

const repositoryId = 1172266037;
const appId = 353923899;
const note = "---\n'@smashclub/web': patch\n---\n\n**Fix** · Correct a score.\n";
const worktrees: string[] = [];

afterEach(() => {
  for (const worktree of worktrees.splice(0)) rmSync(worktree, { recursive: true, force: true });
});

function history() {
  const cwd = mkdtempSync(join(tmpdir(), 'nemesis-numbered-publish-'));
  worktrees.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, data: string) => writeFileSync(join(cwd, path), data);
  const author = () => git('rev-parse', 'HEAD');
  const commit = (description: string) => {
    git('add', '-A');
    git('commit', '-qm', description);
    return author();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'release@example.test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(cwd, 'apps/web'), { recursive: true });
  mkdirSync(join(cwd, '.changeset'));
  write('apps/web/package.json', '{"name":"@smashclub/web","version":"0.1.0"}\n');
  write('apps/web/CHANGELOG.md', '# Nemesis changelog\n\n## 0.1.0\n\n- Earlier release.\n');
  write('.changeset/README.md', '# Changesets\n');
  commit('Previous version');
  const addNote = (name: string, summary = 'Correct a score.') =>
    write(`.changeset/${name}.md`, note.replace('Correct a score.', summary));
  addNote('score');
  write('source.ts', 'export const score = 1;\n');
  commit('Score correction');
  const prepare = (leaveNote = false) => {
    write('apps/web/package.json', '{"name":"@smashclub/web","version":"0.1.1"}\n');
    write(
      'apps/web/CHANGELOG.md',
      '# Nemesis changelog\n\n## 0.1.1\n\n- Correct a score.\n\n## 0.1.0\n\n- Earlier release.\n',
    );
    if (!leaveNote) git('rm', '-q', '.changeset/score.md');
    return commit('Version Nemesis');
  };
  const mergeCut = ({ advance = true, extraCandidateNote = false } = {}) => {
    if (extraCandidateNote) {
      addNote('remaining');
      commit('Add another note before versioning');
    }
    git('switch', '-qc', 'changeset-release/main');
    const cutBase = author();
    const cut = prepare();
    git('switch', '-q', 'main');
    if (advance) {
      addNote('station', 'Show the next station assignment.');
      write('source.ts', 'export const score = 2;\n');
      commit('New station workflow');
    }
    git('merge', '--no-ff', 'changeset-release/main', '-qm', 'Version PR');
    const merge = author();
    const pullRequest = {
      merged_at: '2026-11-23T04:00:00Z',
      merge_commit_sha: merge,
      user: { id: appId },
      head: { ref: 'changeset-release/main', sha: cut, repo: { id: repositoryId } },
      base: { ref: 'main', repo: { id: repositoryId } },
    };
    const verifiedCommit = {
      sha: cut,
      author: { id: appId },
      parents: [{ sha: cutBase }],
      commit: { verification: { verified: true, reason: 'valid' } },
    };
    return { merge, cut, pullRequest, verifiedCommit };
  };
  return { cwd, git, prepare, mergeCut, write, commit };
}

describe('numbered release source selection', { timeout: 30_000 }, () => {
  it('publishes the complete pinned cut when a later change lands while it is checked', () => {
    const { cwd, git, mergeCut } = history();
    const { merge, cut, pullRequest, verifiedCommit } = mergeCut();
    expect(
      resolveNumberedPublish({
        cwd,
        merge,
        repositoryId,
        pullRequests: [pullRequest],
        verifiedCommit,
      }),
    ).toEqual({ source: cut, version: '0.1.1' });
    expect(git('show', `${cut}:source.ts`)).toBe('export const score = 1;');
    expect(git('show', `${merge}:source.ts`)).toBe('export const score = 2;');
    expect(git('show', `${merge}:.changeset/station.md`)).toContain('station assignment');
    expect(git('ls-tree', '-r', '--name-only', cut, '.changeset')).not.toContain('station.md');
  });

  it('versions the remaining later changes on the next cut', () => {
    const { cwd, git, mergeCut, write, commit } = history();
    const { merge: firstRelease, cut } = mergeCut();
    const changelog = 'apps/web/CHANGELOG.md';
    const firstNotes = git('show', `${cut}:${changelog}`);
    expect(firstNotes).not.toContain('Show the next station assignment.');
    expect(git('show', `${firstRelease}:.changeset/station.md`)).toContain('station assignment');

    write('apps/web/package.json', '{"name":"@smashclub/web","version":"0.1.2"}\n');
    write(
      changelog,
      `${firstNotes.replace('## 0.1.1', '## 0.1.2\n\n- Show the next station assignment.\n\n## 0.1.1')}\n`,
    );
    git('rm', '-q', '.changeset/station.md');
    const secondRelease = commit('Release the station change');
    expect(
      resolveNumberedPublish({ cwd, merge: secondRelease, repositoryId, pullRequests: [] }),
    ).toEqual({ source: secondRelease, version: '0.1.2' });
    expect(git('show', `${secondRelease}:source.ts`)).toBe('export const score = 2;');
  });

  it('keeps the existing exact-main release when the checked cut and merge trees agree', () => {
    const { cwd, mergeCut } = history();
    const { merge, pullRequest, verifiedCommit } = mergeCut({ advance: false });
    expect(
      resolveNumberedPublish({
        cwd,
        merge,
        repositoryId,
        pullRequests: [pullRequest],
        verifiedCommit,
      }),
    ).toEqual({ source: merge, version: '0.1.1' });
  });

  it('accepts a complete manual version commit on main with no PR association', () => {
    const { cwd, prepare } = history();
    const merge = prepare();
    expect(resolveNumberedPublish({ cwd, merge, repositoryId, pullRequests: [] })).toEqual({
      source: merge,
      version: '0.1.1',
    });
  });

  it('rejects unsupported or incomplete releases, including a cut that omitted a pending note', () => {
    const partial = history();
    expect(() =>
      resolveNumberedPublish({
        cwd: partial.cwd,
        merge: partial.prepare(true),
        repositoryId,
        pullRequests: [],
      }),
    ).toThrow(/complete|generated|note/i);
    const { cwd, mergeCut } = history();
    const { merge, pullRequest, verifiedCommit } = mergeCut({ extraCandidateNote: true });
    expect(() =>
      resolveNumberedPublish({
        cwd,
        merge,
        repositoryId,
        pullRequests: [pullRequest],
        verifiedCommit,
      }),
    ).toThrow(/complete|generated|note/i);
  });

  it('rejects missing, duplicated, forked, unsigned or inconsistent evidence for a divergent merge', () => {
    const { cwd, mergeCut } = history();
    const { merge, pullRequest, verifiedCommit } = mergeCut();
    const input = { cwd, merge, repositoryId, pullRequests: [pullRequest], verifiedCommit };
    for (const pullRequests of [
      [],
      [pullRequest, pullRequest],
      [{ ...pullRequest, head: { ...pullRequest.head, repo: { id: repositoryId + 1 } } }],
      [{ ...pullRequest, head: { ...pullRequest.head, sha: merge } }],
      [{ ...pullRequest, user: { id: 1 } }],
    ])
      expect(() => resolveNumberedPublish({ ...input, pullRequests })).toThrow(
        /pull request|release App/i,
      );
    expect(() =>
      resolveNumberedPublish({
        ...input,
        verifiedCommit: { ...verifiedCommit, commit: { verification: { verified: false } } },
      }),
    ).toThrow(/signature|verified/i);
  });
});

it('retries delayed merge lookup without losing or inventing associations', async () => {
  const target = 'a'.repeat(40);
  const matched = { merge_commit_sha: target };
  const wrong = { merge_commit_sha: 'b'.repeat(40) };
  const delays: number[] = [];
  const sleep = async (delay: number) => {
    delays.push(delay);
  };
  const lists = [[], [wrong], [wrong, matched]];
  await expect(loadReleasePullRequests(target, () => lists.shift(), sleep)).resolves.toEqual([
    wrong,
    matched,
  ]);
  expect(delays.splice(0)).toEqual([1_000, 3_000]);

  await expect(loadReleasePullRequests(target, () => [wrong], sleep)).resolves.toEqual([wrong]);
  expect(delays).toEqual([1_000, 3_000, 6_000]);
});
