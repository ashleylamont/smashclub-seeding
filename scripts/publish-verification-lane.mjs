import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { stableVersionPattern } from './publication-policy.mjs';
import {
  compareAppVersionWithFirstParent,
  readCommittedAppVersion,
} from './publish-app-version.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout differs from the queued commit');

function assertStableAppVersion(version) {
  if (typeof version !== 'string' || !stableVersionPattern.test(version))
    throw new Error('Expected a MAJOR.MINOR.PATCH app version');
}

const appVersion = readCommittedAppVersion(sha);
assertStableAppVersion(appVersion);
const { firstParentVersion, versionChanged } = compareAppVersionWithFirstParent(sha, appVersion);
assertStableAppVersion(firstParentVersion);

const ordinaryLane = Number.parseInt(sha.at(-1), 16) % 2 === 0 ? 'ordinary' : 'ordinary-2';
const lane = versionChanged ? 'version' : ordinaryLane;
appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
