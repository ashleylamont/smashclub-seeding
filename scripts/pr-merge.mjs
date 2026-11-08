import { execFileSync } from 'node:child_process';

export const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

export function readPrMerge(expectedHead) {
  if (!/^[a-f0-9]{40}$/.test(expectedHead))
    throw new Error('Expected the pull request head commit SHA');
  // The event's base can be older than the base GitHub used to build the tested merge.
  const [merge, base, head, ...extraParents] = git('rev-list', '--parents', '-n', '1', 'HEAD')
    .trim()
    .split(' ');
  if (!head || extraParents.length)
    throw new Error('Expected a two-parent pull request merge commit');
  if (head !== expectedHead)
    throw new Error('Checked-out merge does not match the expected pull request head');
  return { merge, base, head };
}

export function readPrChanges({ base, merge }) {
  // A move across scopes must include its old path, even when Git detects a rename.
  const fields = git('diff', '--no-renames', '--name-status', '-z', base, merge).split('\0');
  fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    changes.push([fields[index], fields[index + 1]]);
  }
  return changes;
}
