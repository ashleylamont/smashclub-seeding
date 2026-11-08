import { execFileSync } from 'node:child_process';
import standard from '@changesets/cli/changelog';

const root = new URL('../', import.meta.url);
const repo = 'https://github.com/ashleylamont/smashclub-seeding';
const defaultKind = { major: 'Milestone', minor: 'Feature', patch: 'Fix' };
const annotated = /^\*\*(?:Milestone|Feature|Improvement|Fix|Maintenance)\*\* · /;
const dateFormat = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'long',
  timeZone: 'Australia/Sydney',
});

export function getReleaseLine({ id, summary }, bump) {
  const entry = execFileSync(
    'git',
    [
      'log',
      '-1',
      '--no-patch',
      '--first-parent',
      '--diff-merges=first-parent',
      '--diff-filter=A',
      '--format=%H%x09%cI%x09%s',
      'origin/main',
      '--',
      `.changeset/${id}.md`,
    ],
    { encoding: 'utf8', cwd: root },
  ).trim();
  if (!entry)
    throw new Error(`Fetch origin/main and merge the Changeset ${id} before cutting a release.`);

  const [sha, timestamp, subject] = entry.split('\t');
  const date = dateFormat.format(new Date(timestamp));
  const pull = /^Merge pull request #(\d+)\b/.exec(subject);
  const build = `[build ${sha.slice(0, 7)}](${repo}/commit/${sha})`;
  const links = pull ? `[#${pull[1]}](${repo}/pull/${pull[1]}) · ${build}` : build;
  const body = annotated.test(summary) ? summary : `**${defaultKind[bump]}** · ${summary}`;
  const [firstLine, ...rest] = body.trim().split('\n');
  return [
    `- ${date} · ${firstLine} ${links}`,
    ...rest.map((line) => (line ? `  ${line}` : '')),
  ].join('\n');
}

export const getDependencyReleaseLine = standard.getDependencyReleaseLine;
