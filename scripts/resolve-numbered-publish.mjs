import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { stableVersionPattern } from './publication-policy.mjs';
import { hasGeneratedReleaseDiff, releaseAppId } from './version-pr-browser-plan.mjs';

const sourceBranch = 'changeset-release/main';
const packagePath = 'apps/web/package.json';
const changelogPath = 'apps/web/CHANGELOG.md';
const changesetFiles = new Set(['README.md', 'config.json', 'changelog.mjs']);
const shaPattern = /^[a-f0-9]{40}$/;
const optionalAssociationDelays = [0, 1_000, 3_000, 6_000];
// Required merge associations can lag the main push. Wait up to 150 seconds in
// total, within the resolver job's five-minute timeout.
const requiredAssociationDelays = [
  ...optionalAssociationDelays,
  10_000,
  20_000,
  30_000,
  30_000,
  30_000,
  20_000,
];

function isPullRequestList(value) {
  return (
    Array.isArray(value) &&
    value.every((pr) => {
      const sha = pr?.merge_commit_sha;
      return sha === null || (typeof sha === 'string' && shaPattern.test(sha));
    })
  );
}

const gitReader =
  (cwd) =>
  (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });
const appVersion = (git, sha) => JSON.parse(git('show', `${sha}:${packagePath}`)).version;
const parents = (git, sha) =>
  git('show', '-s', '--format=%P', sha).trim().split(' ').filter(Boolean);

function assertGeneratedRelease(git, base, release) {
  const fields = git('diff', '--name-status', '-z', '--no-renames', base, release)
    .split('\0')
    .slice(0, -1);
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push(fields.slice(i, i + 2));

  const metadataFiles = git('ls-tree', '-z', release, '--', packagePath, changelogPath)
    .split('\0')
    .filter(Boolean);
  const leftoverNotes = git('ls-tree', '-z', '--name-only', `${release}:.changeset`)
    .split('\0')
    .filter((path) => path && !changesetFiles.has(path));
  if (
    metadataFiles.length !== 2 ||
    metadataFiles.some((entry) => !entry.startsWith('100644 blob ')) ||
    leftoverNotes.length > 0 ||
    !hasGeneratedReleaseDiff(changes, (revision, path) =>
      git('show', `${revision === 'base' ? base : release}:${path}`),
    )
  )
    throw new Error(
      'A numbered release must consume all pending notes in a generated release diff.',
    );
}

/** Choose the commit that will be verified, packaged, tagged, and used for notes. */
export function resolveNumberedPublish({ cwd, merge, repositoryId, pullRequests, verifiedCommit }) {
  if (!shaPattern.test(merge)) throw new Error('Expected a full release merge SHA');
  const git = gitReader(cwd);
  const [first, second, ...extra] = parents(git, merge);
  if (!first || extra.length) throw new Error('Expected one or two parents for the release commit');
  const version = appVersion(git, merge);
  if (version === appVersion(git, first)) return null;
  if (!stableVersionPattern.test(version)) throw new Error('Expected a stable Nemesis version');

  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !isPullRequestList(pullRequests))
    throw new Error('Expected release pull request provenance from GitHub');
  const matching = pullRequests.filter((pr) => pr?.merge_commit_sha === merge);
  if (matching.length > 1 || (second && matching.length !== 1))
    throw new Error('Could not identify one pull request for the release merge');

  const [pullRequest] = matching;
  if (
    pullRequest &&
    (!pullRequest.merged_at ||
      pullRequest.head?.repo?.id !== repositoryId ||
      pullRequest.base?.repo?.id !== repositoryId ||
      pullRequest.base.ref !== 'main' ||
      (second && pullRequest.head.sha !== second))
  )
    throw new Error('Release pull request provenance does not match the protected repository');

  const isApp = pullRequest?.user?.id === releaseAppId;
  const usesAppBranch = pullRequest?.head?.ref === sourceBranch;
  if (isApp || usesAppBranch) {
    if (!isApp || !usesAppBranch || !second)
      throw new Error('The release App must merge its own version branch');
    const [cutBase, ...otherParents] = parents(git, second);
    if (
      verifiedCommit?.sha !== second ||
      verifiedCommit.author?.id !== releaseAppId ||
      verifiedCommit.commit?.verification?.verified !== true ||
      verifiedCommit.commit.verification.reason !== 'valid' ||
      verifiedCommit.parents?.length !== 1 ||
      verifiedCommit.parents[0]?.sha !== cutBase
    )
      throw new Error('The exact release App snapshot needs a verified GitHub signature');
    if (
      !cutBase ||
      otherParents.length ||
      !git('rev-list', '--first-parent', first).split('\n').includes(cutBase) ||
      appVersion(git, second) !== version
    )
      throw new Error('The release snapshot must come from the protected first-parent history');
    assertGeneratedRelease(git, cutBase, second);

    const actualTree = git('rev-parse', `${merge}^{tree}`).trim();
    if (git('merge-tree', '--write-tree', first, second).trim() !== actualTree)
      throw new Error('The merged release differs from the expected composition');
    const cutTree = git('rev-parse', `${second}^{tree}`).trim();
    return { source: cutTree === actualTree ? merge : second, version };
  }

  assertGeneratedRelease(git, first, merge);
  return { source: merge, version };
}

export async function loadReleasePullRequests(
  merge,
  load,
  sleep = wait,
  requiresAssociation = true,
) {
  const delays = requiresAssociation ? requiredAssociationDelays : optionalAssociationDelays;
  let pullRequests;
  for (const delay of delays) {
    if (delay) await sleep(delay);
    pullRequests = load();
    if (!isPullRequestList(pullRequests))
      throw new Error('Expected release pull request provenance from GitHub');
    if (pullRequests.some((pr) => pr.merge_commit_sha === merge)) break;
  }
  return pullRequests;
}

const githubApi = (...args) =>
  JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));

export async function resolveMainRelease({
  cwd,
  merge,
  repository,
  repositoryId,
  api = githubApi,
  sleep,
}) {
  if (!shaPattern.test(merge)) throw new Error('Expected a full release merge SHA');
  const git = gitReader(cwd);
  const [first, second] = parents(git, merge);
  if (!first) throw new Error('Expected a first parent for the main push');
  const previousVersion = appVersion(git, first);
  const version = appVersion(git, merge);
  if (typeof previousVersion !== 'string' || typeof version !== 'string')
    throw new Error('Expected an app version in both committed package manifests');
  if (version === previousVersion) return null;

  const pullRequests = await loadReleasePullRequests(
    merge,
    () => {
      const pages = api('--paginate', '--slurp', `repos/${repository}/commits/${merge}/pulls`);
      return Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : null;
    },
    sleep,
    Boolean(second),
  );
  const appPull = pullRequests.find(
    (pr) => pr?.merge_commit_sha === merge && pr.user?.id === releaseAppId,
  );
  return resolveNumberedPublish({
    cwd,
    merge,
    repositoryId,
    pullRequests,
    verifiedCommit: appPull && second ? api(`repos/${repository}/commits/${second}`) : undefined,
  });
}

if (import.meta.main) {
  const merge = process.env.GITHUB_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  const git = gitReader();
  if (
    !shaPattern.test(merge) ||
    git('rev-parse', 'HEAD').trim() !== merge ||
    process.env.GITHUB_EVENT_NAME !== 'push' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    repository !== 'ashleylamont/smashclub-seeding'
  )
    throw new Error('Numbered release selection requires the exact protected main push');

  const proof = await resolveMainRelease({
    merge,
    repository,
    repositoryId: Number(process.env.GITHUB_REPOSITORY_ID),
  });
  if (proof) {
    console.log(`Nemesis ${proof.version} will be verified and published from ${proof.source}.`);
    appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${proof.source}\n`);
  }
}
