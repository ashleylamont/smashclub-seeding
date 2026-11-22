import { FEEDBACK_PATH } from '@smashclub/shared';
import { APP_VERSION, BUILD_LABEL } from './build';

export const githubIssueUrl = 'https://github.com/ashleylamont/smashclub-seeding/issues/new';

export async function sendFeedback(requestId: string, summary: string, description: string) {
  const response = await fetch(FEEDBACK_PATH, {
    method: 'POST',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId,
      summary,
      description,
      version: APP_VERSION,
      build: BUILD_LABEL,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) return 'busy';
  if (response.status === 409) return 'conflict';
  if (!response.ok) return 'failed';
  const receipt: { reference?: unknown } = await response.json();
  if (typeof receipt.reference !== 'string' || !receipt.reference) return 'failed';
  return { reference: receipt.reference };
}
