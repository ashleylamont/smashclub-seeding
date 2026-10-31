import { useState, type ReactNode } from 'react';
import { useConfirmation } from '../../lib/confirmation';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { ScoreFields, type ScoreInputValue } from '../../components/ScoreFields';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';

type Match = Overview['matches'][number];
type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
export function MatchScoring({
  match,
  disabled,
  act,
  children,
}: {
  match: Match;
  disabled: boolean;
  act: Action;
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
  const stale =
    editing !== null &&
    (revision !== match.revision ||
      (editing === 'live' && progressRevision !== match.progressRevision));
  const requireDecisive = editing === 'final' && outcome === 'played';
  const needsScores = editing === 'live' || outcome === 'played';
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
            if (disabled || stale || (needsScores && (score1 === '' || score2 === ''))) return;
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
                else
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
                setEditing(null);
              },
              editing === 'live'
                ? 'Live score updated · match still playing'
                : outcome === 'forfeit'
                  ? 'Forfeit recorded locally · no played games'
                  : 'Score recorded locally',
            );
          }}
        >
          <strong>
            {editing === 'live'
              ? 'Update the score without finishing the match'
              : outcome === 'forfeit'
                ? 'Record a forfeit without played games'
                : 'Confirm the final result and finish this match'}
          </strong>
          {stale && (
            <p role="alert" className="error-text">
              Another TO updated this match. Cancel and reopen to use the latest score.
            </p>
          )}
          {needsScores ? (
            <ScoreFields
              player1Name={match.player1Name}
              player2Name={match.player2Name}
              score1={score1}
              score2={score2}
              requireDecisive={requireDecisive}
              onScore1={(value) => {
                setScore1(value);
                setRequestId(crypto.randomUUID());
              }}
              onScore2={(value) => {
                setScore2(value);
                setRequestId(crypto.randomUUID());
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
          <div className="ops-match-actions">
            <Button
              type="submit"
              variant="primary"
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
                  : 'Confirm result'}
            </Button>
            <Button type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
