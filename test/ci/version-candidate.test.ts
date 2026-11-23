import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { planVersionCandidate, versionQueueHead } from '../../scripts/version-candidate.mjs';

const repo = 'ashleylamont/smashclub-seeding';
const repoId = 1172266037;
const actor = { id: 353923899 };
const source = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const head = 'c'.repeat(40);
const other = 'd'.repeat(40);
const branch = 'changeset-release/main';
const pr = {
  number: 492,
  state: 'open',
  draft: false,
  user: actor,
  base: { ref: 'main', repo: { id: repoId } },
  head: { ref: branch, sha: head, repo: { id: repoId } },
  auto_merge: { enabled_by: actor, merge_method: 'merge' },
  mergeable: true,
  mergeable_state: 'blocked',
};
const commit = {
  sha: head,
  author: actor,
  commit: { verification: { verified: true } },
  parents: [{ sha: parent }],
};
const run = {
  id: 1201,
  run_number: 45,
  event: 'pull_request',
  path: '.github/workflows/ci.yml',
  actor,
  repository: { id: repoId },
  head_repository: { id: repoId },
  head_branch: branch,
  head_sha: head,
  check_suite_id: 1202,
  status: 'completed',
  conclusion: 'success',
};
const check = {
  id: 1203,
  name: 'All checks',
  app: { id: 15368 },
  head_sha: head,
  check_suite: { id: run.check_suite_id },
  status: 'completed',
  conclusion: 'success',
};
const collection = <T>(field: string, entries: T[]) => ({
  total_count: entries.length,
  [field]: entries,
});
const paths = {
  list: 'pulls?',
  refs: 'git/matching-refs/',
  pr: `pulls/${pr.number}`,
  checks: `commits/${head}/check-runs?`,
  commit: `commits/${head}`,
  runs: 'actions/workflows/ci.yml/runs?',
};
const defaults = {
  list: [{ number: pr.number, head: pr.head }],
  refs: [{ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: head } }],
  pr,
  commit,
  runs: collection('workflow_runs', [run]),
  checks: collection('check_runs', [check]),
};

function fixture(replacements = {}, options = {}) {
  const calls: string[] = [];
  const responses = { ...defaults, ...replacements };
  const result = planVersionCandidate({
    repo,
    repoId,
    source,
    request(path: string) {
      calls.push(path);
      const key = Object.entries(paths).find(([, match]) => path.startsWith(match))?.[0];
      if (!key) throw new Error(`Unexpected fixture API path: ${path}`);
      return responses[key as keyof typeof defaults];
    },
    ...options,
  });
  return { result, calls };
}

describe('automatic version candidate admission', () => {
  it('keeps signed candidates pending before exact CI starts or while it runs', () => {
    for (const runs of [
      [],
      [{ ...run, status: 'queued', conclusion: null }],
      [{ ...run, status: 'in_progress', conclusion: null }],
    ]) {
      expect(fixture({ runs: collection('workflow_runs', runs) }).result).toMatchObject({
        action: 'retain',
        candidate: `${pr.number}:${head}`,
      });
    }
  });

  it('keeps a passing candidate ahead of subsequent main pushes', () => {
    expect(fixture().result.action).toBe('retain');
    expect(
      fixture({ checks: collection('check_runs', [{ ...check, check_suite: { id: 2000 } }]) })
        .result.action,
    ).toBe('retain');
  });

  it('refreshes a genuinely failed or cancelled candidate only after the source advances', () => {
    for (const outcome of ['failure', 'cancelled', 'timed_out']) {
      const terminal = {
        runs: collection('workflow_runs', [{ ...run, conclusion: outcome }]),
        checks: collection('check_runs', [{ ...check, conclusion: outcome }]),
      };
      expect(fixture(terminal).result.action).toBe('version');
      expect(fixture(terminal, { source: parent }).result.action).toBe('retain');
    }
    expect(
      fixture({
        runs: collection('workflow_runs', [{ ...run, conclusion: 'cancelled' }]),
        checks: collection('check_runs', []),
      }).result.action,
    ).toBe('version');
  });

  it('follows a running retry instead of a previous failed attempt', () => {
    const runs = [
      { ...run, conclusion: 'failure' },
      { ...run, id: 1204, run_number: 46, status: 'in_progress', conclusion: null },
    ];
    expect(fixture({ runs: collection('workflow_runs', runs) }).result.action).toBe('retain');
  });

  it('refreshes a definitive conflict only on a new source', () => {
    const conflict = { ...pr, mergeable: false, mergeable_state: 'dirty' };
    expect(fixture({ pr: conflict }).result.action).toBe('version');
    expect(fixture({ pr: conflict }, { source: parent }).result.action).toBe('retain');
    expect(
      fixture({ pr: { ...pr, mergeable: null, mergeable_state: 'unknown' } }).result.action,
    ).toBe('retain');
  });

  it('leaves paused, draft and mismatched auto-merge modes to the maintainer', () => {
    for (const variant of [
      { ...pr, auto_merge: null },
      { ...pr, draft: true },
      { ...pr, auto_merge: { enabled_by: actor, merge_method: 'squash' } },
    ]) {
      expect(fixture({ pr: variant }).result.action).toBe('retain');
    }
  });

  it('rejects foreign or unverifiable candidates and unavailable evidence', () => {
    for (const override of [
      { pr: { ...pr, user: { id: 44 } } },
      { pr: { ...pr, head: { ...pr.head, repo: { id: 44 } } } },
      { commit: { ...commit, author: { id: 44 } } },
      { commit: { ...commit, commit: { verification: { verified: false } } } },
      { pr: { ...pr, auto_merge: undefined } },
      { list: undefined },
      { runs: { total_count: 0 } },
      { runs: collection('workflow_runs', [{ ...run, actor: { id: 44 } }]) },
      { checks: { total_count: 0 } },
    ]) {
      expect(() => fixture(override)).toThrow();
    }
  });

  it('does not update a changed candidate or one merged during lookup', () => {
    expect(fixture({ pr: { ...pr, state: 'closed' } }).result.action).toBe('retain');
    expect(fixture({ pr: { ...pr, head: { ...pr.head, sha: other } } }).result.action).toBe(
      'retain',
    );
    expect(
      fixture({ list: [], refs: [] }, { expected: `${pr.number}:${head}` }).result.action,
    ).toBe('retain');
    expect(fixture({}, { expected: `493:${other}` }).result.action).toBe('retain');
    expect(fixture({}, { expected: '' }).result.action).toBe('retain');
  });

  it('refuses to overwrite an unrelated orphan branch and compares its exact tip', () => {
    expect(() => fixture({ list: [], commit: { ...commit, author: { id: 44 } } })).toThrow();
    expect(fixture({ list: [] }).result.candidate).toBe(`none:${head}`);
    expect(fixture({ list: [] }, { expected: 'none' }).result.action).toBe('retain');
  });

  it('allows creating a candidate when the initial and final observations find none', () => {
    expect(fixture({ list: [], refs: [] }).result).toMatchObject({
      action: 'version',
      candidate: 'none',
    });
    expect(fixture({ list: [], refs: [] }, { expected: 'none' }).result.action).toBe('version');
  });
});

it('checks activation and action outputs with a fake GitHub CLI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nemesis-version-candidate-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    const output = join(directory, 'output');
    const cli = join(directory, 'gh');
    writeFileSync(cli, '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
    const script = new URL('../../scripts/version-candidate.mjs', import.meta.url);
    const runScript = () =>
      spawnSync(process.execPath, [script.pathname], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: repo,
          GITHUB_REPOSITORY_ID: String(repoId),
          GITHUB_SHA: source,
          GITHUB_OUTPUT: output,
        },
      });
    let result = runScript();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('action=version\ncandidate=legacy\n');

    writeFileSync(join(directory, 'scripts/resolve-numbered-publish.mjs'), '');
    writeFileSync(output, '');
    result = runScript();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('action=version\ncandidate=legacy\n');

    mkdirSync(join(directory, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(directory, '.github/workflows/publish.yml'),
      'jobs:\n  verify-snapshot:\n    runs-on: ubuntu-latest\n',
    );
    writeFileSync(output, '');
    result = runScript();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('action=version\ncandidate=none\n');

    writeFileSync(cli, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    writeFileSync(output, '');
    result = runScript();
    expect(result.status).not.toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('queue a new signed release candidate', () => {
  function queue(prPatch = {}, commitPatch = {}, prior = 'none') {
    return versionQueueHead({
      repoId,
      source: parent,
      number: pr.number,
      prior,
      request(path: string) {
        if (path === paths.pr) return { ...pr, auto_merge: null, ...prPatch };
        if (path === paths.commit) return { ...commit, ...commitPatch };
        if (path.startsWith(paths.refs)) return defaults.refs;
        throw new Error(`Unexpected fixture API path: ${path}`);
      },
    });
  }

  it('returns only the signed candidate just created from the exact workflow source', () => {
    expect(queue()).toBe(head);
    expect(queue({ auto_merge: pr.auto_merge })).toBeNull();
    expect(() => queue({}, { parents: [{ sha: source }] })).toThrow();
    expect(() => queue({ user: { id: 44 } })).toThrow();
  });

  it('keeps an existing or drafted candidate paused if auto-merge was disabled', () => {
    expect(queue({}, {}, `${pr.number}:${other}`)).toBeNull();
    expect(queue({ draft: true })).toBeNull();
  });
});
