export const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A main push, a version tag on main's history, or a manual main rebuild. */
export function publicationPolicy({
  event,
  ref,
  sha,
  mainSha,
  onMain,
  appVersion,
  versionChanged,
}) {
  if (!['push', 'workflow_dispatch'].includes(event))
    throw new Error('Unsupported publication event');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Publication requires a full commit SHA');
  if (!onMain) throw new Error('Only commits on main may be published');
  if (event === 'workflow_dispatch' && ref !== 'refs/heads/main')
    throw new Error('Manual publication must select main');
  if (ref === 'refs/heads/main') {
    const tags = mainSha === sha ? ['main'] : [];
    if (event !== 'push' || !versionChanged) return { sha, tags };
    if (!stableVersionPattern.test(appVersion))
      throw new Error('Expected a MAJOR.MINOR.PATCH app version');
    return { sha, tags: [...tags, appVersion], releaseVersion: appVersion };
  }

  const version = ref.startsWith('refs/tags/v') ? ref.slice('refs/tags/v'.length) : '';
  if (event !== 'push' || !stableVersionPattern.test(version))
    throw new Error('Expected a main push or a vMAJOR.MINOR.PATCH release tag');
  if (version !== appVersion)
    throw new Error(`Expected release tag v${appVersion} to match the app version`);
  return { sha, tags: [version], releaseVersion: version };
}

export function assertReleaseTag(tag, expectedSha, existingSha) {
  if (existingSha && existingSha !== expectedSha) {
    throw new Error(`Release tag ${tag} already points to ${existingSha}`);
  }
}
