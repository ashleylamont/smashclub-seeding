import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { publicationPolicy } from './publication-policy.mjs';
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
const policy = publicationPolicy({
  event: process.env.GITHUB_EVENT_NAME,
  ref: process.env.GITHUB_REF,
  sha,
  mainSha: git(['rev-parse', 'origin/main']),
  onMain,
});
const image = 'ghcr.io/ashleylamont/smashclub-seeding';
const tags = [`${image}:sha-${sha}`, ...policy.tags.map((tag) => `${image}:${tag}`)];
appendFileSync(process.env.GITHUB_OUTPUT, `tags<<END_TAGS\n${tags.join('\n')}\nEND_TAGS\n`);
