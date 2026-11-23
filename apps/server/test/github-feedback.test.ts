import { createVerify, generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createGitHubFeedbackPublisher } from '../src/githubFeedback';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const settings = {
  appId: '12345',
  installationId: '54321',
  privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const base = 'https://api.github.com';
const repo = '/repos/ashleylamont/smashclub-seeding/issues';
const auth = '/app/installations/54321/access_tokens';
const form = {
  summary: 'Synthetic reproduction',
  description: '@example\n~~~~\n![external example](https://example.test/fixture.png)',
  version: '1.2.3',
  build: '1a2b3c4',
  marker: '11111111-1111-4111-8111-111111111111',
};

function installationToken() {
  return Response.json({
    token: 'synthetic-installation-token',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
}

it('authenticates the app and publishes only the reviewed text and build to the fixed repository', async () => {
  const upstream = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(installationToken())
    .mockResolvedValueOnce(Response.json({ number: 123 }, { status: 201 }));
  const publisher = createGitHubFeedbackPublisher(settings, upstream);
  expect(await publisher.create(form)).toEqual({ status: 'created', number: 123 });
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([base + auth, base + repo]);
  const [, tokenRequest] = upstream.mock.calls[0]!;
  const jwt = new Headers(tokenRequest?.headers).get('Authorization')!.slice(7);
  const [header, claims, signature] = jwt.split('.');
  expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
    alg: 'RS256',
    typ: 'JWT',
  });
  expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
    iss: settings.appId,
  });
  expect(
    createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(key.publicKey, signature!, 'base64url'),
  ).toBe(true);
  expect(JSON.parse(String(tokenRequest?.body))).toEqual({
    repositories: ['smashclub-seeding'],
    permissions: { issues: 'write' },
  });
  const [, createRequest] = upstream.mock.calls[1]!;
  const headers = new Headers(createRequest?.headers);
  expect(headers.get('Authorization')).toBe('Bearer synthetic-installation-token');
  expect(headers.get('Cookie')).toBeNull();
  expect(createRequest?.redirect).toBe('error');
  expect(JSON.parse(String(createRequest?.body))).toEqual({
    title: form.summary,
    body: `~~~~~\n${form.description}\n~~~~~\n\nNemesis v1.2.3 · build 1a2b3c4\n\n<!-- nemesis-feedback:${form.marker} -->`,
  });
});

it('reconciles the exact marker without sending a second POST after a connection loss', async () => {
  const upstream = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(installationToken())
    .mockRejectedValueOnce(new TypeError('fake transport error'))
    .mockResolvedValueOnce(
      Response.json([
        { number: 19, pull_request: {}, body: `<!-- nemesis-feedback:${form.marker} -->` },
        { number: 20, body: 'Unrelated report' },
        { number: 124, body: `A copied marker\n\n<!-- nemesis-feedback:${form.marker} -->` },
        {
          number: 123,
          body: `Issue body\n\n<!-- nemesis-feedback:${form.marker} -->\n\nMaintainer note`,
        },
      ]),
    );
  const publisher = createGitHubFeedbackPublisher(settings, upstream);
  expect(await publisher.create(form)).toEqual({ status: 'unknown' });
  expect(await publisher.find(form.marker, new Date('2026-11-23T00:01:00Z'))).toBe(123);
  expect(upstream).toHaveBeenCalledTimes(3);
  const [lookup, init] = upstream.mock.calls[2]!;
  expect(new URL(String(lookup)).pathname).toBe(repo);
  expect(new URL(String(lookup)).searchParams.get('state')).toBe('all');
  expect(init?.method).toBe('GET');
});

it.each([
  [403, 'rejected'],
  [429, 'rejected'],
  [502, 'unknown'],
])('classifies GitHub HTTP %i without leaking its body', async (code, status) => {
  const upstream = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(installationToken())
    .mockResolvedValueOnce(new Response('synthetic detail to keep private', { status: code }));
  expect(await createGitHubFeedbackPublisher(settings, upstream).create(form)).toEqual({ status });
});
