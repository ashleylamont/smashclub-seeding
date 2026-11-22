import { z } from 'zod';
import type { Decision, TournamentDecision, TournamentState } from './schemas';

const numberedVersions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
type DecisionVersion = (typeof numberedVersions)[number];
type NumberedDecisionName<Version extends DecisionVersion> = `DecisionRecordedV${Version}`;

function numberedDecisionName<Version extends DecisionVersion>(
  version: Version,
): NumberedDecisionName<Version> {
  return `DecisionRecordedV${version}`;
}

// Raw readers accept every known payload version. Act validates the literal
// corresponding to each numbered event name.
export const decisionVersionSchema = z.union(numberedVersions.map((version) => z.literal(version)));

const specialDecisionNames = ['ResultsSealedV1', 'PlanRetiredV1'] as const;
export const decisionEventNames = [
  ...numberedVersions.map(numberedDecisionName),
  ...specialDecisionNames,
] as const;
const knownDecisionEvents = new Set<string>(decisionEventNames);

export function isDecisionEvent(name: string) {
  return knownDecisionEvents.has(name);
}

function numberedDecisionSchema<Version extends DecisionVersion>(
  schema: typeof Decision,
  version: Version,
) {
  return schema.extend({ version: z.literal(version) });
}

type DecisionEventSchemas = {
  [Version in DecisionVersion as NumberedDecisionName<Version>]: ReturnType<
    typeof numberedDecisionSchema<Version>
  >;
} & Record<(typeof specialDecisionNames)[number], typeof Decision>;

type DecisionFrame = { current: [TournamentState] };

export function actDecisionEvents(
  schema: typeof Decision,
  reduce: (state: TournamentState, decision: TournamentDecision) => TournamentState,
) {
  // Each numbered key and schema literal are made from the same version.
  const schemas = Object.fromEntries([
    ...numberedVersions.map((version) => [
      numberedDecisionName(version),
      numberedDecisionSchema(schema, version),
    ]),
    ...specialDecisionNames.map((name) => [name, schema]),
  ]) as DecisionEventSchemas;

  function patchDecision(
    { data }: { data: TournamentDecision },
    { current }: DecisionFrame,
  ): DecisionFrame {
    return { current: [reduce(current[0], data)] };
  }

  const patches = Object.fromEntries(
    decisionEventNames.map((name) => [name, patchDecision]),
  ) as Record<(typeof decisionEventNames)[number], typeof patchDecision>;

  return { schemas, patches };
}

type NumberedDecisionEmission = {
  [Version in DecisionVersion]: [
    NumberedDecisionName<Version>,
    TournamentDecision & { version: Version },
  ];
}[DecisionVersion];

export function emitNumberedDecision(decision: TournamentDecision): NumberedDecisionEmission {
  // Act expects the name and payload version as a correlated tuple.
  return [numberedDecisionName(decision.version), { ...decision }] as NumberedDecisionEmission;
}
