import { Button } from '../../components/ui/Button';
import { matchPresentation } from '../../lib/matchPresentation';
import type { Overview } from './dispatchTypes';

export interface UntakenCallDesk {
  shared: boolean;
  calls: Overview['matches'];
  open: (id: string) => void;
}

export function UntakenCallRecovery({
  matchIds,
  desk,
  showInstructions = true,
}: {
  matchIds: string[];
  desk: UntakenCallDesk;
  showInstructions?: boolean;
}) {
  const calls = desk.calls.filter((match) => matchIds.includes(match.id));
  if (!calls.length) return null;
  return (
    <div>
      {showInstructions && (
        <p className="muted">
          Return the {calls.length === 1 ? 'call' : 'calls'} below, then retry.
        </p>
      )}
      <ul className="ops-call-links" aria-label="Affected calls">
        {calls.map((match) => {
          const pairing = matchPresentation(match).title;
          return (
            <li key={match.id}>
              <span>{pairing}</span>
              <Button
                size="small"
                aria-label={`Open call for ${pairing}`}
                onClick={() => desk.open(match.id)}
              >
                Open call
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
