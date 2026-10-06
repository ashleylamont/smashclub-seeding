import { state } from '@rotorsoft/act';
import { z } from 'zod';
import { captureBaseline, decide, hash, reduceDecision, TournamentConflict } from './domain';
import { Baseline, Decision, Envelope, initialState, LiveState } from './schemas';

// Act's merge patch treats null as deletion. A single-element frame replaces
// the domain state atomically, preserving explicit null facts and array removals.
export const NativeTournament = state({
  NativeTournament: z.object({ current: z.tuple([LiveState]) }),
})
  .init(() => ({ current: [initialState()] as [ReturnType<typeof initialState>] }))
  .emits({
    BaselineCapturedV1: Baseline,
    LegacyStateImportedV1: LiveState,
    DecisionRecordedV1: Decision,
    ResultsSealedV1: Decision,
    PublicationRecordedV1: z.object({ resultId: z.uuid(), tournamentIds: z.array(z.uuid()) }),
  })
  .patch({
    BaselineCapturedV1: ({ data }) => ({ current: [captureBaseline(data)] }),
    LegacyStateImportedV1: ({ data }) => ({ current: [data] }),
    DecisionRecordedV1: ({ data }, state) => ({
      current: [reduceDecision(state.current[0], data)],
    }),
    ResultsSealedV1: ({ data }, state) => ({ current: [reduceDecision(state.current[0], data)] }),
    PublicationRecordedV1: ({ data }, state) => ({
      current: [
        { ...state.current[0], publication: data, sequence: state.current[0].sequence + 1 },
      ],
    }),
  })
  .on({ CaptureNativeBaseline: Baseline })
  .emit((baseline, snapshot) => {
    if (snapshot.state.current[0].baseline) {
      if (hash(snapshot.state.current[0].baseline) !== hash(baseline))
        throw new TournamentConflict('Baseline differs from the immutable handoff.');
      return undefined;
    }
    captureBaseline(baseline);
    return ['BaselineCapturedV1', baseline];
  })
  .on({ ExecuteNativeCommand: Envelope })
  .emit((envelope, snapshot) => {
    const decision = decide(snapshot.state.current[0], envelope);
    return decision
      ? [
          ['finalize', 'replaceResult'].includes(envelope.command.kind)
            ? 'ResultsSealedV1'
            : 'DecisionRecordedV1',
          decision,
        ]
      : undefined;
  })
  .on({ ImportLegacyNativeState: LiveState })
  .emit((imported, snapshot) => {
    if (snapshot.state.current[0].baseline) {
      if (hash(snapshot.state.current[0].baseline) !== hash(imported.baseline))
        throw new TournamentConflict('Imported state differs from the immutable handoff.');
      return undefined;
    }
    return ['LegacyStateImportedV1', imported];
  })
  .on({
    AcknowledgeNativePublication: z.object({
      resultId: z.uuid(),
      tournamentIds: z.array(z.uuid()),
    }),
  })
  .emit((ack, snapshot) => {
    if (snapshot.state.current[0].result?.id !== ack.resultId)
      throw new TournamentConflict('Acknowledgement does not refer to the sealed result.');
    if (snapshot.state.current[0].publication) {
      if (hash(snapshot.state.current[0].publication) !== hash(ack))
        throw new TournamentConflict('Publication acknowledgement differs.');
      return undefined;
    }
    return ['PublicationRecordedV1', ack];
  })
  .snap((snapshot) => snapshot.patches >= 20)
  .build();
