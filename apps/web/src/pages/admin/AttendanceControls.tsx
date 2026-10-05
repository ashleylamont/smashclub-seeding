import { Select, SelectItem } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Checkbox } from '../../components/ui/Checkbox';
import { Button } from '../../components/ui/Button';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Preview = Awaited<ReturnType<typeof trpc.eventOps.previewAttendance.query>>;
type Input = {
  planId: string;
  action: 'add' | 'withdraw' | 'no_show' | 'redistribute';
  playerId: string;
  division?: 'upper' | 'lower';
  reason?: string;
  acknowledgeExternalChange?: boolean;
  approveRedistribution?: boolean;
};

export function AttendanceControls({
  planId,
  data,
  disabled,
}: {
  planId: string;
  data: Overview;
  disabled: boolean;
}) {
  const cache = useQueryClient();
  const [action, setAction] = useState<'add' | 'withdraw' | 'no_show' | 'redistribute'>('add');
  const [query, setQuery] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [division, setDivision] = useState<'upper' | 'lower'>('upper');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [approve, setApprove] = useState(false);
  const [preview, setPreview] = useState<{ result: Preview; input: Input } | null>(null);
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
    setApprove(false);
    setMessage('');
    setError('');
  };
  const inspect = async () => {
    const input: Input = {
      planId,
      action,
      playerId,
      reason,
      acknowledgeExternalChange: ack,
      ...(action === 'add' ? { division } : {}),
    };
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setPreview({ input, result: await trpc.eventOps.previewAttendance.query(input) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not preview change');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      await trpc.eventOps.applyAttendance.mutate({
        ...preview.input,
        approveRedistribution: approve,
        revisionToken: preview.result.revisionToken,
      });
      setPreview(null);
      setApprove(false);
      setPlayerId('');
      setMessage(
        'Attendance updated. Refresh the match queue to see the current pools and matches.',
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
      <h3>Late arrivals and no-shows</h3>
      <p className="muted">
        {data.plan.softLockedAt
          ? 'Late arrivals go to the smallest open pool in their division. A no-show leaves their pool; played entrants use withdrawal instead.'
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
              setPlayerId('');
              changed();
            }}
          >
            <SelectItem value="add">Add a late arrival</SelectItem>
            <SelectItem value="no_show">Remove a no-show</SelectItem>
            <SelectItem value="redistribute">Redistribute a two-player pool</SelectItem>
            <SelectItem value="withdraw">Withdraw an entrant after play</SelectItem>
          </Select>
        </label>
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
          Player
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
              : data.entrants.filter(
                  (player) => !data.withdrawals.some((row) => row.playerId === player.id),
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
            placeholder="Arrived late / unable to stay"
          />
        </label>
        <label className="ops-check">
          <Checkbox
            checked={ack}
            onCheckedChange={(nextChecked) => {
              setAck(nextChecked);
              changed();
            }}
          />{' '}
          I have reconciled the attendance change in any attached Challonge bracket.
        </label>
        <Button type="submit" disabled={!playerId} onClick={() => void inspect()}>
          Preview attendance change
        </Button>
      </fieldset>
      {search.isError && <p role="alert">{search.error.message}</p>}
      {preview && (
        <div className="ops-attendance-preview">
          <h4>Change preview</h4>
          {preview.input.action === 'add' && preview.result.poolIndex !== null && (
            <p>
              Automatic placement: {preview.result.division} · Pool{' '}
              {String.fromCharCode(65 + preview.result.poolIndex)}
            </p>
          )}
          <p>
            {preview.result.addedMatches} new match(es) · {preview.result.affectedMatches.length}{' '}
            affected existing match(es)
          </p>
          {preview.result.issues.map((issue) => (
            <p className="error-text" key={issue}>
              {issue}
            </p>
          ))}
          {preview.result.warnings.map((warning) => (
            <p className="muted" key={warning}>
              {warning}
            </p>
          ))}
          {preview.result.affectedMatches.length > 0 && (
            <ul>
              {preview.result.affectedMatches.map((match) => (
                <li key={match.id}>
                  {match.label} · {match.status}
                </li>
              ))}
            </ul>
          )}
          {preview.result.relocations.length > 0 && (
            <ul>
              {preview.result.relocations.map((move) => (
                <li key={move.playerId}>
                  {data.entrants.find((p) => p.id === move.playerId)?.name ?? 'Player'}: Pool{' '}
                  {String.fromCharCode(65 + move.fromPoolIndex)} → Pool{' '}
                  {String.fromCharCode(65 + move.toPoolIndex)}
                </li>
              ))}
            </ul>
          )}
          {preview.result.requiresRedistributionApproval && (
            <label className="ops-check">
              <Checkbox checked={approve} onCheckedChange={setApprove} /> I approve moving these
              players out of the two-player pool.
              {preview.input.action === 'no_show'
                ? ' Leave unchecked to remove the no-show and keep the two-player pool for now.'
                : ''}
            </label>
          )}
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy ||
              disabled ||
              !preview.result.allowed ||
              (preview.input.action === 'redistribute' && !approve)
            }
            onClick={() => void apply()}
          >
            Apply this change
          </Button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
