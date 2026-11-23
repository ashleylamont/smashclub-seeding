export const FEEDBACK_PATH = '/api/feedback';
export const FEEDBACK_SUMMARY_MAX = 120;
export const FEEDBACK_DESCRIPTION_MAX = 4000;
export const PUBLIC_FEEDBACK_PATH = `${FEEDBACK_PATH}/public`;
export const FEEDBACK_GITHUB_OWNER = 'ashleylamont';
export const FEEDBACK_GITHUB_REPO = 'smashclub-seeding';
export const FEEDBACK_ISSUES_URL = `https://github.com/${FEEDBACK_GITHUB_OWNER}/${FEEDBACK_GITHUB_REPO}/issues`;

export function feedbackIssueBody(description: string, version: string, build: string) {
  // Treat a reporter's input as literal text. In particular, mentions, images,
  // and commands in a report must not become active GitHub Markdown.
  const longestFence = Math.max(
    2,
    ...Array.from(description.matchAll(/~+/g), ([match]) => match.length),
  );
  const fence = '~'.repeat(longestFence + 1);
  return `${fence}\n${description}\n${fence}\n\nNemesis v${version} · build ${build}`;
}
