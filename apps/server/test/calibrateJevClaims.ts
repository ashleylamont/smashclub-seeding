import { loadEnv } from '../src/env';
import { clearsApprovalThreshold, scoreClaim } from '../src/players/claimReview';
import { jevClaimCases } from './fixtures/jevClaimCases';

const key = process.env.TYPESAFE_API_KEY?.trim();
if (!key)
  throw new Error('Set TYPESAFE_API_KEY in the local environment to run synthetic calibration.');

const env = loadEnv({ ...process.env, DATABASE_URL: 'postgres://unused' });
const results = [];
for (const fixture of jevClaimCases) {
  const review = await scoreClaim(key, fixture.state);
  const decision = clearsApprovalThreshold(review, env) ? 'approve' : 'manual';
  results.push({
    case: fixture.label,
    score: review.result === 'unavailable' ? null : review.score,
    confidence: review.result === 'unavailable' ? null : review.confidence,
    expected: fixture.autoApprove ? 'approve' : 'manual',
    observed: review.result === 'unavailable' ? 'unavailable' : decision,
  });
}
console.table(results);
if (results.some((result) => result.observed !== result.expected)) process.exitCode = 1;
