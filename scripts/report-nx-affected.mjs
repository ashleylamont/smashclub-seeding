import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readPrMerge } from './pr-merge.mjs';

const { base, merge } = readPrMerge(process.argv[2]);
const { affected } = JSON.parse(
  execFileSync(
    'pnpm',
    [
      'exec',
      'nx',
      'affected',
      '-t',
      'typecheck',
      'test',
      '--explain=stdout',
      '--base',
      base,
      '--head',
      merge,
    ],
    { encoding: 'utf8', env: { ...process.env, NX_DAEMON: 'false' }, timeout: 30_000 },
  ),
);
const tasks = Object.keys(affected).sort();
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  [
    '### Nx task preview',
    '',
    'Nx compares the tested merge commit with its first parent. This preview does not select required jobs.',
    '',
    ...(tasks.length ? tasks.map((task) => `- \`${task}\``) : ['No affected Nx tasks.']),
    '',
  ].join('\n'),
);
