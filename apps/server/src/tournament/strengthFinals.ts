import { DISPLAY_CENTRE, NATURAL_TO_DISPLAY } from '@smashclub/engine';
import {
  FINALS_POOL_PLACE_COST,
  poolRematchRounds,
  seedFinalistsByStrength,
  seedPoolFinishers,
  selectFormatFinalists,
  type ConsolationBracket,
} from '@smashclub/tournament-formats';
import { defaultRatingSettings, finalsRoles } from '@smashclub/shared';
import { hash, requireFact } from './facts';
import { qualificationPlaces, rollingFinals, sourceDescriptor } from './qualifiers';
import { appendQualifierBracket, eligibleQualifierRoster } from './rollingFinals';
import type {
  CommandEnvelope,
  QualifierSlot,
  QualifierSource,
  StrengthSeeding,
  TournamentState,
} from './schemas';

export const strengthSeedPolicy = 'pool_place_whr_v1' as const;

export function canUseStrengthSeeding(state: TournamentState) {
  return rollingFinals(state) && state.brackets.every((bracket) => bracket.strengthSeeding);
}

function frozenStrengths(state: TournamentState) {
  const { rankingModel, settings } = state.baseline!.ratingContext;
  const configuredSd = settings.whrPriorSd;
  const sd =
    typeof configuredSd === 'number' && Number.isFinite(configuredSd) && configuredSd > 0
      ? configuredSd
      : defaultRatingSettings.whrPriorSd;
  const prior = DISPLAY_CENTRE - 2 * sd * NATURAL_TO_DISPLAY;
  return new Map(
    state.entrants.map((entrant) => {
      const frozen = !rankingModel || rankingModel === 'whr' ? entrant.snapshotScore : null;
      return [
        entrant.playerId,
        {
          strength: frozen ?? prior,
          strengthSource: frozen === null ? ('prior' as const) : ('frozen' as const),
        },
      ];
    }),
  );
}

function comparison(draw: ConsolationBracket) {
  return {
    byes: draw.roundOne.filter(({ b }) => !b).map(({ a }) => a.playerId),
    rematchesByRound: poolRematchRounds(draw),
  };
}

type StrengthStage = {
  division: 'upper' | 'lower';
  stage: 'main' | 'consolation';
  waiting: QualifierSource[];
  ready: { slots: QualifierSlot[]; seeding: StrengthSeeding } | null;
};

function strengthFinalsFields(state: TournamentState) {
  const { structure, structureOptions } = state.baseline!;
  const divisions =
    structure && structure !== 'dual_division'
      ? (['upper'] as const)
      : (['upper', 'lower'] as const);
  const rosters = new Map(
    state.pools.map((pool) => [pool.id, eligibleQualifierRoster(state, pool)]),
  );
  const fields = divisions.map((division) => {
    const places = state.pools
      .filter((pool) => pool.division === division)
      .flatMap((pool) => {
        const eligibleEntrantIds = rosters.get(pool.id)!;
        return qualificationPlaces(state, { ...pool, qualifierRoster: eligibleEntrantIds }).map(
          (selection, index) => ({
            playerId: selection.entrantId ?? `${pool.id}:${index + 1}`,
            poolIndex: pool.index,
            place: index + 1,
            source: {
              ...selection,
              poolId: pool.id,
              poolIndex: pool.index,
              division,
              place: index + 1,
              eligibleEntrantIds,
            } satisfies QualifierSlot,
          }),
        );
      });
    const stages = finalsRoles(structure, structureOptions).flatMap((stage) => {
      if (
        state.brackets.some((bracket) => bracket.division === division && bracket.stage === stage)
      )
        return [];
      return [
        { stage, selected: selectFormatFinalists(structure, places, stage, structureOptions) },
      ];
    });
    return { division, stages };
  });
  return { fields, rosters };
}

/** Public qualifier sources without candidates, eligibility rosters or hypothetical seeds. */
export function pendingStrengthFinals(state: TournamentState) {
  if (state.lifecycle !== 'locked' || !canUseStrengthSeeding(state)) return [];
  return strengthFinalsFields(state).fields.flatMap(({ division, stages }) =>
    stages
      .filter(({ selected }) => selected.length)
      .map(({ stage, selected }) => ({
        division,
        stage,
        slots: selected.map(({ source }) => ({
          ...sourceDescriptor(source),
          entrantId: source.entrantId,
        })),
      })),
  );
}

/** Each stage can commit once its own field is exact. Other pools can still run. */
export function planStrengthFinals(state: TournamentState) {
  const { fields, rosters } = strengthFinalsFields(state);
  const strengths = frozenStrengths(state);
  const stages = fields.flatMap(({ division, stages }) => {
    const planned = stages.map<StrengthStage>(({ stage, selected }) => {
      const waiting = selected
        .map(({ source }) => source)
        .filter((source) => source.status !== 'resolved')
        .map(sourceDescriptor);
      if (waiting.length) return { division, stage, waiting, ready: null };
      const field = selected.map(({ playerId, poolIndex, place }) => ({
        playerId,
        poolIndex,
        place,
        ...strengths.get(playerId)!,
      }));
      const combined = field.length ? seedFinalistsByStrength(field) : null;
      const previous = field.length ? seedPoolFinishers(field) : null;
      const originalSeeds = new Map(
        previous?.entrants.map((seed) => [seed.playerId, seed.bracketSeed]),
      );
      const byPlayer = new Map(selected.map(({ playerId, source }) => [playerId, source]));
      const noEntrants = { byes: [], rematchesByRound: [] };
      const seeding: StrengthSeeding = {
        policy: strengthSeedPolicy,
        poolPlaceCost: FINALS_POOL_PLACE_COST,
        seeds: (combined?.seeds ?? []).map(
          ({ playerId, place, strength, combinedScore, provisionalSeed, bracketSeed }) => ({
            playerId,
            place,
            strength,
            strengthSource: strengths.get(playerId)!.strengthSource,
            combinedScore,
            provisionalSeed,
            bracketSeed,
            poolPlaceSeed: originalSeeds.get(playerId)!,
          }),
        ),
        comparison: {
          poolPlaces: previous ? comparison(previous) : noEntrants,
          combined: combined ? comparison(combined) : noEntrants,
        },
      };
      return {
        division,
        stage,
        waiting,
        ready: {
          slots: seeding.seeds.map(({ playerId }) => byPlayer.get(playerId)!),
          seeding,
        },
      };
    });
    // An empty stage cannot freeze eligibility while every playable stage is waiting.
    const canFreeze =
      !planned.some(({ ready }) => !ready) ||
      planned.some(({ ready }) => ready?.slots.length) ||
      state.brackets.some((bracket) => bracket.division === division);
    return canFreeze ? planned : planned.filter(({ ready }) => !ready);
  });
  return { stages, rosters };
}

export function strengthFinalsToken(state: TournamentState, plan = planStrengthFinals(state)) {
  const ready = plan.stages.filter((stage) => stage.ready);
  const divisions = new Set(ready.map((stage) => stage.division));
  return hash({
    policy: strengthSeedPolicy,
    lifecycle: state.lifecycle,
    existing: state.brackets.map((bracket) => bracket.id),
    ready,
    rosters: state.pools
      .filter((pool) => divisions.has(pool.division))
      .map((pool) => [pool.id, plan.rosters.get(pool.id)]),
  });
}

export function drawStrengthFinals(state: TournamentState, envelope: CommandEnvelope) {
  requireFact(
    canUseStrengthSeeding(state),
    'Keep the existing finals policy or remove unplayed finals before changing it.',
  );
  const { stages, rosters } = planStrengthFinals(state);
  const ready = stages.filter((item) => item.ready);
  requireFact(ready.length, 'No additional brackets have all their qualifiers confirmed.');
  for (const pool of state.pools) {
    if (pool.qualifierRoster || !ready.some((item) => item.division === pool.division)) continue;
    pool.qualifierRoster = rosters.get(pool.id)!;
    pool.revision++;
  }
  for (const { division, stage, ready: bracket } of ready)
    appendQualifierBracket(state, envelope, division, stage, bracket!.slots, bracket!.seeding);
  state.settings.resourceRevision++;
}
