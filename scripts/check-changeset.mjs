import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { git, readPrMerge } from './pr-merge.mjs';

const appPackage = 'apps/web/package.json';
const changelog = 'apps/web/CHANGELOG.md';
const notePath = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const bumpsByPart = ['major', 'minor', 'patch'];

function noteBump(source) {
  const match = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match?.[2].trim()) return;
  const bumps = parse(match[1]);
  if (bumps && Object.keys(bumps).length === 1 && bumpsByPart.includes(bumps['@smashclub/web']))
    return bumps['@smashclub/web'];
}

export function assertAppChangeset(changes, read, { releaseOnly = false } = {}) {
  const editsPackage = changes.some(([status, path]) => status === 'M' && path === appPackage);
  const before = editsPackage ? JSON.parse(read('base', appPackage)) : {};
  const after = editsPackage ? JSON.parse(read('HEAD', appPackage)) : {};
  const { version: oldVersion, ...oldPackage } = before;
  const { version: newVersion, ...newPackage } = after;

  const additions = changes.filter(([status, path]) => status === 'A' && notePath.test(path));
  if (additions.length && !releaseOnly && oldVersion === newVersion) {
    for (const [, path] of additions) {
      if (!noteBump(read('HEAD', path))) throw new Error(`Invalid Nemesis Changeset in ${path}`);
    }
    return;
  }

  const consumed = changes.filter(([status, path]) => status === 'D' && notePath.test(path));
  const releaseFiles = changes.every(
    ([status, path]) =>
      (status === 'D' && notePath.test(path)) ||
      (status === 'M' && (path === appPackage || path === changelog)),
  );
  const versioned = [appPackage, changelog].every((file) =>
    changes.some(([status, path]) => status === 'M' && path === file),
  );
  if (
    consumed.length &&
    releaseFiles &&
    versioned &&
    JSON.stringify(oldPackage) === JSON.stringify(newPackage) &&
    versionPattern.test(oldVersion) &&
    versionPattern.test(newVersion)
  ) {
    const bumps = consumed.map(([, path]) => noteBump(read('base', path)));
    if (bumps.every(Boolean)) {
      const bumpPart = bumpsByPart.findIndex((bump) => bumps.includes(bump));
      const parts = oldVersion.split('.');
      parts[bumpPart] = String(BigInt(parts[bumpPart]) + 1n);
      parts.fill('0', bumpPart + 1);
      const expectedVersion = parts.join('.');
      if (newVersion !== expectedVersion)
        throw new Error(
          `Consumed Changesets require Nemesis ${expectedVersion}, got ${newVersion}.`,
        );
      const heading = /^## (.+)$/m.exec(read('HEAD', changelog))?.[1];
      if (heading === newVersion) return;
    }
  }

  throw new Error(
    'Add a new @smashclub/web Changeset, or version existing notes in a release-only PR.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { merge, base } = readPrMerge(process.argv[2]);
  const fields = git('diff', '--no-renames', '--name-status', '-z', base, merge).split('\0');
  fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    changes.push([fields[index], fields[index + 1]]);
  }
  assertAppChangeset(
    changes,
    (revision, path) => git('show', `${revision === 'base' ? base : merge}:${path}`),
    { releaseOnly: process.env.GITHUB_HEAD_REF === 'changeset-release/main' },
  );
}
