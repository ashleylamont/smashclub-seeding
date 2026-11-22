import { matchPresentation } from '../lib/matchPresentation';
import type { LiveMatch } from '../lib/eventDisplay';
import { Button } from './ui/Button';
import { ScoreFields, type ScoreInputValue } from './ScoreFields';
import type { SetCharacterPick } from '@smashclub/shared';
import { SetCharacterFields } from './SetCharacterFields';
import type { ReportEditor } from '../lib/useScoreReportDrafts';
import type { ScoreReportPlayer } from '../lib/scoreReportPlayers';

type RecordedMatch = LiveMatch & { revision: number; pendingDisputeCount?: number };
export type ResultSubmission = {
  expectedRevision: number;
  requestId: string;
  score1: number;
  score2: number;
  characterPicks?: SetCharacterPick[];
};
/** Later reports are evidence for organisers; they never replace the displayed official result. */
export function CompletedScoreReport({
  match,
  enabled,
  allowReports,
  showUnavailableHint = true,
  onSubmit,
  editor,
  players,
  pendingReport,
  label = 'Confirmed result',
  recordedOnly = false,
}: {
  match: RecordedMatch;
  enabled: boolean;
  allowReports: boolean;
  showUnavailableHint?: boolean;
  pendingReport?: { score1: number | null; score2: number | null; isDispute: boolean };
  onSubmit: (input: ResultSubmission) => Promise<{ isDispute: boolean }>;
  editor: ReportEditor;
  players: ScoreReportPlayer[];
  label?: string;
  recordedOnly?: boolean;
}) {
  const presentation = matchPresentation(match);
  const { editing, score1, score2, revision, requestId, confirmationId, picks, message, error } =
    editor.draft;
  const pending = editor.draft.pendingRequestId !== null;
  const showEditor = editing && !message;
  const showReporting =
    !recordedOnly &&
    allowReports &&
    presentation.canReport &&
    (enabled || Boolean(pendingReport) || showUnavailableHint);
  const submit = async (first: ScoreInputValue, second: ScoreInputValue, id: string) => {
    if (
      first === '' ||
      second === '' ||
      first === second ||
      !enabled ||
      pending ||
      revision !== match.revision
    )
      return;
    editor.begin(id);
    try {
      const result = await onSubmit({
        expectedRevision: revision,
        requestId: id,
        score1: first,
        score2: second,
        ...(picks.length && { characterPicks: picks }),
      });
      editor.succeed(id, {
        message: result.isDispute
          ? 'Different score sent to the TOs for review. The recorded result stays official until they resolve it.'
          : 'Thanks — your score agrees with the recorded result.',
      });
    } catch (cause) {
      editor.fail(
        id,
        cause instanceof Error ? cause.message : 'Could not send this report. Try again.',
      );
    }
  };
  return (
    <div>
      <p>{presentation.result ?? `${label}: ${match.score1} – ${match.score2}`}</p>
      {Boolean(match.pendingDisputeCount) && (
        <p className="banner banner-warning">
          {recordedOnly
            ? 'An unresolved report differs from this official result.'
            : 'A different score has been reported. TO review is pending; this result remains official.'}
        </p>
      )}
      {showReporting && (
        <>
          <p className="muted">
            You can confirm this score or flag a different result. A disagreement goes to the TOs
            and does not change the result automatically.
          </p>
          {pendingReport ? (
            <p role="status">
              Your {pendingReport.isDispute ? 'different score' : 'score'}: {pendingReport.score1} –{' '}
              {pendingReport.score2} · awaiting TO review. Ask a TO if it needs updating.
            </p>
          ) : !enabled ? (
            <p>Use your current event QR pass to confirm or flag this result.</p>
          ) : (
            <>
              {revision !== match.revision && (
                <div role="alert">
                  <p>The recorded result changed. Reload it before reporting.</p>
                  <Button type="button" onClick={editor.reset}>
                    Reload match
                  </Button>
                </div>
              )}
              <div className="ops-toolbar">
                <SetCharacterFields
                  players={players}
                  picks={picks}
                  onChange={editor.editPicks}
                  disabled={pending || revision !== match.revision}
                />
                <Button
                  disabled={pending || revision !== match.revision}
                  onClick={() => void submit(match.score1 ?? 0, match.score2 ?? 0, confirmationId)}
                >
                  Confirm recorded score
                </Button>
                <Button
                  disabled={pending}
                  onClick={() => {
                    editor.update({
                      editing: !showEditor,
                      requestId: crypto.randomUUID(),
                      message: '',
                    });
                  }}
                >
                  Report a different score
                </Button>
              </div>
              {showEditor && (
                <form
                  className="ops-score-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit(score1, score2, requestId);
                  }}
                >
                  <ScoreFields
                    player1Name={match.player1Name}
                    player2Name={match.player2Name}
                    score1={score1}
                    score2={score2}
                    onScore1={(value) => editor.editScore('score1', value)}
                    onScore2={(value) => editor.editScore('score2', value)}
                  />
                  <Button
                    type="submit"
                    pending={pending}
                    disabled={
                      pending ||
                      revision !== match.revision ||
                      score1 === '' ||
                      score2 === '' ||
                      score1 === score2 ||
                      (score1 === match.score1 && score2 === match.score2)
                    }
                  >
                    Send different score to TOs
                  </Button>
                </form>
              )}
            </>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
