import { readFileSync } from 'node:fs';
import { readChangelog } from '../apps/web/src/lib/changelog.mjs';

const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('Expected a MAJOR.MINOR.PATCH version');
}

const changelog = readFileSync(new URL('../apps/web/CHANGELOG.md', import.meta.url), 'utf8');
const release = readChangelog(changelog).releases.find((entry) => entry.version === version);
if (!release?.notes) throw new Error(`Missing release notes for version ${version}`);

const { highlights, notes } = release;
const body = highlights
  ? `${highlights}\n\n<details>\n<summary>Full release notes</summary>\n\n${notes}\n\n</details>`
  : notes;
const publicScreenshots = `https://raw.githubusercontent.com/ashleylamont/smashclub-seeding/v${version}/apps/web/public/changelog/`;
process.stdout.write(`${body.replaceAll('](./public/changelog/', `](${publicScreenshots}`)}\n`);
