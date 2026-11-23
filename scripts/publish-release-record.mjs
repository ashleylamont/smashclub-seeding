import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stableVersionPattern } from './publication-policy.mjs';

const stableTag = (tag) =>
  typeof tag === 'string' && tag.startsWith('v') && stableVersionPattern.test(tag.slice(1));
const versionParts = (tag) => tag.slice(1).split('.').map(BigInt);

function isNewer(left, right) {
  const other = versionParts(right);
  for (const [index, part] of versionParts(left).entries()) {
    if (part !== other[index]) return part > other[index];
  }
  return false;
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', timeout: 30_000 });

export function publishReleaseRecord(repository, tag, notesFile, run = gh) {
  if (!stableTag(tag)) throw new Error('Expected a stable vMAJOR.MINOR.PATCH release tag');
  // A successful empty collection is the first release. Any API error must stop publication.
  const response = run(
    'api',
    '--paginate',
    '--jq',
    '.[] | {tag_name, draft, prerelease} | @json',
    `repos/${repository}/releases?per_page=100`,
  ).trim();
  const releases = response ? response.split('\n').map((row) => JSON.parse(row)) : [];
  if (
    releases.some(
      (release) =>
        typeof release?.tag_name !== 'string' ||
        typeof release.draft !== 'boolean' ||
        typeof release.prerelease !== 'boolean',
    )
  )
    throw new Error('Expected complete GitHub release metadata');
  if (releases.some((release) => release.tag_name === tag)) return;

  const newerRelease = releases.some(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      stableTag(release.tag_name) &&
      isNewer(release.tag_name, tag),
  );
  return run(
    'release',
    'create',
    tag,
    '--repo',
    repository,
    '--verify-tag',
    `--latest=${!newerRelease}`,
    '--title',
    `Nemesis ${tag.slice(1)}`,
    '--notes-file',
    notesFile,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [tag, notes] = process.argv.slice(2);
  const result = publishReleaseRecord(process.env.GITHUB_REPOSITORY, tag, notes);
  if (result) process.stdout.write(result);
}
