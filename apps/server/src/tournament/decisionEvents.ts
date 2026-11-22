import { z } from 'zod';

const numberedVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
type DecisionVersion = (typeof numberedVersions)[number];

function numberedDecisionName<Version extends DecisionVersion>(
  version: Version,
): `DecisionRecordedV${Version}` {
  return `DecisionRecordedV${version}`;
}

export const decisionVersionSchema = z.union(numberedVersions.map((version) => z.literal(version)));

export const decisionEventNames = [
  ...numberedVersions.map(numberedDecisionName),
  'ResultsSealedV1',
  'PlanRetiredV1',
] as const;
const knownDecisionEvents = new Set<string>(decisionEventNames);

export function isDecisionEvent(name: string) {
  return knownDecisionEvents.has(name);
}
