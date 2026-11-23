import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const versionWorkflow = parse(readFileSync('.github/workflows/version.yml', 'utf8'));
const sha = 'a'.repeat(40);

it('uses repository-scoped credentials for version PRs', () => {
  expect(versionWorkflow.on.push.branches).toEqual(['main']);
  expect(versionWorkflow.on).not.toHaveProperty('pull_request');
  expect(versionWorkflow.permissions).toEqual({
    actions: 'read',
    checks: 'read',
    contents: 'read',
    'pull-requests': 'read',
  });
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
});

describe('version preflight', () => {
  const steps = versionWorkflow.jobs.version.steps;
  const preflight = steps.find((step: { id?: string }) => step.id === 'empty-changesets');

  it('checks the exact trigger before setup and rechecks immediately before versioning', () => {
    expect(versionWorkflow.on).toHaveProperty('workflow_dispatch');
    expect(steps[0].with).toEqual({
      ref: '${{ github.sha }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    });
    expect(
      steps.slice(1, 9).map((step: { id?: string; uses?: string }) => step.id ?? step.uses),
    ).toEqual([
      'version-source',
      'empty-changesets',
      'candidate',
      './.github/actions/setup-node-pnpm',
      'release-token',
      'candidate-final',
      'version-source-final',
      'changesets',
    ]);
    for (const guard of [steps[1], steps[7]]) {
      expect(guard).toMatchObject({
        env: { GH_TOKEN: '${{ github.token }}' },
        run: 'bash scripts/check-version-source.sh',
      });
    }
    expect(steps[1].if).toBe("env.RELEASE_APP_CONFIGURED == 'true'");
    expect(preflight.if).toBe(
      "steps.version-source.outputs.ready == 'true' && github.event_name == 'push'",
    );
    expect(steps[3]).toMatchObject({
      if: "steps.version-source.outputs.ready == 'true' && steps.empty-changesets.outputs.skip != 'true'",
      env: { GH_TOKEN: '${{ github.token }}' },
      run: 'node scripts/version-candidate.mjs',
    });
    for (const step of [steps[4], steps[5], steps[6]]) {
      expect(step.if).toBe("steps.candidate.outputs.action == 'version'");
    }
    expect(steps[6]).toMatchObject({
      env: {
        GH_TOKEN: '${{ github.token }}',
        EXPECTED_VERSION_CANDIDATE: '${{ steps.candidate.outputs.candidate }}',
      },
      run: 'node scripts/version-candidate.mjs',
    });
    expect(steps[7].if).toBe("steps.candidate-final.outputs.action == 'version'");
    expect(steps[8].if).toBe("steps.version-source-final.outputs.ready == 'true'");
    expect(
      steps.find((step: { name?: string }) => step.name?.startsWith('Queue the version PR')).run,
    ).toContain('--match-head-commit "$head"');
  });

  it('accepts a fresh trigger and stops stale or unverifiable sources', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nemesis-version-source-'));
    const output = join(cwd, 'output');
    const script = fileURLToPath(new URL('../../scripts/check-version-source.sh', import.meta.url));
    const newer = 'b'.repeat(40);
    try {
      writeFileSync(
        join(cwd, 'git'),
        '#!/bin/sh\n[ "$*" = "rev-parse HEAD" ] || exit 1\nprintf "%s\\n" "$CHECKOUT_SHA"\n',
        { mode: 0o700 },
      );
      writeFileSync(
        join(cwd, 'gh'),
        [
          '#!/bin/sh',
          '[ "$*" = "api repos/test/nemesis/git/ref/heads/main --jq .object.sha" ] || exit 1',
          '[ "$GH_TOKEN" = read-token ] || exit 1',
          '[ "$LOOKUP_FAILS" = false ] || exit 1',
          'printf "%s\\n" "$MAIN_SHA"',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      const guard = (main: string, event = 'push', checkout = sha, lookupFails = false) => {
        writeFileSync(output, '');
        const run = spawnSync('/bin/bash', [script], {
          cwd,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${cwd}:${process.env.PATH}`,
            GITHUB_REPOSITORY: 'test/nemesis',
            GITHUB_SHA: sha,
            GITHUB_EVENT_NAME: event,
            GITHUB_OUTPUT: output,
            GH_TOKEN: 'read-token',
            CHECKOUT_SHA: checkout,
            MAIN_SHA: main,
            LOOKUP_FAILS: String(lookupFails),
          },
        });
        return { status: run.status, output: readFileSync(output, 'utf8'), stdout: run.stdout };
      };
      expect(guard(sha)).toMatchObject({ status: 0, output: 'ready=true\n' });
      expect(guard(newer)).toMatchObject({ status: 0, output: 'ready=false\n' });
      expect(guard(sha, 'workflow_dispatch')).toMatchObject({ status: 0, output: 'ready=true\n' });
      const staleDispatch = guard(newer, 'workflow_dispatch');
      expect(staleDispatch).toMatchObject({ status: 0, output: 'ready=false\n' });
      expect(staleDispatch.stdout).toContain('Run Version Nemesis again on main');
      for (const result of [guard(sha, 'push', newer), guard(sha, 'push', sha, true), guard('')]) {
        expect(result).toMatchObject({ status: 1, output: '' });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { entries: [], expected: 'skip=true\n' },
    { entries: ['candidate.md'], expected: '' },
    { entries: ['pre.json'], expected: '' },
    { entries: ['pre/note.md'], expected: '' },
    { entries: ['unexpected'], expected: '' },
    { entries: [], missingDirectory: true, expected: '' },
    { entries: [], failedInspection: true, expected: '' },
  ])('emits a skip only for a known empty directory (%j)', (scenario) => {
    const cwd = mkdtempSync(join(tmpdir(), 'nemesis-version-preflight-'));
    const output = join(cwd, 'output');
    try {
      if (!scenario.missingDirectory) {
        for (const name of ['README.md', 'config.json', 'changelog.mjs', ...scenario.entries]) {
          const file = join(cwd, '.changeset', name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, '');
        }
      }
      writeFileSync(output, '');
      const result = spawnSync('/bin/bash', ['-eo', 'pipefail', '-c', preflight.run], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          ...(scenario.failedInspection && { PATH: '' }),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(scenario.expected);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
