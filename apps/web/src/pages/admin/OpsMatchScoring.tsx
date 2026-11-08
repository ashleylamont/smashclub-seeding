import { useState, type ReactNode } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useConfirmation } from '../../lib/confirmation';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { ScoreFields, type ScoreInputValue } from '../../components/ScoreFields';
import { trpc } from '../../lib/trpc';
import { returnUntakenCallMatchIds } from '../../lib/eventErrors';
import { ScoreCallRecovery, type ScoreCallDesk } from './ScoreCallRecovery';
import type { Overview } from './dispatchTypes';

type Match = Overview['matches'][number];
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;

function isPoolGameCorrection(match: Match, score1: ScoreInputValue, score2: ScoreInputValue) {
  return (
    'reviewPoolGames' in match &&
    match.reviewPoolGames &&
    score1 !== '' &&
    score2 !== '' &&
    score1 !== score2 &&
    (score1 > score2 ? match.player1Id : match.player2Id) === match.winnerId &&
    (score1 !== match.score1 || score2 !== match.score2)
  );
}

export function MatchScoring({
  match,
  disabled,
  act,
  callDesk,
  children,
}: {
  match: Match;
  disabled: boolean;
  act: Action;
  callDesk?: ScoreCallDesk;
  children: ReactNode;
}) {
  const confirmAction = useConfirmation();
  const [editing, setEditing] = useState<'live' | 'final' | null>(null);
  const [revision, setRevision] = useState(match.revision);
  const [progressRevision, setProgressRevision] = useState(match.progressRevision);
  const [score1, setScore1] = useState<ScoreInputValue>(match.score1 ?? 0);
  const [score2, setScore2] = useState<ScoreInputValue>(match.score2 ?? 0);
  const [outcome, setOutcome] = useState<'played' | 'forfeit' | 'bye'>('played');
  const [winnerId, setWinnerId] = useState(match.winnerId ?? match.player1Id ?? '');
  const [requestId, setRequestId] = useState('');
  const [callConflict, setCallConflict] = useState<{ requestId: string; matchIds: string[] }>();
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [reviewed, setReviewed] = useState<{ requestId: string; token: string }>();
  const approvedToken = reviewed?.requestId === requestId ? reviewed.token : undefined;
  const stale =
    !approvedToken &&
    editing !== null &&
    (revision !== match.revision ||
      (editing === 'live' && progressRevision !== match.progressRevision));
  const requireDecisive = editing === 'final' && outcome === 'played';
  const needsScores = editing === 'live' || outcome === 'played';
  const reviewPoolGames = requireDecisive && isPoolGameCorrection(match, score1, score2);
  const participatingWinner = [match.player1Id, match.player2Id].some(
    (id) => Boolean(id) && id === winnerId,
  );
  const begin = (mode: 'live' | 'final', resultType?: 'forfeit') => {
    setEditing(mode);
    setRevision(match.revision);
    setProgressRevision(match.progressRevision);
    setScore1(match.score1 ?? 0);
    setScore2(match.score2 ?? 0);
    setOutcome(resultType ?? match.outcome ?? 'played');
    setWinnerId(resultType ? '' : (match.winnerId ?? ''));
    setRequestId(crypto.randomUUID());
    setReviewError('');
  };
  const reviewScore = async (score1: number, score2: number) => {
    setReviewing(true);
    setReviewError('');
    try {
      const { revisionToken, previousScore } =
        await trpc.eventOps.live.previewPoolGameCorrection.query({
          planId: match.eventPlanId,
          matchId: match.id,
          expectedRevision: revision,
          score1,
          score2,
        });
      const approved = await confirmAction(
        `Correct ${previousScore.join('–')} to ${score1}–${score2}? The winner, confirmed pool places and finals draw stay as recorded. Ratings use the corrected games after publication.`,
      );
      if (!approved) return;
      setReviewed({ requestId, token: revisionToken });
      return revisionToken;
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'Could not review the correction.');
    } finally {
      setReviewing(false);
    }
  };
  const saveReviewedScore = async (score1: number, score2: number, token: string) => {
    try {
      await trpc.eventOps.live.command.mutate({
        planId: match.eventPlanId,
        requestId,
        command: {
          kind: 'score',
          matchId: match.id,
          expectedRevision: revision,
          outcome: 'played',
          score1,
          score2,
          poolGameCorrectionToken: token,
        },
      });
    } catch (cause) {
      // Only an explicit rejection invalidates the approved request.
      if (cause instanceof TRPCClientError && cause.data?.code === 'CONFLICT')
        setRequestId(crypto.randomUUID());
      throw cause;
    }
  };
  return (
    <>
      <div className="ops-match-actions">
        {children}
        {match.status === 'playing' && (
          <Button size="small" disabled={disabled} onClick={() => begin('live')}>
            Update live score
          </Button>
        )}
        <Button size="small" disabled={disabled} onClick={() => begin('final')}>
          {match.status === 'complete' ? 'Correct score' : 'Finish match'}
        </Button>
        {match.status !== 'complete' && match.player1Id && match.player2Id && (
          <Button size="small" disabled={disabled} onClick={() => begin('final', 'forfeit')}>
            Record forfeit
          </Button>
        )}
      </div>
      {editing && (
        <form
          className="ops-score-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (disabled || reviewing || stale || (needsScores && (score1 === '' || score2 === '')))
              return;
            if (requireDecisive && score1 === score2) return;
            if (!needsScores && !participatingWinner) return;
            if (
              editing === 'final' &&
              outcome === 'forfeit' &&
              !(await confirmAction(
                `Record ${winnerId === match.player1Id ? match.player1Name : match.player2Name} as the winner by forfeit? This records advancement with no played games or rating input.`,
              ))
            )
              return;
            let correctionToken = approvedToken;
            if (reviewPoolGames && !correctionToken && score1 !== '' && score2 !== '') {
              correctionToken = await reviewScore(score1, score2);
              if (!correctionToken) return;
            }
            void act(
              async () => {
                if (editing === 'live')
                  await trpc.eventOps.updateLiveScore.mutate({
                    matchId: match.id,
                    expectedRevision: revision,
                    expectedProgressRevision: progressRevision,
                    score1: score1 === '' ? 0 : score1,
                    score2: score2 === '' ? 0 : score2,
                  });
                else if (correctionToken && score1 !== '' && score2 !== '')
                  await saveReviewedScore(score1, score2, correctionToken);
                else {
                  try {
                    await trpc.eventOps.reportScore.mutate({
                      matchId: match.id,
                      expectedRevision: revision,
                      requestId,
                      // The shared legacy endpoint requires numeric wire values;
                      // native forfeits are recorded with null game scores.
                      score1: outcome === 'played' && score1 !== '' ? score1 : 0,
                      score2: outcome === 'played' && score2 !== '' ? score2 : 0,
                      outcome,
                      ...(outcome !== 'played' ? { winnerId } : {}),
                    });
                  } catch (cause) {
                    setCallConflict({ requestId, matchIds: returnUntakenCallMatchIds(cause) });
                    throw cause;
                  }
                }
                setEditing(null);
              },
              editing === 'live'
                ? 'Live score updated · match still playing'
                : outcome === 'forfeit'
                  ? 'Forfeit recorded locally · no played games'
                  : correctionToken
                    ? 'Pool score corrected · confirmed places and finals kept'
                    : 'Score recorded locally',
            );
          }}
        >
          <strong>
            {editing === 'live'
              ? 'Update the score without finishing the match'
              : outcome === 'forfeit'
                ? 'Record a forfeit without played games'
                : match.status === 'complete'
                  ? 'Confirm the corrected result'
                  : 'Confirm the final result and finish this match'}
          </strong>
          {stale && (
            <p role="alert" className="error-text">
              Another TO updated this match. Cancel and reopen to use the latest score.
            </p>
          )}
          {reviewError && (
            <p role="alert" className="error-text">
              {reviewError}
            </p>
          )}
          {needsScores ? (
            <ScoreFields
              player1Name={match.player1Name}
              player2Name={match.player2Name}
              score1={score1}
              score2={score2}
              disabled={reviewing}
              requireDecisive={requireDecisive}
              onScore1={(value) => {
                setScore1(value);
                setRequestId(crypto.randomUUID());
                setReviewError('');
              }}
              onScore2={(value) => {
                setScore2(value);
                setRequestId(crypto.randomUUID());
                setReviewError('');
              }}
            />
          ) : (
            <p>
              No game score is needed. Choose the advancing player; this result contributes no
              played games or rating input.
            </p>
          )}
          {editing === 'final' && (
            <>
              <label>
                Result type
                <Select
                  disabled={reviewing}
                  value={outcome}
                  onValueChange={(selectedValue) => {
                    setOutcome(selectedValue as typeof outcome);
                    setWinnerId('');
                    setRequestId(crypto.randomUUID());
                  }}
                >
                  <SelectItem value="played">Played match</SelectItem>
                  <SelectItem value="forfeit" disabled={!match.player1Id || !match.player2Id}>
                    Forfeit
                  </SelectItem>
                  <SelectItem value="bye">Bye</SelectItem>
                </Select>
              </label>
              {outcome !== 'played' && (
                <label>
                  Winner
                  <Select
                    value={winnerId}
                    onValueChange={(selectedValue) => {
                      setWinnerId(selectedValue);
                      setRequestId(crypto.randomUUID());
                    }}
                  >
                    <SelectItem value="">Choose the advancing player</SelectItem>
                    {[
                      { id: match.player1Id, name: match.player1Name },
                      { id: match.player2Id, name: match.player2Name },
                    ]
                      .filter((player) => player.id)
                      .map((player) => (
                        <SelectItem key={player.id!} value={player.id!}>
                          {player.name}
                        </SelectItem>
                      ))}
                  </Select>
                </label>
              )}
            </>
          )}
          {callDesk && !stale && callConflict?.requestId === requestId && (
            <ScoreCallRecovery matchIds={callConflict.matchIds} desk={callDesk} />
          )}
          <div className="ops-match-actions">
            <Button
              type="submit"
              variant="primary"
              aria-disabled={reviewing || undefined}
              disabled={
                disabled ||
                stale ||
                (needsScores && [score1, score2].includes('')) ||
                (!needsScores && !participatingWinner) ||
                (requireDecisive && score1 === score2)
              }
            >
              {editing === 'live'
                ? 'Save live score'
                : outcome === 'forfeit'
                  ? 'Confirm forfeit'
                  : approvedToken
                    ? 'Retry correction'
                    : reviewPoolGames
                      ? 'Review correction'
                      : 'Confirm result'}
            </Button>
            <Button type="button" disabled={reviewing} onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
