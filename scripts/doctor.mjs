import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const expectedNode = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const current = process.versions.node.split('.').map(Number);
const minimum = expectedNode.split('.').map(Number);
const supported =
  current[0] > minimum[0] ||
  (current[0] === minimum[0] &&
    (current[1] > minimum[1] || (current[1] === minimum[1] && current[2] >= minimum[2])));
let ready = supported;
console.log(
  `${supported ? 'OK' : 'FIX'} Node ${process.versions.node}; minimum ${expectedNode} (fnm install && fnm use)`,
);

function probe(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pnpm = probe('pnpm', ['--version']);
const pnpmReady = pnpm === manifest.packageManager.split('@')[1];
ready &&= pnpmReady;
console.log(
  `${pnpmReady ? 'OK' : 'FIX'} pnpm ${pnpm ?? 'missing'}; expected ${manifest.packageManager}`,
);

try {
  const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { chromium } = requireWeb('@playwright/test');
  console.log('OK Workspace dependencies installed');
  const browserReady = existsSync(chromium.executablePath());
  console.log(
    `${browserReady ? 'OK' : 'OPTIONAL'} Chromium ${browserReady ? 'installed' : 'missing; run pnpm --filter @smashclub/web exec playwright install chromium'}`,
  );
} catch {
  ready = false;
  console.log('FIX Dependencies missing; run pnpm install --frozen-lockfile');
}

const postgres = probe('initdb', ['--version']);
const postgresReady = /PostgreSQL\) 17\./.test(postgres ?? '') && probe('pg_ctl', ['--version']);
console.log(
  `${postgresReady ? 'OK' : 'OPTIONAL'} PostgreSQL 17 ${postgresReady ? 'available for pnpm test:postgres' : 'not available; install version 17 or use POSTGRES_TEST_CONTAINER=1 with Docker'}`,
);
const docker = probe('docker', ['info', '--format', '{{.ServerVersion}}']);
console.log(
  `${docker ? 'OK' : 'OPTIONAL'} Docker ${docker ?? 'not running; start Docker for pnpm test:image'}`,
);
console.log('Local rehearsal uses PGlite; PostgreSQL, Docker and OAuth are optional.');
process.exitCode = ready ? 0 : 1;
