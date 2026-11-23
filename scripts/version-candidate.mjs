import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const releaseApp = 353923899;
const githubActions = 15368;
const branch = 'changeset-release/main';
const branchRef = `refs/heads/${branch}`;
const sha = /^[a-f0-9]{40}$/;
const terminal = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

function collection(data, key) {
  const entries = data?.[key];
  if (!Array.isArray(entries) || data.total_count !== entries.length)
    throw new Error(`Could not verify complete GitHub ${key} evidence.`);
  return entries;
}

function signedCandidateParent(request, head) {
  const result = request(`commits/${head}`);
  if (
    result?.sha !== head ||
    result.author?.id !== releaseApp ||
    result.commit?.verification?.verified !== true ||
    result.parents?.length !== 1 ||
    !sha.test(result.parents[0]?.sha)
  ) {
    throw new Error('The release branch head is not a recognized signed release App commit.');
  }
  return result.parents[0].sha;
}

function branchHead(request) {
  const refs = request(`git/matching-refs/heads/${branch}`);
  if (!Array.isArray(refs) || refs.some((entry) => typeof entry?.ref !== 'string'))
    throw new Error('Could not verify the release branch ref.');
  const matches = refs.filter((entry) => entry.ref === branchRef);
  if (!matches.length) return null;
  if (
    matches.length !== 1 ||
    matches[0].object?.type !== 'commit' ||
    !sha.test(matches[0].object?.sha)
  )
    throw new Error('Could not verify the release branch head.');
  return matches[0].object.sha;
}

function exactCiOutcome(request, { head, repoId }) {
  const evidence = request(
    `actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`,
  );
  const runs = collection(evidence, 'workflow_runs');
  if (
    runs.some(
      (run) =>
        run?.head_sha !== head ||
        run.head_branch !== branch ||
        run.event !== 'pull_request' ||
        run.path !== '.github/workflows/ci.yml' ||
        run.actor?.id !== releaseApp ||
        run.repository?.id !== repoId ||
        run.head_repository?.id !== repoId ||
        !Number.isSafeInteger(run.run_number) ||
        !Number.isSafeInteger(run.check_suite_id),
    )
  ) {
    throw new Error('Could not attribute the exact release candidate CI to the release App.');
  }
  const latest = runs.sort((a, b) => b.run_number - a.run_number)[0];
  if (latest?.status !== 'completed') return 'pending';
  const checks = collection(
    request(`commits/${head}/check-runs?check_name=All%20checks&filter=latest&per_page=100`),
    'check_runs',
  ).filter(
    (check) =>
      check?.head_sha === head &&
      check.app?.id === githubActions &&
      check.name === 'All checks' &&
      check.check_suite?.id === latest.check_suite_id,
  );
  if (checks.length > 1)
    throw new Error('Found ambiguous required checks for the release candidate.');
  const aggregate = checks[0];
  if (aggregate?.status === 'completed') {
    if (latest.conclusion === 'success' && aggregate.conclusion === 'success') return 'passing';
    if (terminal.has(latest.conclusion) && terminal.has(aggregate.conclusion)) return 'failed';
  }
  if (!aggregate && ['cancelled', 'timed_out', 'startup_failure'].includes(latest.conclusion))
    return 'failed';
  return 'pending';
}

function assertCandidatePr(pr, repoId) {
  if (
    pr.user?.id !== releaseApp ||
    pr.head?.ref !== branch ||
    pr.head?.repo?.id !== repoId ||
    pr.base?.ref !== 'main' ||
    pr.base?.repo?.id !== repoId ||
    typeof pr.draft !== 'boolean' ||
    (pr.auto_merge !== null && typeof pr.auto_merge !== 'object')
  ) {
    throw new Error(
      'The open release branch pull request is not a recognized release App candidate.',
    );
  }
}

export function planVersionCandidate({ repo, repoId, source, request, expected }) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') ||
    !Number.isSafeInteger(repoId) ||
    repoId <= 0 ||
    !sha.test(source ?? '')
  )
    throw new Error('Version candidate lookup requires an exact repository and source commit.');

  const query = new URLSearchParams({
    state: 'open',
    head: `${repo.split('/')[0]}:${branch}`,
    per_page: '2',
  });
  const matches = request(`pulls?${query}`);
  if (!Array.isArray(matches) || matches.length > 1)
    throw new Error('Could not identify one release candidate.');
  const remoteHead = branchHead(request);
  let candidate = remoteHead ? `none:${remoteHead}` : 'none';
  const retain = (reason) => ({ action: 'retain', candidate, reason });
  const version = (reason) => ({ action: 'version', candidate, reason });

  if (!matches.length) {
    if (expected !== undefined && candidate !== expected)
      return retain('The release branch changed during this run.');
    if (remoteHead) signedCandidateParent(request, remoteHead);
    return version('There is no open version PR.');
  }

  const match = matches[0];
  if (!Number.isSafeInteger(match?.number) || match.number <= 0 || !sha.test(match.head?.sha))
    throw new Error('Invalid release candidate in GitHub pull request results.');
  const head = match.head.sha;
  candidate = `${match.number}:${head}`;
  if ((expected !== undefined && candidate !== expected) || remoteHead !== head)
    return retain('The release candidate changed during this run.');
  const pr = request(`pulls/${match.number}`);
  if (pr?.number !== match.number || !['open', 'closed'].includes(pr.state))
    throw new Error('Could not verify the release candidate pull request.');
  if (pr.state === 'closed' || pr.head?.sha !== head)
    return retain('The release candidate changed during this run.');
  assertCandidatePr(pr, repoId);

  const parent = signedCandidateParent(request, head);
  if (pr.draft || pr.auto_merge?.merge_method !== 'merge')
    return retain(
      'Auto-merge is paused. Review the existing version PR in GitHub before resuming.',
    );
  const conflicted = pr.mergeable === false && pr.mergeable_state === 'dirty';
  const outcome = conflicted ? 'conflicted' : exactCiOutcome(request, { head, repoId });
  if (outcome === 'failed' || outcome === 'conflicted') {
    if (parent !== source)
      return version(`The previous candidate is ${outcome} and main has advanced.`);
    return retain(
      `The candidate is ${outcome}. Inspect the version PR and retry its exact checks as appropriate.`,
    );
  }
  return retain(
    `The current candidate's exact checks are ${outcome}. Later Changesets stay on main.`,
  );
}

export function versionQueueHead({ repoId, source, number, prior, request }) {
  if (
    !Number.isSafeInteger(repoId) ||
    repoId <= 0 ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !sha.test(source ?? '') ||
    !/^(?:none(?::[a-f0-9]{40})?|[1-9][0-9]*:[a-f0-9]{40})$/.test(prior ?? '')
  )
    throw new Error('Could not verify the version run that created this pull request.');
  // An update must not undo a maintainer's decision to disable auto-merge.
  if (prior.startsWith(`${number}:`)) return null;
  const pr = request(`pulls/${number}`);
  if (pr?.number !== number || !['open', 'closed'].includes(pr.state))
    throw new Error('Could not verify the newly created version pull request.');
  if (pr.state === 'closed') return null;
  assertCandidatePr(pr, repoId);
  if (pr.draft || pr.auto_merge !== null) return null;
  const head = pr.head.sha;
  if (
    !sha.test(head) ||
    branchHead(request) !== head ||
    signedCandidateParent(request, head) !== source
  )
    throw new Error('The new version PR no longer points to this run’s signed candidate.');
  return head;
}

function runCli() {
  const repo = process.env.GITHUB_REPOSITORY;
  const repoId = Number(process.env.GITHUB_REPOSITORY_ID);
  const source = process.env.GITHUB_SHA;
  const expected = process.env.EXPECTED_VERSION_CANDIDATE;
  const request = (path) =>
    JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/${path}`], {
        encoding: 'utf8',
        timeout: 15_000,
      }),
    );
  if (process.argv[2] === '--queue') {
    const number = Number(process.argv[3]);
    const head = versionQueueHead({ repoId, source, number, prior: expected, request });
    if (head) console.log(head);
    return;
  }
  // This checkout is the protected source SHA. Keep the eager flow until
  // that source has the resolver and independently verified snapshot job.
  const publishWorkflow = '.github/workflows/publish.yml';
  const activated =
    existsSync('scripts/resolve-numbered-publish.mjs') &&
    existsSync(publishWorkflow) &&
    readFileSync(publishWorkflow, 'utf8').split(/\r?\n/).includes('  verify-snapshot:');
  const result = activated
    ? planVersionCandidate({ repo, repoId, source, expected, request })
    : {
        action: 'version',
        candidate: 'legacy',
        reason: 'Snapshot publication support is not active.',
      };
  console.log(result.reason);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `action=${result.action}\ncandidate=${result.candidate}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
