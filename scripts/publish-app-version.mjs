import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const appManifest = 'apps/web/package.json';

export function readCommittedAppVersion(commit) {
  const manifest = execFileSync('git', ['show', `${commit}:${appManifest}`], {
    encoding: 'utf8',
  });
  return JSON.parse(manifest.trim()).version;
}

export function readCheckedOutAppVersion() {
  return JSON.parse(readFileSync(new URL(`../${appManifest}`, import.meta.url), 'utf8')).version;
}

export function compareAppVersionWithFirstParent(commit, appVersion) {
  const firstParentVersion = readCommittedAppVersion(`${commit}^1`);
  return { firstParentVersion, versionChanged: firstParentVersion !== appVersion };
}
