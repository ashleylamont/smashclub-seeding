import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('Expected a MAJOR.MINOR.PATCH version');
}

const changelog = readFileSync(new URL('../apps/web/CHANGELOG.md', import.meta.url), 'utf8');
const section = changelog.split(/^## /m).find((section) => section.startsWith(`${version}\n`));
const notes = section?.slice(version.length).trim();
if (!notes) throw new Error(`Missing release notes for version ${version}`);
const publicScreenshots = `https://raw.githubusercontent.com/ashleylamont/smashclub-seeding/v${version}/apps/web/public/changelog/`;
process.stdout.write(`${notes.replaceAll('](./public/changelog/', `](${publicScreenshots}`)}\n`);
