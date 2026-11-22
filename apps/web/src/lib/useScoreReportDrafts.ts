import { useState } from 'react';
import type { SetCharacterPick } from '@smashclub/shared';
import type { LiveMatch } from './eventDisplay';
import type { ScoreInputValue } from '../components/ScoreFields';

type DraftMatch = LiveMatch & { revision: number };

type CompletedReportFeedback = {
  reportId: string;
  previousReportId?: string;
  message: string;
};

type ScoreReportDraft = {
  score1: ScoreInputValue;
  score2: ScoreInputValue;
  revision: number;
  requestId: string;
  confirmationId: string;
  picks: SetCharacterPick[];
  editing: boolean;
  retryRejected: boolean;
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
  matches: readonly DraftMatch[],
): ScoreReportDrafts {
  const [state, setState] = useState({ scope, matches, drafts: new Map() as Drafts });

  let drafts = state.drafts;
  if (state.scope !== scope || state.matches !== matches) {
    if (state.scope !== scope) drafts = new Map();
    else if (drafts.size) {
      const currentKeys = new Set(matches.map(scoreReportDraftKey));
      drafts = new Map([...drafts].filter(([key]) => currentKeys.has(key)));
    }
    setState({ scope, matches, drafts });
  }

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

function initialDraft(match: DraftMatch): ScoreReportDraft {
  return {
    score1: match.status === 'complete' ? (match.score1 ?? 0) : 0,
    score2: match.status === 'complete' ? (match.score2 ?? 0) : 0,
    revision: match.revision,
    requestId: crypto.randomUUID(),
    confirmationId: crypto.randomUUID(),
    picks: [],
    editing: false,
    retryRejected: false,
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
    const apply = (previous: ScoreReportDraft) =>
      forRequest === undefined || previous.pendingRequestId === forRequest
        ? { ...previous, ...changes }
        : previous;
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
      update({ [side]: value, requestId: crypto.randomUUID() }),
    editPicks: (picks: SetCharacterPick[]) =>
      update({ picks, requestId: crypto.randomUUID(), confirmationId: crypto.randomUUID() }),
    reset: () =>
      update({
        ...initialDraft(match),
        editing: draft.editing,
        pendingRequestId: draft.pendingRequestId,
        retryRejected: draft.retryRejected,
      }),
    begin: (id: string) =>
      update({ pendingRequestId: id, completedFeedback: null, error: '', sent: null }),
    succeed: (
      id: string,
      feedback: Pick<Partial<ScoreReportDraft>, 'completedFeedback' | 'sent'>,
    ) => update({ pendingRequestId: null, editing: false, retryRejected: false, ...feedback }, id),
    fail: (id: string, error: string) => update({ pendingRequestId: null, error }, id),
  };
}

export type ReportEditor = ReturnType<typeof useScoreReportDraft>;
