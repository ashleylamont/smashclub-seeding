import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { poolLabel } from '@smashclub/tournament-formats';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { LoadingState, Notice } from '../../components/ui/Feedback';
import { Select, SelectItem } from '../../components/ui/Select';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';
import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';

type Input = Parameters<typeof trpc.eventOps.previewDoublesSubstitution.query>[0];
type Preview = Awaited<ReturnType<typeof trpc.eventOps.previewDoublesSubstitution.query>>;

export function DoublesSubstitutionForm({
  data,
  disabled,
  callDesk,
}: {
  data: Overview;
  disabled: boolean;
  callDesk: UntakenCallDesk;
}) {
  const planId = data.plan.id;
  const cache = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const pairControl = useRef<HTMLButtonElement>(null);
  const [entrantId, setEntrantId] = useState('');
  const [outgoingPlayerId, setOutgoingPlayerId] = useState('');
  const [incomingPlayerId, setIncomingPlayerId] = useState('');
  const [searchText, setSearchText] = useState('');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<{ input: Input; result: Preview; requestId: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const rosterKey = ['eventOps', 'attendeeRoster', planId];
  const roster = useQuery({
    queryKey: rosterKey,
    queryFn: () => trpc.eventOps.attendeeRoster.query({ planId }),
  });
  const search = useQuery({
    queryKey: ['public', 'players', searchText],
    queryFn: () => trpc.public.searchPlayers.query({ query: searchText }),
    enabled: searchText.trim().length > 1,
  });
  const options = data.entrants.filter(
    (e) => !data.withdrawals.some((withdrawal) => withdrawal.playerId === e.id),
  );
  const members = roster.data?.attendees.filter((row) => row.entryId === entrantId) ?? [];
  const enteredIds = new Set(
    data.operatorDispatch?.entrants.flatMap((entrant) => entrant.members.map(({ id }) => id)),
  );
  const candidates = (search.data ?? []).filter((p) => !enteredIds.has(p.id));
  const canReview = entrantId && outgoingPlayerId && incomingPlayerId && reason.trim();

  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);

  useEffect(() => {
    if (message && !busy) pairControl.current?.focus();
  }, [message, busy]);

  function change() {
    setReview(null);
    setError('');
    setMessage('');
  }

  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canReview || busy || disabled) return;
    change();
    setBusy(true);
    const input = { planId, entrantId, outgoingPlayerId, incomingPlayerId, reason: reason.trim() };
    try {
      const result = await trpc.eventOps.previewDoublesSubstitution.query(input);
      setReview({ input, result, requestId: crypto.randomUUID() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not review substitution.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!review?.result.allowed || busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await trpc.eventOps.applyDoublesSubstitution.mutate({
        ...review.input,
        requestId: review.requestId,
        revisionToken: review.result.revisionToken,
      });
      setReview(null);
      setOutgoingPlayerId('');
      setIncomingPlayerId('');
      setSearchText('');
      setReason('');
      setMessage('Substitute confirmed. The pair keeps its pool, seed and match schedule.');
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['eventOps', planId] }),
        cache.invalidateQueries({ queryKey: rosterKey }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm substitution.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void inspect(event)}>
      <p className="muted">
        Replace one player in an unplayed pair without moving the pair’s slot.
      </p>
      <fieldset disabled={disabled || busy} className="ops-attendance-fields">
        <label>
          Pair
          <Select
            ref={pairControl}
            value={entrantId}
            onValueChange={(value) => {
              setEntrantId(value);
              setOutgoingPlayerId('');
              change();
            }}
          >
            <SelectItem value="">Choose a pair</SelectItem>
            {options.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </Select>
        </label>
        <label>
          Player to replace
          <Select
            value={outgoingPlayerId}
            disabled={!members.length}
            onValueChange={(value) => {
              setOutgoingPlayerId(value);
              change();
            }}
          >
            <SelectItem value="">Choose a member</SelectItem>
            {members.map((player) => (
              <SelectItem key={player.playerId} value={player.playerId}>
                {player.publicAlias}
              </SelectItem>
            ))}
          </Select>
        </label>
        <Field
          label="Find a registered substitute by alias"
          value={searchText}
          onChange={(event) => {
            setSearchText(event.target.value);
            setIncomingPlayerId('');
            change();
          }}
          maxLength={100}
        />
        <label>
          Substitute
          <Select
            value={incomingPlayerId}
            disabled={!candidates.length}
            onValueChange={(value) => {
              setIncomingPlayerId(value);
              change();
            }}
          >
            <SelectItem value="">Choose a substitute</SelectItem>
            {candidates.map((player) => (
              <SelectItem key={player.id} value={player.id}>
                {player.name}
              </SelectItem>
            ))}
          </Select>
        </label>
        <Field
          label="Reason for substitution"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            change();
          }}
          maxLength={200}
          required
        />
        <Button type="submit" disabled={!canReview || busy}>
          {review ? 'Refresh substitution preview' : 'Preview substitution'}
        </Button>
      </fieldset>
      {(roster.isPending || (search.isFetching && searchText.trim().length > 1)) && (
        <LoadingState />
      )}
      {(roster.error || search.error) && (
        <Notice tone="danger">{(roster.error ?? search.error)?.message}</Notice>
      )}
      {search.data && candidates.length === 0 && (
        <p className="muted">No available registered players match this search.</p>
      )}
      {review && (
        <div className="ops-attendance-preview">
          <h4 ref={heading} tabIndex={-1}>
            Substitution preview
          </h4>
          {review.result.oldMembers && review.result.newMembers && (
            <dl className="ops-substitution-pairs">
              <div>
                <dt>Current pair</dt>
                <dd>{review.result.oldMembers.join(' / ')}</dd>
              </div>
              <div>
                <dt>Substitute pair</dt>
                <dd>{review.result.newMembers.join(' / ')}</dd>
              </div>
            </dl>
          )}
          {review.result.poolIndex !== null && (
            <p>
              {data.plan.structure === 'dual_division' &&
                (review.result.division === 'upper' ? 'Upper · ' : 'Lower · ')}
              Pool {poolLabel(review.result.poolIndex)} · Seed {review.result.seed} ·{' '}
              {review.result.affectedMatchCount} affected matches
            </p>
          )}
          {review.result.issues.map((issue) => (
            <p className="error-text" key={issue}>
              {issue}
            </p>
          ))}
          <UntakenCallRecovery
            matchIds={review.result.returnCallMatchIds}
            desk={callDesk}
            showInstructions={false}
          />
          {review.result.allowed && (
            <div className="ops-substitution-confirm">
              <p>The schedule and recorded results stay in place.</p>
              {data.plan.structure !== 'round_robin' && (
                <p className="muted">
                  Later finals seeding uses the default strength for the substitute pair.
                </p>
              )}
              <Button variant="primary" disabled={disabled || busy} onClick={() => void apply()}>
                Confirm substitute
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
    </form>
  );
}
