/** A main push, a version tag on main's history, or a manual main rebuild. */
export function publicationPolicy({ event, ref, sha, mainSha, onMain }) {
  if (!['push', 'workflow_dispatch'].includes(event))
    throw new Error('Unsupported publication event');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Publication requires a full commit SHA');
  if (!onMain) throw new Error('Only commits on main may be published');
  if (event === 'workflow_dispatch' && ref !== 'refs/heads/main')
    throw new Error('Manual publication must select main');
  if (ref === 'refs/heads/main') return { sha, tags: mainSha === sha ? ['main'] : [] };
  const version = /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(ref);
  if (event !== 'push' || !version)
    throw new Error('Expected a main push or a vMAJOR.MINOR.PATCH release tag');
  // Immutable full versions only: older release workflows cannot overwrite major/minor aliases.
  return { sha, tags: [`${version[1]}.${version[2]}.${version[3]}`] };
}
