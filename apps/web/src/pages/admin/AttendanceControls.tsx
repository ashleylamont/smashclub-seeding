import { isKnockout } from '@smashclub/shared';
import { DoublesSubstitutionForm } from './DoublesSubstitutionForm';
import { LateDoublesPairForm } from './LateDoublesPairForm';
import { useOpsWorkspace } from '../../lib/opsWorkspace';
import { OpsEventHistory } from './OpsEventHistory';
import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';
import { Select, SelectItem } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Checkbox } from '../../components/ui/Checkbox';
import { Button } from '../../components/ui/Button';
import { useRef, useState, type Ref } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Preview = Awaited<ReturnType<typeof trpc.eventOps.previewAttendance.query>>;
const withdrawalStatusLabels = {
  called: 'Called, awaiting start',
  playing: 'In progress',
  held: 'Started, on hold',
};
type Input = {
  planId: string;
  action: 'add' | 'withdraw' | 'no_show' | 'redistribute' | 'restore';
  requestId?: string;
  playerId: string;
  division?: 'upper' | 'lower';
  reason?: string;
};

type AttendanceAction = Input['action'] | 'substitute' | 'late_pair';

type AttendanceReview = {
  result: Preview;
  input: Input;
  externalAcknowledged: boolean;
  redistributionApproved: boolean;
};

function canApplyAttendance({
  result,
  input,
  externalAcknowledged,
  redistributionApproved,
}: AttendanceReview) {
  return (
    result.allowed &&
    (!result.requiresExternalAcknowledgement || externalAcknowledged) &&
    (input.action !== 'redistribute' || redistributionApproved)
  );
}

export function AttendanceControls({
  planId,
  data,
  disabled,
  callDesk,
}: {
  planId: string;
  data: Overview;
  disabled: boolean;
  callDesk: UntakenCallDesk;
}) {
  const historyActive = useOpsWorkspace().section === 'players';
  const cache = useQueryClient();
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const [action, setAction] = useState<AttendanceAction>(
    data.plan.competitionFormat === 'doubles' ? 'withdraw' : 'add',
  );
  const doubles = data.plan.competitionFormat === 'doubles';
  const doublesPoolWorkflow = doubles && data.plan.liveOwned && !isKnockout(data.plan.structure);
  const [query, setQuery] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [division, setDivision] = useState<'upper' | 'lower'>('upper');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<AttendanceReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const search = useQuery({
    queryKey: ['public', 'players', query],
    queryFn: () => trpc.public.searchPlayers.query({ query }),
    enabled: query.trim().length > 1 && action === 'add',
  });
  const changed = () => {
    setPreview(null);
    setMessage('');
    setError('');
  };
  const inspect = async (input: Input, refocus = false) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await trpc.eventOps.previewAttendance.query(input);
      if (refocus) previewHeading.current?.focus();
      setPreview({
        input,
        result,
        externalAcknowledged: false,
        redistributionApproved: false,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not preview change');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || busy || disabled || !canApplyAttendance(preview)) return;
    setBusy(true);
    setError('');
    try {
      await trpc.eventOps.applyAttendance.mutate({
        ...preview.input,
        ...(preview.result.requiresExternalAcknowledgement && {
          acknowledgeExternalChange: preview.externalAcknowledged,
        }),
        approveRedistribution: preview.redistributionApproved,
        revisionToken: preview.result.revisionToken,
      });
      setPreview(null);
      setPlayerId('');
      setMessage(
        action === 'restore'
          ? 'Attendance restored. Recorded results and any frozen finals field stay unchanged.'
          : 'Attendance updated. Refresh the match queue to see the current pools and matches.',
      );
      await cache.invalidateQueries({ queryKey: ['eventOps', planId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update attendance');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h3>
        {data.plan.competitionFormat === 'doubles' ? 'Pair attendance' : 'Attendance changes'}
      </h3>
      <p className="muted">
        {data.plan.softLockedAt
          ? doubles
            ? doublesPoolWorkflow
              ? 'Add a late pair to an unplayed pool, substitute a member, or record a no-show or withdrawal.'
              : 'Remove an unplayed no-show pair, or withdraw a pair after play.'
            : 'Late arrivals go to the smallest open pool in their division. A no-show leaves their pool; played entrants use withdrawal instead.'
          : 'Soft-lock the pool draw before using local attendance changes. Draft pools can be rebalanced in the planner.'}
      </p>
      <fieldset
        disabled={disabled || busy || !data.plan.softLockedAt}
        className="ops-attendance-fields"
      >
        <label>
          Change
          <Select
            value={action}
            onValueChange={(selectedValue) => {
              setAction(selectedValue as typeof action);
              if (selectedValue === 'restore') setReason('');
              setPlayerId('');
              changed();
            }}
          >
            {data.plan.competitionFormat !== 'doubles' && (
              <SelectItem value="add">Add a late arrival</SelectItem>
            )}
            {doublesPoolWorkflow && (
              <>
                <SelectItem value="late_pair">Add a late doubles pair</SelectItem>
                <SelectItem value="substitute">Substitute a doubles member</SelectItem>
              </>
            )}
            <SelectItem value="no_show">Remove a no-show</SelectItem>
            <SelectItem value="redistribute">Redistribute a two-player pool</SelectItem>
            <SelectItem value="withdraw">Withdraw an entrant after play</SelectItem>
            {data.plan.liveOwned && (
              <SelectItem value="restore">
                Restore a withdrawn {data.plan.competitionFormat === 'doubles' ? 'pair' : 'entrant'}
              </SelectItem>
            )}
          </Select>
        </label>
        {action !== 'substitute' && action !== 'late_pair' && (
          <>
            {action === 'add' && (
              <label>
                Find player by public alias
                <Input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPlayerId('');
                    changed();
                  }}
                  maxLength={100}
                  placeholder="Start typing a player alias"
                />
              </label>
            )}
            <label>
              {data.plan.competitionFormat === 'doubles' ? 'Pair' : 'Player'}
              <Select
                value={playerId}
                onValueChange={(selectedValue) => {
                  setPlayerId(selectedValue);
                  changed();
                }}
              >
                <SelectItem value="">Choose a player</SelectItem>
                {(action === 'add'
                  ? (search.data ?? [])
                  : data.entrants.filter((player) =>
                      action === 'restore'
                        ? data.withdrawals.some((row) => row.playerId === player.id)
                        : !data.withdrawals.some((row) => row.playerId === player.id),
                    )
                ).map((player) => (
                  <SelectItem key={player.id} value={player.id}>
                    {player.name}
                  </SelectItem>
                ))}
              </Select>
            </label>
            {action === 'add' && (
              <label>
                Division
                <Select
                  value={division}
                  onValueChange={(selectedValue) => {
                    setDivision(selectedValue as typeof division);
                    changed();
                  }}
                >
                  <SelectItem value="upper">Upper</SelectItem>
                  <SelectItem value="lower">Lower</SelectItem>
                </Select>
              </label>
            )}
            <label>
              Reason
              <Input
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  changed();
                }}
                maxLength={200}
                placeholder={
                  action === 'restore'
                    ? 'Why is this entrant returning?'
                    : 'Arrived late / unable to stay'
                }
                required={action === 'restore'}
              />
            </label>
            <Button
              type="submit"
              disabled={!playerId || (action === 'restore' && !reason.trim())}
              onClick={() => {
                setPreview(null);
                void inspect({
                  planId,
                  requestId: crypto.randomUUID(),
                  action,
                  playerId,
                  reason,
                  ...(action === 'add' ? { division } : {}),
                });
              }}
            >
              Preview attendance change
            </Button>
          </>
        )}
      </fieldset>
      {action === 'substitute' && doublesPoolWorkflow && (
        <DoublesSubstitutionForm data={data} disabled={disabled} callDesk={callDesk} />
      )}
      {action === 'late_pair' && doublesPoolWorkflow && (
        <LateDoublesPairForm data={data} disabled={disabled} callDesk={callDesk} />
      )}
      {search.isError && <p role="alert">{search.error.message}</p>}
      {preview && (
        <AttendancePreviewPanel
          preview={preview}
          entrants={data.entrants}
          disabled={busy || disabled}
          callDesk={callDesk}
          headingRef={previewHeading}
          onRefresh={() => void inspect(preview.input, true)}
          onAcknowledge={(externalAcknowledged) => setPreview({ ...preview, externalAcknowledged })}
          onApprove={(redistributionApproved) => setPreview({ ...preview, redistributionApproved })}
          onApply={() => void apply()}
        />
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {data.plan.liveOwned && (
        <div className="ops-attendance-history">
          <OpsEventHistory data={data} active={historyActive} attendanceOnly onMatch={() => {}} />
        </div>
      )}
    </section>
  );
}

function AttendancePreviewPanel({
  preview,
  entrants,
  disabled,
  callDesk,
  headingRef,
  onRefresh,
  onAcknowledge,
  onApprove,
  onApply,
}: {
  preview: AttendanceReview;
  entrants: Overview['entrants'];
  disabled: boolean;
  callDesk: UntakenCallDesk;
  headingRef: Ref<HTMLHeadingElement>;
  onRefresh: () => void;
  onAcknowledge: (checked: boolean) => void;
  onApprove: (checked: boolean) => void;
  onApply: () => void;
}) {
  const restoring = preview.input.action === 'restore';
  const returnCallIds = preview.result.returnCallMatchIds;
  const callsStillOpen = callDesk.calls.some(({ id }) => returnCallIds?.includes(id));
  const apply = (
    <Button
      variant="primary"
      type="submit"
      disabled={disabled || !canApplyAttendance(preview)}
      onClick={onApply}
    >
      Apply this change
    </Button>
  );
  return (
    <div className="ops-attendance-preview">
      <h4 ref={headingRef} tabIndex={-1}>
        {restoring ? 'Restoration preview' : 'Change preview'}
      </h4>
      {preview.input.action === 'add' && preview.result.poolIndex !== null && (
        <p>
          Automatic placement: {preview.result.division} · Pool{' '}
          {String.fromCharCode(65 + preview.result.poolIndex)}
        </p>
      )}
      {!restoring && (
        <p>
          {preview.result.addedMatches} new match(es) · {preview.result.affectedMatches.length}{' '}
          affected existing match(es)
        </p>
      )}
      {returnCallIds && !callsStillOpen ? (
        <p className="muted">Refresh the preview before applying this change.</p>
      ) : (
        preview.result.issues.map((issue) => (
          <p className="error-text" key={issue}>
            {issue}
          </p>
        ))
      )}
      {returnCallIds && (
        <UntakenCallRecovery matchIds={returnCallIds} desk={callDesk} showInstructions={false} />
      )}
      {!restoring &&
        preview.result.warnings.map((warning) => (
          <p className="muted" key={warning}>
            {warning}
          </p>
        ))}
      {preview.result.allowed && preview.result.restoration && (
        <RestorationConsequences
          impact={preview.result.restoration}
          warnings={preview.result.warnings}
        />
      )}
      {!restoring && preview.result.affectedMatches.length > 0 && (
        <ul>
          {preview.result.affectedMatches.map((match) => {
            const withdrawal = preview.result.withdrawalMatches?.[match.id];
            const status = withdrawal?.state
              ? withdrawalStatusLabels[withdrawal.state]
              : returnCallIds?.includes(match.id)
                ? 'called'
                : match.status;
            return (
              <li key={match.id}>
                {match.label} · {status}
                {withdrawal?.forfeit === 'automatic' && ' · Forfeit on apply'}
                {withdrawal?.forfeit === 'organiser' && ' · Record forfeit after withdrawal'}
              </li>
            );
          })}
        </ul>
      )}
      {preview.result.relocations.length > 0 && (
        <ul>
          {preview.result.relocations.map((move) => (
            <li key={move.playerId}>
              {entrants.find((p) => p.id === move.playerId)?.name ?? 'Player'}: Pool{' '}
              {String.fromCharCode(65 + move.fromPoolIndex)} → Pool{' '}
              {String.fromCharCode(65 + move.toPoolIndex)}
            </li>
          ))}
        </ul>
      )}
      {preview.result.requiresExternalAcknowledgement && (
        <label className="ops-check">
          <Checkbox
            checked={preview.externalAcknowledged}
            disabled={disabled || !preview.result.allowed}
            onCheckedChange={onAcknowledge}
          />{' '}
          I reconciled this attendance change in the linked Challonge bracket.
        </label>
      )}
      {preview.result.requiresRedistributionApproval && (
        <label className="ops-check">
          <Checkbox
            checked={preview.redistributionApproved}
            disabled={disabled || !preview.result.allowed}
            onCheckedChange={onApprove}
          />{' '}
          I approve moving these players out of the two-player pool.
          {preview.input.action === 'no_show'
            ? ' Leave unchecked to remove the no-show and keep the two-player pool for now.'
            : ''}
        </label>
      )}
      {returnCallIds ? (
        <div className="ops-match-actions">
          <Button disabled={disabled} onClick={onRefresh}>
            Refresh attendance preview
          </Button>
          {apply}
        </div>
      ) : (
        apply
      )}
    </div>
  );
}

function RestorationConsequences({
  impact,
  warnings,
}: {
  impact: NonNullable<Preview['restoration']>;
  warnings: readonly string[];
}) {
  return (
    <section aria-label="Restoration consequences" className="ops-restoration-consequences">
      <p>Restoring attendance keeps the same entrant and recorded outcomes.</p>
      <h5>Qualification</h5>
      <p>{impact.qualification.reason}</p>
      {impact.slots.length > 0 && (
        <p>
          Reserved places:{' '}
          {impact.slots
            .map(
              (slot) =>
                `${slot.division} Pool ${String.fromCharCode(65 + slot.poolIndex)} place ${slot.place} (${slot.status.replaceAll('_', ' ')})`,
            )
            .join('; ')}
          .
        </p>
      )}
      <h5>Matches</h5>
      {warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {impact.effects.length > 0 && (
        <ul>
          {impact.effects.map((effect) => (
            <li key={effect.id}>
              <strong>
                {effect.player1Name} vs {effect.player2Name}
              </strong>{' '}
              · {effect.label}
              <p>{effect.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
