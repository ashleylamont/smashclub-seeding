import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select, SelectItem } from '../../components/ui/Select';
import { useConfirmation } from '../../lib/confirmation';
import type { Overview, Desk, Run } from './dispatchTypes';

export function ActiveCall({
  match,
  desk,
  run,
  disabled,
  onMatch,
}: {
  match: Overview['matches'][number];
  desk: Desk;
  run: Run;
  disabled: boolean;
  onMatch: (id: string) => void;
}) {
  const confirm = useConfirmation();
  return (
    <article className="dispatch-row" data-match-id={match.id}>
      <strong>
        {match.player1Name} vs {match.player2Name}
      </strong>
      <p>
        {match.started ? 'Playing' : 'Called'} ·{' '}
        {desk.stations.find((s) => s.id === match.stationId)?.name ??
          match.callLocation ??
          'Any available ordinary setup'}
      </p>
      <div className="ops-match-actions">
        {!match.started && (
          <Button
            disabled={disabled}
            onClick={() =>
              void run({
                kind: 'beginPlay',
                matchId: match.id,
                expectedRevision: match.revision,
                expectedResourceRevision: desk.resourceRevision,
              })
            }
          >
            Mark playing
          </Button>
        )}
        <Button disabled={disabled} onClick={() => onMatch(match.id)}>
          Score / details
        </Button>
        <Button
          disabled={disabled}
          onClick={async () => {
            if (
              match.started &&
              !(await confirm(
                'Release this match’s capacity? Actual play and live scores remain recorded. Resolve any result before changing its opponents.',
              ))
            )
              return;
            await run({
              kind: 'matchControl',
              matchId: match.id,
              expectedRevision: match.revision,
              expectedResourceRevision: desk.resourceRevision,
              status: 'ready',
              stationId: null,
              reason: null,
            });
          }}
        >
          {match.started ? 'Release capacity' : 'Return untaken call'}
        </Button>
      </div>
    </article>
  );
}

export function ReadyCall({
  match,
  row,
  desk,
  run,
  disabled,
  onMatch,
  onReviewReports,
  previous,
  afterNext,
  last,
}: {
  match: Overview['matches'][number];
  row: Desk['queue'][number];
  desk: Desk;
  run: Run;
  disabled: boolean;
  onMatch: (id: string) => void;
  onReviewReports: () => void;
  previous?: string;
  afterNext: string | null;
  last: boolean;
}) {
  const [station, setStation] = useState(''),
    [location, setLocation] = useState('');
  return (
    <article className="dispatch-row" data-match-id={match.id}>
      <h4>
        {match.player1Name} vs {match.player2Name}
      </h4>
      <span className="chip">{row.state === 'ready' ? 'Ready to call' : 'Waiting'}</span>
      <small>
        {match.label} · {row.reason}
        {row.downstream ? ` · releases ${row.downstream} feeder path(s)` : ''}
      </small>
      {row.reasons.length > 0 && <p>{row.reasons.map((r) => r.message).join(' ')}</p>}
      {row.reasons.some((reason) => reason.code === 'score_review_pending') && (
        <Button size="small" onClick={onReviewReports}>
          Review submitted score
        </Button>
      )}
      <div className="dispatch-call-controls">
        <label>
          Call location (optional)
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={100}
            placeholder="Near the window"
          />
        </label>
        <Button
          disabled={disabled || !row.canDispatchOrdinary}
          onClick={() =>
            void run({
              kind: 'dispatch',
              matchId: match.id,
              stationId: null,
              expectedRevision: match.revision,
              expectedResourceRevision: desk.resourceRevision,
              callLocation: location.trim() || null,
              callOnly: true,
            })
          }
        >
          Call ordinary match
        </Button>
        {desk.stations.some((s) => s.reserved) && (
          <>
            <label>
              Named station
              <Select value={station} onValueChange={setStation}>
                <SelectItem value="">Choose named station</SelectItem>
                {desk.stations
                  .filter((s) => s.reserved)
                  .map((s) => (
                    <SelectItem
                      key={s.id}
                      value={s.id}
                      disabled={!row.eligibleStationIds.includes(s.id)}
                    >
                      {s.name}
                      {!s.enabled ? ' · unavailable' : s.currentMatchId ? ' · in use' : ''}
                    </SelectItem>
                  ))}
              </Select>
            </label>
            <Button
              disabled={disabled || !station || !row.eligibleStationIds.includes(station)}
              onClick={() =>
                void run({
                  kind: 'dispatch',
                  matchId: match.id,
                  stationId: station,
                  expectedRevision: match.revision,
                  expectedResourceRevision: desk.resourceRevision,
                  callOnly: false,
                })
              }
            >
              Start named station
            </Button>
          </>
        )}
      </div>
      <div className="ops-match-actions">
        <Button
          size="small"
          disabled={disabled || !previous}
          onClick={() =>
            void run({
              kind: 'queueMove',
              matchId: match.id,
              beforeMatchId: previous!,
              expectedQueueRevision: desk.queueRevision,
            })
          }
        >
          Move up
        </Button>
        <Button
          size="small"
          disabled={disabled || last}
          onClick={() =>
            void run({
              kind: 'queueMove',
              matchId: match.id,
              beforeMatchId: afterNext,
              expectedQueueRevision: desk.queueRevision,
            })
          }
        >
          Move down
        </Button>
        <Button size="small" disabled={disabled} onClick={() => onMatch(match.id)}>
          Score / details
        </Button>
      </div>
    </article>
  );
}
