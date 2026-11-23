import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FEEDBACK_GITHUB_OWNER, FEEDBACK_GITHUB_REPO, feedbackIssueBody } from '@smashclub/shared';
import { z } from 'zod';
import type { Env } from './env';

const api = 'https://api.github.com';
const issues = `${api}/repos/${FEEDBACK_GITHUB_OWNER}/${FEEDBACK_GITHUB_REPO}/issues`;
const gitHubTimeoutMs = 4_500;
const clockSkewMs = 60_000;
const creationWindowMs = 2 * clockSkewMs;
const knownRejections = new Set([400, 401, 403, 404, 410, 422, 429]);
const issueNumber = z.number().int().positive().max(2_147_483_647);
const installationToken = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });
const appIdentity = z.object({ id: z.number().int().positive(), slug: z.string().min(1) });
const issueReceipt = z.object({ number: issueNumber });
const issueList = z.array(
  issueReceipt.extend({
    body: z.string().nullish(),
    created_at: z.string().optional(),
    pull_request: z.unknown().optional(),
    user: z.object({ login: z.string() }).nullish(),
  }),
);

type Report = {
  summary: string;
  description: string;
  version: string;
  build: string;
  marker: string;
};

type CreateResult =
  { status: 'created'; number: number } | { status: 'rejected' } | { status: 'unknown' };

export interface FeedbackPublisher {
  rateKey: string;
  create(report: Report): Promise<CreateResult>;
  find(marker: string, claimedAt: Date): Promise<number | undefined>;
}

function markerComment(marker: string) {
  return `<!-- nemesis-feedback:${marker} -->`;
}

function hasPublisherMarker(body: string, marker: string) {
  // The submitted description is fenced literal text. A report can quote
  // another report's marker, but only Nemesis writes a marker after the fence.
  const lines = body.split(/\r?\n/);
  const fence = lines[0];
  if (!fence || !/^~{3,}$/.test(fence)) return false;
  const closingFence = lines.indexOf(fence, 1);
  return closingFence !== -1 && lines.includes(markerComment(marker), closingFence + 1);
}

export async function configuredFeedbackPublisher(env: Env) {
  const appId = env.FEEDBACK_GITHUB_APP_ID;
  const installationId = env.FEEDBACK_GITHUB_INSTALLATION_ID;
  const keyFile = env.FEEDBACK_GITHUB_PRIVATE_KEY_FILE;
  if (!appId && !installationId && !keyFile) return undefined;
  if (!appId?.match(/^\d+$/) || !installationId?.match(/^\d+$/) || !keyFile) {
    throw new Error('Invalid feedback configuration');
  }
  return createGitHubFeedbackPublisher({
    appId,
    installationId,
    privateKey: await readFile(keyFile, 'utf8'),
  });
}

export function createGitHubFeedbackPublisher(
  settings: { appId: string; installationId: string; privateKey: string },
  request: typeof fetch = fetch,
): FeedbackPublisher {
  const key = createPrivateKey(settings.privateKey);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('GitHub App keys must be RSA');
  const rateKey = createHash('sha256')
    .update('nemesis-feedback:')
    .update(settings.privateKey)
    .digest('hex');
  let token: { value: string; expiresAt: number } | undefined;
  let pendingToken: Promise<string> | undefined;
  let botLogin: string | undefined;

  function send(url: string, bearer: string, body?: object) {
    return request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${bearer}`,
        'User-Agent': 'Nemesis-Feedback',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(gitHubTimeoutMs),
    });
  }

  function appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 300, iss: settings.appId }),
    ).toString('base64url');
    const signed = `${header}.${claims}`;
    return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`;
  }

  async function refreshToken() {
    const response = await send(
      `${api}/app/installations/${settings.installationId}/access_tokens`,
      appJwt(),
      {
        repositories: [FEEDBACK_GITHUB_REPO],
        permissions: { issues: 'write' },
      },
    );
    if (!response.ok) throw new Error('Could not authenticate the feedback app');
    const result = installationToken.parse(await response.json());
    token = { value: result.token, expiresAt: Date.parse(result.expires_at) };
    return token.value;
  }

  async function accessToken() {
    if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
    pendingToken ??= refreshToken().finally(() => {
      pendingToken = undefined;
    });
    return pendingToken;
  }

  async function appBotLogin() {
    if (botLogin) return botLogin;
    const response = await send(`${api}/app`, appJwt());
    if (!response.ok) throw new Error('Could not verify the feedback app identity');
    const app = appIdentity.parse(await response.json());
    if (String(app.id) !== settings.appId) throw new Error('Unexpected feedback app identity');
    botLogin = `${app.slug}[bot]`;
    return botLogin;
  }

  return {
    rateKey,
    async create(report) {
      let bearer: string;
      try {
        bearer = await accessToken();
      } catch {
        return { status: 'rejected' };
      }
      try {
        const body = `${feedbackIssueBody(report.description, report.version, report.build)}\n\n${markerComment(report.marker)}`;
        const response = await send(issues, bearer, { title: report.summary, body });
        if (response.status === 401 && token?.value === bearer) token = undefined;
        if (knownRejections.has(response.status)) return { status: 'rejected' };
        if (response.status !== 201) return { status: 'unknown' };
        return { status: 'created', number: issueReceipt.parse(await response.json()).number };
      } catch {
        // After dispatch, loss of the response gives no evidence that creation failed.
        return { status: 'unknown' };
      }
    },
    async find(marker, claimedAt) {
      try {
        const [creator, bearer] = await Promise.all([appBotLogin(), accessToken()]);
        const earliest = claimedAt.valueOf() - clockSkewMs;
        const latest = claimedAt.valueOf() + creationWindowMs;
        const url = new URL(issues);
        url.search = new URLSearchParams({
          state: 'all',
          sort: 'created',
          direction: 'asc',
          per_page: '100',
          since: new Date(earliest).toISOString(),
          creator,
        }).toString();
        const response = await send(url.href, bearer);
        if (response.status === 401 && token?.value === bearer) token = undefined;
        if (!response.ok) return undefined;
        return issueList.parse(await response.json()).find((issue) => {
          const creationTime = Date.parse(issue.created_at ?? '');
          return (
            !issue.pull_request &&
            issue.user?.login === creator &&
            creationTime >= earliest &&
            creationTime <= latest &&
            hasPublisherMarker(issue.body ?? '', marker)
          );
        })?.number;
      } catch {
        return undefined;
      }
    },
  };
}
