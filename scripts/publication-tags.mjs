import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { assertReleaseTag, publicationPolicy } from './publication-policy.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git(['rev-parse', 'HEAD']);
if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout differs from the verified commit');
git(['fetch', 'origin', 'main']);
let onMain = false;
try {
  git(['merge-base', '--is-ancestor', sha, 'origin/main']);
  onMain = true;
} catch {
  /* policy rejects */
}

const appPackage = 'apps/web/package.json';
const appVersion = JSON.parse(
  readFileSync(new URL(`../${appPackage}`, import.meta.url), 'utf8'),
).version;
const event = process.env.GITHUB_EVENT_NAME;
const ref = process.env.GITHUB_REF;
const versionChanged =
  event === 'push' &&
  ref === 'refs/heads/main' &&
  JSON.parse(git(['show', `HEAD^1:${appPackage}`])).version !== appVersion;
const policy = publicationPolicy({
  event,
  ref,
  sha,
  appVersion,
  versionChanged,
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
  `tags<<END_TAGS\n${tags.join('\n')}\nEND_TAGS\nversion=${policy.releaseVersion ?? ''}\n`,
);
