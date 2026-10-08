import assert from 'node:assert/strict';

const origin = 'http://127.0.0.1:3000';
const health = await fetch(`${origin}/healthz`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true });
const authOptions = await fetch(`${origin}/api/auth-options`);
assert.equal(authOptions.status, 200);
assert.deepEqual(await authOptions.json(), { credentials: false, providers: [] });
const home = await fetch(origin);
assert.match(home.headers.get('content-type'), /text\/html/);
const html = await home.text();
assert.match(html, /id="root"/);
for (const route of ['/live/synthetic', '/admin/event-operations']) {
  const response = await fetch(`${origin}${route}`);
  assert.equal(await response.text(), html, 'SPA deep link must serve the built frontend');
}
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map((match) => match[1]);
assert(assets.some((asset) => asset.endsWith('.js')));
assert(assets.some((asset) => asset.endsWith('.css')));
for (const asset of assets) {
  const response = await fetch(`${origin}${asset}`);
  assert.equal(response.status, 200);
  assert.doesNotMatch(
    await response.text(),
    /<!doctype html>/i,
    'Asset must not silently use the SPA fallback',
  );
}
const input = encodeURIComponent(JSON.stringify({ query: 'Synthetic' }));
const search = await fetch(`${origin}/api/trpc/public.searchPlayers?input=${input}`);
assert.equal(search.status, 200);
const players = (await search.json()).result.data;
assert(
  players.some((player) => player.name === 'Synthetic public alias'),
  'Upgraded identity must persist through API',
);
assert(
  !JSON.stringify(players).includes('Synthetic private identity'),
  'Public response must not expose canonical identity',
);
assert.equal((await fetch(`${origin}/api/trpc/admin.eventPlanner.plans`)).status, 401);
assert.equal((await fetch(`${origin}/api/does-not-exist`)).status, 404);
assert.equal(await (await fetch(`${origin}/api/auth/get-session`)).json(), null);
assert.equal(process.env.NODE_ENV, 'production');
console.log('Runtime probe passed');
