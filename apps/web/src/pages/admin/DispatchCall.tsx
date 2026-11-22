import { matchPresentation } from '../../lib/matchPresentation';
import { useState, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select, SelectItem } from '../../components/ui/Select';
import { ConfirmCancel, ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { authClient } from '../../lib/auth';
import { returnCallControlId } from '../../lib/opsWorkspace';
import type { Command, Overview, Desk, Run } from './dispatchTypes';
import { namedStationStart } from './dispatchCommand';

type MatchControl = Extract<Command, { kind: 'matchControl' }>;

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
  return (
    <article className="dispatch-row" data-match-id={match.id}>
      <strong>{matchPresentation(match).title}</strong>
      <p>
        {match.started ? 'Playing' : 'Called'} ·{' '}
        {desk.stations.find((s) => s.id === match.stationId)?.name ??
          match.callLocation ??
          'Any available ordinary setup'}
      </p>
      <div className="ops-match-actions">
        <ActiveCallControls
          match={match}
          resourceRevision={desk.resourceRevision}
          run={run}
          disabled={disabled}
          returnControlId={returnCallControlId(match.id)}
        >
          <Button disabled={disabled} onClick={() => onMatch(match.id)}>
            Score / details
          </Button>
        </ActiveCallControls>
      </div>
    </article>
  );
}

export function ActiveCallControls({
  match,
  resourceRevision,
  run,
  disabled,
  size,
  returnControlId,
  children,
}: {
  match: Overview['matches'][number];
  resourceRevision: number;
  run: Run;
  disabled: boolean;
  size?: 'small';
  returnControlId?: string;
  children?: ReactNode;
}) {
  const visit = useLocation({ select: ({ href, state }) => `${state.__TSR_key ?? ''}:${href}` });
  const { data: session } = authClient.useSession();
  // The workspace keeps inactive tabs mounted. Scope the dialog to this visit and pairing.
  const releaseScope = JSON.stringify([
    visit,
    session?.session.id,
    match.eventPlanId,
    match.id,
    match.stationId,
    match.player1Id,
    match.player2Id,
  ]);
  const basis = {
    matchId: match.id,
    expectedRevision: match.revision,
    expectedResourceRevision: resourceRevision,
  };
  const release: MatchControl = {
    kind: 'matchControl',
    ...basis,
    status: 'ready',
    stationId: null,
    reason: null,
  };
  return (
    <>
      {!match.started && (
        <Button
          size={size}
          disabled={disabled}
          onClick={() => void run({ kind: 'beginPlay', ...basis })}
        >
          Mark playing
        </Button>
      )}
      {children}
      {match.started ? (
        <ReleaseCapacityButton
          key={releaseScope}
          command={release}
          run={run}
          disabled={disabled}
          size={size}
        />
      ) : (
        <Button
          id={returnControlId}
          size={size}
          disabled={disabled}
          onClick={() => void run({ ...release, onlyIfUntaken: true })}
        >
          Return untaken call
        </Button>
      )}
    </>
  );
}

function ReleaseCapacityButton({
  command,
  run,
  disabled,
  size,
}: {
  command: MatchControl;
  run: Run;
  disabled: boolean;
  size?: 'small';
}) {
  // Keep the revisions from the click so a subsequent resource change is checked by the server.
  const [reviewed, setReviewed] = useState<MatchControl | null>(null);
  return (
    <>
      <Button size={size} disabled={disabled} onClick={() => setReviewed(command)}>
        Release capacity
      </Button>
      {reviewed && (
        <ConfirmDialog
          title="Confirm action"
          description="Release this match’s capacity? Actual play and live scores remain recorded. Resolve any result before changing its opponents."
          open
          onOpenChange={(open) => {
            if (!open) setReviewed(null);
          }}
        >
          <div className="modal-actions">
            <ConfirmCancel />
            <Button
              variant="primary"
              onClick={() => {
                setReviewed(null);
                void run(reviewed);
              }}
            >
              Confirm
            </Button>
          </div>
        </ConfirmDialog>
      )}
    </>
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
      <h4>{matchPresentation(match).title}</h4>
      <span className="chip">{row.state === 'ready' ? 'Ready to call' : 'Waiting'}</span>
      <small>
        {match.label}
        {row.reason === 'TO order' && ' · TO order'}
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
              expectedOrdinaryCapacity: desk.capacity,
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
                void run(
                  namedStationStart(match.id, station, match.revision, desk.resourceRevision),
                )
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
