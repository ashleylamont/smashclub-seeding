import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FEEDBACK_GITHUB_OWNER, FEEDBACK_GITHUB_REPO, feedbackIssueBody } from '@smashclub/shared';
import { z } from 'zod';
import type { Env } from './env';

const api = 'https://api.github.com';
const issues = `${api}/repos/${FEEDBACK_GITHUB_OWNER}/${FEEDBACK_GITHUB_REPO}/issues`;
const gitHubTimeoutMs = 4_500;
const knownRejections = new Set([400, 401, 403, 404, 410, 422, 429]);
const issueNumber = z.number().int().positive().max(2_147_483_647);
const installationToken = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });
const issueReceipt = z.object({ number: issueNumber });
const issueList = z.array(
  issueReceipt.extend({ body: z.string().nullish(), pull_request: z.unknown().optional() }),
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

  async function refreshToken() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 300, iss: settings.appId }),
    ).toString('base64url');
    const signed = `${header}.${claims}`;
    const jwt = `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`;
    const response = await send(
      `${api}/app/installations/${settings.installationId}/access_tokens`,
      jwt,
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
        const url = new URL(issues);
        url.search = new URLSearchParams({
          state: 'all',
          sort: 'created',
          direction: 'asc',
          per_page: '100',
          since: new Date(claimedAt.valueOf() - 60_000).toISOString(),
        }).toString();
        const response = await send(url.href, await accessToken());
        if (!response.ok) return undefined;
        const line = markerComment(marker);
        const matches = issueList
          .parse(await response.json())
          .filter((issue) => !issue.pull_request && issue.body?.split(/\r?\n/).includes(line));
        // The marker becomes public with the original issue. A copied marker
        // can only appear later, so a newer match cannot replace the receipt.
        return matches.sort((left, right) => left.number - right.number)[0]?.number;
      } catch {
        return undefined;
      }
    },
  };
}
