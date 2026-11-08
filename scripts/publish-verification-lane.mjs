import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { stableVersionPattern } from './publication-policy.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout differs from the queued commit');

function versionAt(commit) {
  const { version } = JSON.parse(git('show', `${commit}:apps/web/package.json`));
  if (typeof version !== 'string' || !stableVersionPattern.test(version))
    throw new Error('Expected a MAJOR.MINOR.PATCH app version');
  return version;
}

const ordinaryLane = Number.parseInt(sha.at(-1), 16) % 2 === 0 ? 'ordinary' : 'ordinary-2';
const lane = versionAt(sha) === versionAt(`${sha}^1`) ? ordinaryLane : 'version';
appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
