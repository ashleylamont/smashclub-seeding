import { useId } from 'react';
import { Field } from './ui/Field';

/** Shared presentation only: revision, request ID and reporting rules stay with callers. */
export function ScoreFields({
  player1Name,
  player2Name,
  score1,
  score2,
  onScore1,
  onScore2,
  disabled = false,
  requireDecisive = true,
}: {
  player1Name: string | null;
  player2Name: string | null;
  score1: number;
  score2: number;
  onScore1: (value: number) => void;
  onScore2: (value: number) => void;
  disabled?: boolean;
  requireDecisive?: boolean;
}) {
  const hintId = useId();
  return (
    <div className="ui-score-fields">
      <div className="ops-score-inputs">
        <Field
          label={player1Name || 'Player 1'}
          type="number"
          inputMode="numeric"
          min={0}
          max={5}
          step={1}
          required
          value={score1}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => onScore1(Number(event.target.value))}
        />
        <Field
          label={player2Name || 'Player 2'}
          type="number"
          inputMode="numeric"
          min={0}
          max={5}
          step={1}
          required
          value={score2}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => onScore2(Number(event.target.value))}
        />
      </div>
      <p className="ui-field-hint" id={hintId}>
        {requireDecisive && score1 === score2
          ? 'Enter a final score with a winner.'
          : 'Games won by each player.'}
      </p>
    </div>
  );
}
