import { readFileSync } from 'node:fs';
import { assertAppChangeset } from './check-changeset.mjs';
import { git } from './pr-merge.mjs';

// Public GitHub account ID for nemesis-release-bot[bot].
const releaseAppId = 353923899;
const changelog = 'apps/web/CHANGELOG.md';

export function isVersionAppPr(event, { actorId, repositoryId, head }) {
  const pr = event?.pull_request;
  const repoId = Number(repositoryId);
  return (
    actorId === String(releaseAppId) &&
    event?.sender?.id === releaseAppId &&
    ['opened', 'synchronize'].includes(event?.action) &&
    pr?.user?.id === releaseAppId &&
    Number.isSafeInteger(repoId) &&
    repoId > 0 &&
    event?.repository?.id === repoId &&
    pr?.head?.repo?.id === repoId &&
    pr?.base?.repo?.id === repoId &&
    pr?.head?.ref === 'changeset-release/main' &&
    pr?.head?.sha === head &&
    pr?.base?.ref === 'main'
  );
}

export function hasGeneratedReleaseDiff(changes, read) {
  try {
    const version = assertAppChangeset(changes, read, { releaseOnly: true });
    const before = read('base', changelog);
    const after = read('HEAD', changelog);
    const historyStart = before.search(/^## /m);
    if (historyStart < 0) return false;
    const history = before.slice(historyStart);
    const release = after.slice(historyStart, after.length - history.length);
    return (
      after.startsWith(before.slice(0, historyStart)) &&
      after.endsWith(history) &&
      release.startsWith(`## ${version}\n`) &&
      release.match(/^## /gm)?.length === 1 &&
      /^- /m.test(release)
    );
  } catch {
    return false;
  }
}

export function shouldDeferVersionBrowser({ merge, base, head }, changes, env = process.env) {
  if (
    env.GITHUB_EVENT_NAME !== 'pull_request' ||
    env.CI_REPORT_ONLY === 'true' ||
    env.GITHUB_ACTOR_ID !== String(releaseAppId) ||
    !env.GITHUB_EVENT_PATH
  )
    return false;

  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return false;
  }
  if (
    !isVersionAppPr(event, {
      actorId: env.GITHUB_ACTOR_ID,
      repositoryId: env.GITHUB_REPOSITORY_ID,
      head,
    })
  )
    return false;

  // The event's base SHA can be stale. Require the generated commit to sit
  // directly on the base GitHub used for this merge, with an identical tree.
  if (git('show', '-s', '--format=%P', head).trim() !== base) return false;
  const [mergeTree, headTree] = git('rev-parse', `${merge}^{tree}`, `${head}^{tree}`)
    .trim()
    .split('\n');
  return (
    mergeTree === headTree &&
    hasGeneratedReleaseDiff(changes, (revision, path) =>
      git('show', `${revision === 'base' ? base : merge}:${path}`),
    )
  );
}
