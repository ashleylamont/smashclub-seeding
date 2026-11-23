import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { assertReleaseTag, publicationPolicy } from './publication-policy.mjs';
import {
  compareAppVersionWithFirstParent,
  readCommittedAppVersion,
  readCheckedOutAppVersion,
} from './publish-app-version.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const trigger = git(['rev-parse', 'HEAD']);
if (trigger !== process.env.GITHUB_SHA)
  throw new Error('Checkout differs from the verified commit');
const sha = process.env.VERIFIED_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Expected an exact verified build SHA');
const numberedSnapshot = sha !== trigger;
const approvedSource = process.env.NUMBERED_RELEASE_SHA === sha;
if (numberedSnapshot && (!approvedSource || git(['rev-parse', 'HEAD^2']) !== sha))
  throw new Error('The verified snapshot differs from the resolved release source');
git(['fetch', 'origin', 'main']);
let onMain = false;
try {
  git(['merge-base', '--is-ancestor', sha, 'origin/main']);
  onMain = true;
} catch {
  /* policy rejects */
}

const appVersion = numberedSnapshot ? readCommittedAppVersion(sha) : readCheckedOutAppVersion();
const event = process.env.GITHUB_EVENT_NAME;
const ref = process.env.GITHUB_REF;
const versionChanged =
  event === 'push' &&
  ref === 'refs/heads/main' &&
  approvedSource &&
  compareAppVersionWithFirstParent('HEAD', appVersion).versionChanged;
const policy = publicationPolicy({
  event,
  ref,
  sha,
  appVersion,
  versionChanged,
  numberedSnapshot,
  onMain,
  mainSha: git(['rev-parse', 'origin/main']),
});

if (policy.releaseVersion) {
  const tag = `refs/tags/v${policy.releaseVersion}`;
  const peeled = `${tag}^{}`;
  const refs = new Map(
    git(['ls-remote', 'origin', tag, peeled])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit, refName] = line.split('\t');
        return [refName, commit];
      }),
  );
  const existing = refs.get(peeled) ?? refs.get(tag);
  if (ref.startsWith('refs/tags/') && !existing) throw new Error(`Missing release tag ${tag}`);
  assertReleaseTag(tag, sha, existing);
}

const image = 'ghcr.io/ashleylamont/smashclub-seeding';
const tags = [`${image}:sha-${sha}`, ...policy.tags.map((tag) => `${image}:${tag}`)];
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `tags<<END_TAGS\n${tags.join('\n')}\nEND_TAGS\nversion=${policy.releaseVersion ?? ''}\nsource_sha=${sha}\n`,
);
