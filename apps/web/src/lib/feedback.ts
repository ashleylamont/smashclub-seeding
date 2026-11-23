import { FEEDBACK_ISSUES_URL, PUBLIC_FEEDBACK_PATH, feedbackIssueBody } from '@smashclub/shared';
import { APP_VERSION, BUILD_LABEL } from './build';

export const githubIssueUrl = `${FEEDBACK_ISSUES_URL}/new`;
export const buildContext = `v${APP_VERSION} · build ${BUILD_LABEL}`;

type Draft = { summary: string; description: string };
export type FeedbackFailure =
  'busy' | 'conflict' | 'rejected' | 'unavailable' | 'unknown' | 'unresolved';

export function githubFeedbackDraft(draft?: Draft) {
  const url = new URL(githubIssueUrl);
  if (draft) {
    url.searchParams.set('title', draft.summary);
    url.searchParams.set('body', feedbackIssueBody(draft.description, APP_VERSION, BUILD_LABEL));
    // Keep the manual path usable for long Unicode reports. The reviewed text
    // also remains visible in Nemesis for copying by hand.
    if (url.href.length <= 6000) return { href: url.href, includesDraft: true };
    url.search = '';
  }
  url.searchParams.set('body', `Nemesis ${buildContext}`);
  return { href: url.href, includesDraft: false };
}

function feedbackFetch(init?: RequestInit) {
  return fetch(PUBLIC_FEEDBACK_PATH, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    ...init,
  });
}

export async function publicFeedbackAvailable() {
  const response = await feedbackFetch();
  if (!response.ok) return false;
  const body: { available?: unknown } = await response.json();
  return body.available === true;
}

export async function sendFeedback(
  requestId: string,
  draft: Draft,
): Promise<number | FeedbackFailure> {
  const response = await feedbackFetch({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      publicConsent: true,
      ...draft,
      version: APP_VERSION,
      build: BUILD_LABEL,
    }),
  });
  const body: { number?: unknown; state?: unknown } | null = await response
    .json()
    .catch(() => null);
  if (
    (response.status === 200 || response.status === 201) &&
    typeof body?.number === 'number' &&
    Number.isSafeInteger(body.number) &&
    body.number > 0
  )
    return body.number;
  if (response.status === 202 && body?.state === 'unresolved') return 'unresolved';
  if (response.status === 429 && body?.state === 'busy') return 'busy';
  if (response.status === 409 && body?.state === 'conflict') return 'conflict';
  if (response.status === 503 && (body?.state === 'rejected' || body?.state === 'unavailable')) {
    return body.state;
  }
  return 'unknown';
}
