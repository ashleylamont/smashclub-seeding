import { isKnockout } from '@smashclub/shared';
import { EventBrackets } from '../../components/EventNightBoard';
import { Notice } from '../../components/ui/Feedback';
import { BracketBackupSheets } from './BracketBackupSheets';
import type { Overview } from './dispatchTypes';
import '../../styles/event-board.css';

/** Read-only tools remain available after finalization and while a draw is paused. */
export function NativeDrawTools({ data }: { data: Overview }) {
  if (data.plan.structure === 'round_robin')
    return (
      <Notice>
        Round-robin events use the pool standings above; there is no elimination bracket.
      </Notice>
    );
  const generated = data.nativeBrackets.length > 0;
  return (
    <section className="app-event-board" aria-label="Tournament draw">
      {generated ? (
        <EventBrackets
          brackets={data.nativeBrackets}
          matches={data.matches}
          entrants={data.entrants}
          linked={[]}
        />
      ) : (
        <>
          <h2>Tournament draw</h2>
          <p>
            {isKnockout(data.plan.structure)
              ? 'Lock the draw in the planner to publish the bracket and print its match order.'
              : 'Finals are not created yet. Preview finals above to review the proposed pairings; paper templates are available below.'}
          </p>
        </>
      )}
      {(generated || !isKnockout(data.plan.structure)) && <BracketBackupSheets data={data} />}
    </section>
  );
}
