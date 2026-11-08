import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const appPackage = 'apps/web/package.json';
const changelog = 'apps/web/CHANGELOG.md';
const notePath = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertAppChangeset(changes, read) {
  const validNote = (source) => {
    const match = /^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
    if (!match?.[2].trim()) return false;
    const bumps = parse(match[1]);
    return (
      bumps &&
      Object.keys(bumps).length === 1 &&
      ['patch', 'minor', 'major'].includes(bumps['@smashclub/web'])
    );
  };
  const additions = changes.filter(([status, path]) => status === 'A' && notePath.test(path));
  if (additions.length) {
    for (const [, path] of additions) {
      if (!validNote(read('HEAD', path))) throw new Error(`Invalid Nemesis Changeset in ${path}`);
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
    consumed.every(([, path]) => validNote(read('base', path)))
  ) {
    const oldVersion = JSON.parse(read('base', appPackage)).version;
    const newVersion = JSON.parse(read('HEAD', appPackage)).version;
    if (versionPattern.test(oldVersion) && versionPattern.test(newVersion)) {
      const previous = oldVersion.split('.').map(Number);
      const next = newVersion.split('.').map(Number);
      const firstChange = next.findIndex((number, index) => number !== previous[index]);
      const heading = /^## (.+)$/m.exec(read('HEAD', changelog))?.[1];
      if (firstChange !== -1 && next[firstChange] > previous[firstChange] && heading === newVersion)
        return;
    }
  }

  throw new Error(
    'Add a new @smashclub/web Changeset, or version existing notes in a release-only PR.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Expected the pull request base commit SHA');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const fields = git('diff', '--no-renames', '--name-status', '-z', base, 'HEAD').split('\0');
  fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    changes.push([fields[index], fields[index + 1]]);
  }
  assertAppChangeset(changes, (revision, path) =>
    git('show', `${revision === 'base' ? base : revision}:${path}`),
  );
}
