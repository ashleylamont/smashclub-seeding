import { useLayoutEffect, useMemo, useState } from 'react';
import type { SetCharacterPick } from '@smashclub/shared';
import type { LiveMatch } from './eventDisplay';
import { matchPresentation } from './matchPresentation';
import type { ScoreInputValue } from '../components/ScoreFields';
import { scoreReportPlayers } from './scoreReportPlayers';
import {
  clearScoreDrafts,
  readScoreDrafts,
  saveScoreDrafts,
  type DraftOwner,
  type SavedScoreDraft,
} from './scoreDraftSession';

type DraftMatch = LiveMatch & { revision: number };

type CompletedReportFeedback = {
  reportId: string;
  previousReportId?: string;
  message: string;
};

type ScoreReportDraft = Omit<SavedScoreDraft, 'touchedAt'> & {
  touchedAt: number | null;
  pendingRequestId: string | null;
  sent: 'approved' | 'pending' | null;
  completedFeedback: CompletedReportFeedback | null;
  error: string;
};

type Drafts = ReadonlyMap<string, ScoreReportDraft>;
export function scoreReportDraftKey(match: DraftMatch) {
  return JSON.stringify([
    match.id,
    match.player1Id,
    match.player1MemberIds ?? [],
    match.player2Id,
    match.player2MemberIds ?? [],
    // Keep ready and playing drafts together, but retire them if reporting becomes ineligible.
    matchPresentation(match).canReport,
    // A new official result starts a separate editor. Other revision changes still require Reload.
    match.status === 'complete'
      ? [match.outcome, match.winnerId, match.score1, match.score2]
      : null,
  ]);
}

export type ScoreReportDrafts = {
  drafts: Drafts;
  setDrafts: (update: (previous: Drafts) => Drafts) => void;
};

/** Retain only edited pairings from the current event and reporting credential. */
export function useScoreReportDrafts(
  scope: string,
  matches: readonly DraftMatch[] | undefined,
  {
    planId,
    owner,
    canRecover,
  }: {
    planId: string;
    owner: DraftOwner | null | undefined;
    canRecover: (match: DraftMatch, attemptedRequestId: string | null) => boolean;
  },
): ScoreReportDrafts {
  const matchesByKey = useMemo(
    () => matches && new Map(matches.map((match) => [scoreReportDraftKey(match), match])),
    [matches],
  );
  const verifiedEligibility = owner ? canRecover : undefined;
  const [state, setState] = useState({
    scope,
    matches,
    drafts: new Map() as Drafts,
    recoveredOwner: undefined as DraftOwner | undefined,
    verifiedEligibility,
  });

  let drafts = state.drafts;
  if (state.scope !== scope || (owner === null && (state.recoveredOwner || drafts.size))) {
    drafts = new Map();
    setState({ scope, matches, drafts, recoveredOwner: undefined, verifiedEligibility });
  } else if (
    state.matches !== matches ||
    state.verifiedEligibility !== verifiedEligibility ||
    (owner && state.recoveredOwner !== owner)
  ) {
    if (matchesByKey && drafts.size) {
      drafts = new Map(
        [...drafts].flatMap(([key, draft]) => {
          const match = matchesByKey.get(key);
          if (!match) return [];
          const unsent = draft.touchedAt !== null || draft.editing || draft.retryRejected;
          if (
            unsent &&
            verifiedEligibility &&
            !verifiedEligibility(match, draft.attemptedRequestId)
          ) {
            return [
              [
                key,
                {
                  ...initialDraft(match),
                  // An outstanding request can still receive its authoritative response.
                  pendingRequestId: draft.pendingRequestId,
                  sent: draft.sent,
                  completedFeedback: draft.completedFeedback,
                },
              ],
            ];
          }
          return [[key, draft]];
        }),
      );
    }
    let recoveredOwner = state.recoveredOwner;
    if (owner && recoveredOwner !== owner && matchesByKey) {
      const recovered = new Map<string, ScoreReportDraft>();
      for (const [key, saved] of readScoreDrafts(planId, owner)) {
        const match = matchesByKey.get(key);
        if (!match || !canRecover(match, saved.attemptedRequestId)) continue;
        const players = new Set(scoreReportPlayers(match).map(({ id }) => id));
        if (saved.picks.some(({ playerId }) => !players.has(playerId))) continue;
        recovered.set(key, {
          ...saved,
          pendingRequestId: null,
          sent: null,
          completedFeedback: null,
          error: '',
        });
      }
      // An edit typed while the reporting queries loaded takes precedence.
      drafts = new Map([...recovered, ...drafts]);
      recoveredOwner = owner;
    }
    setState({ scope, matches, drafts, recoveredOwner, verifiedEligibility });
  }

  useLayoutEffect(() => {
    // Undefined means the event or credential is still being verified.
    if (owner === undefined) return;
    if (owner === null) {
      clearScoreDrafts(planId);
      return;
    }
    if (!matchesByKey) return;
    saveScoreDrafts(
      planId,
      owner,
      [...drafts].flatMap(([key, draft]) => {
        const match = matchesByKey.get(key);
        if (!match || draft.touchedAt === null || !canRecover(match, draft.attemptedRequestId))
          return [];
        const { score1, score2, picks, attemptedRequestId, touchedAt } = draft;
        const [initial1, initial2] = initialScores(match);
        return attemptedRequestId || picks.length || score1 !== initial1 || score2 !== initial2
          ? [[key, { ...draft, touchedAt }]]
          : [];
      }),
    );
  }, [canRecover, drafts, matchesByKey, owner, planId]);

  return {
    drafts,
    setDrafts: (update) =>
      setState((previous) => {
        if (previous.scope !== scope) return previous;
        const drafts = update(previous.drafts);
        return drafts === previous.drafts ? previous : { ...previous, drafts };
      }),
  };
}

function initialScores(match: DraftMatch): [ScoreInputValue, ScoreInputValue] {
  return match.status === 'complete' ? [match.score1 ?? 0, match.score2 ?? 0] : [0, 0];
}

function initialDraft(match: DraftMatch): ScoreReportDraft {
  const [score1, score2] = initialScores(match);
  return {
    score1,
    score2,
    revision: match.revision,
    requestId: crypto.randomUUID(),
    confirmationId: crypto.randomUUID(),
    picks: [],
    editing: false,
    retryRejected: false,
    attemptedRequestId: null,
    touchedAt: null,
    pendingRequestId: null,
    sent: null,
    completedFeedback: null,
    error: '',
  };
}

export function useScoreReportDraft(match: DraftMatch, store?: ScoreReportDrafts) {
  const [local, setLocal] = useState(() => initialDraft(match));
  const key = scoreReportDraftKey(match);
  const draft = store?.drafts.get(key) ?? local;
  const update = (changes: Partial<ScoreReportDraft>, forRequest?: string) => {
    const apply = (previous: ScoreReportDraft) => {
      if (forRequest !== undefined && previous.pendingRequestId !== forRequest) return previous;
      const next = { ...previous, ...changes };
      if (
        next.attemptedRequestId !== next.requestId &&
        next.attemptedRequestId !== next.confirmationId
      )
        next.attemptedRequestId = null;
      return next;
    };
    if (!store) {
      setLocal(apply);
      return;
    }
    store.setDrafts((previous) => {
      const current = previous.get(key) ?? local;
      const next = apply(current);
      return next === current ? previous : new Map(previous).set(key, next);
    });
  };
  return {
    draft,
    update,
    editScore: (side: 'score1' | 'score2', value: ScoreInputValue) =>
      update({
        [side]: value,
        requestId: crypto.randomUUID(),
        attemptedRequestId: null,
        touchedAt: Date.now(),
      }),
    editPicks: (picks: SetCharacterPick[]) =>
      update({
        picks,
        requestId: crypto.randomUUID(),
        confirmationId: crypto.randomUUID(),
        attemptedRequestId: null,
        touchedAt: Date.now(),
      }),
    reload: () => {
      if (draft.pendingRequestId !== null || draft.revision === match.revision) return;
      // The revised submission has a different payload; it cannot retry either earlier request.
      update({
        revision: match.revision,
        requestId: crypto.randomUUID(),
        confirmationId: crypto.randomUUID(),
        attemptedRequestId: null,
        error: '',
      });
    },
    begin: (id: string) =>
      update({
        pendingRequestId: id,
        completedFeedback: null,
        error: '',
        sent: null,
        attemptedRequestId: id,
        touchedAt: Date.now(),
      }),
    succeed: (
      id: string,
      feedback: Pick<Partial<ScoreReportDraft>, 'completedFeedback' | 'sent'>,
    ) =>
      update(
        {
          pendingRequestId: null,
          editing: false,
          retryRejected: false,
          attemptedRequestId: null,
          touchedAt: null,
          // A definitive report for a completed result supersedes earlier confirmation attempts.
          ...(feedback.completedFeedback && { confirmationId: crypto.randomUUID() }),
          ...feedback,
        },
        id,
      ),
    fail: (id: string, error: string) => update({ pendingRequestId: null, error }, id),
  };
}

export type ReportEditor = ReturnType<typeof useScoreReportDraft>;
