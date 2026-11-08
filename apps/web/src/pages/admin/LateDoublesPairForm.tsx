import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { poolLabel } from '@smashclub/tournament-formats';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Feedback';
import { Select, SelectItem } from '../../components/ui/Select';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';
import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';

type Input = Parameters<typeof trpc.eventOps.previewLateDoublesPair.query>[0];
type Preview = Awaited<ReturnType<typeof trpc.eventOps.previewLateDoublesPair.query>>;
type Choice = { query: string; id: string };
const emptyChoice: Choice = { query: '', id: '' };

function PairMemberPicker({
  label,
  choice,
  excluded,
  onChange,
  searchRef,
}: {
  label: string;
  choice: Choice;
  excluded: ReadonlySet<string>;
  onChange: (choice: Choice) => void;
  searchRef?: Ref<HTMLInputElement>;
}) {
  const search = useQuery({
    queryKey: ['public', 'players', choice.query],
    queryFn: () => trpc.public.searchPlayers.query({ query: choice.query }),
    enabled: choice.query.trim().length > 1,
  });
  const candidates = (search.data ?? []).filter((p) => !excluded.has(p.id));
  return (
    <div className="ops-late-pair-player">
      <Field
        ref={searchRef}
        label={`Find ${label.toLowerCase()} by alias`}
        value={choice.query}
        onChange={(event) => onChange({ query: event.target.value, id: '' })}
        maxLength={100}
      />
      <label>
        {label}
        <Select
          value={choice.id}
          disabled={candidates.length === 0}
          onValueChange={(id) => onChange({ ...choice, id })}
        >
          <SelectItem value="">Choose a registered player</SelectItem>
          {candidates.map((player) => (
            <SelectItem key={player.id} value={player.id}>
              {player.name}
            </SelectItem>
          ))}
        </Select>
      </label>
      {search.isError && <Notice tone="danger">{search.error.message}</Notice>}
      {search.data && candidates.length === 0 && (
        <p className="muted">No available registered players match this alias.</p>
      )}
    </div>
  );
}

export function LateDoublesPairForm({
  data,
  disabled,
  callDesk,
}: {
  data: Overview;
  disabled: boolean;
  callDesk: UntakenCallDesk;
}) {
  const planId = data.plan.id;
  const dual = data.plan.structure === 'dual_division';
  const cache = useQueryClient();
  const heading = useRef<HTMLHeadingElement>(null);
  const firstSearch = useRef<HTMLInputElement>(null);
  const [first, setFirst] = useState(emptyChoice);
  const [second, setSecond] = useState(emptyChoice);
  const [division, setDivision] = useState<Input['division'] | ''>(dual ? '' : 'upper');
  const [reason, setReason] = useState('');
  const [review, setReview] = useState<{ input: Input; result: Preview; requestId: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const enteredIds =
    data.operatorDispatch?.entrants.flatMap((entrant) => entrant.members.map(({ id }) => id)) ?? [];
  const canReview = division && first.id && second.id && first.id !== second.id && reason.trim();

  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);
  useEffect(() => {
    if (message && !busy) firstSearch.current?.focus();
  }, [message, busy]);

  function changed() {
    setReview(null);
    setError('');
    setMessage('');
  }

  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canReview || !division || busy || disabled) return;
    changed();
    setBusy(true);
    const input: Input = {
      planId,
      division,
      memberPlayerIds: [first.id, second.id],
      reason: reason.trim(),
    };
    try {
      const result = await trpc.eventOps.previewLateDoublesPair.query(input);
      setReview({ input, result, requestId: crypto.randomUUID() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not review the late pair.');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!review?.result.allowed || review.result.poolIndex === null || busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await trpc.eventOps.applyLateDoublesPair.mutate({
        ...review.input,
        requestId: review.requestId,
        revisionToken: review.result.revisionToken,
      });
      setReview(null);
      setFirst(emptyChoice);
      setSecond(emptyChoice);
      setReason('');
      const { poolIndex, addedMatches } = review.result;
      const divisionName = dual ? (review.result.division === 'upper' ? 'Upper ' : 'Lower ') : '';
      setMessage(
        `Pair added to ${divisionName}Pool ${poolLabel(poolIndex)}. ${addedMatches} sets added after the existing rounds.`,
      );
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['eventOps', planId] }),
        cache.invalidateQueries({ queryKey: ['eventOps', 'attendeeRoster', planId] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm the late pair.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void inspect(event)}>
      <p className="muted">
        Choose two registered players who do not already have a pair in this event.
      </p>
      <fieldset className="ops-attendance-fields" disabled={disabled || busy}>
        <PairMemberPicker
          label="First player"
          choice={first}
          excluded={new Set([...enteredIds, second.id])}
          onChange={(choice) => {
            setFirst(choice);
            changed();
          }}
          searchRef={firstSearch}
        />
        <PairMemberPicker
          label="Second player"
          choice={second}
          excluded={new Set([...enteredIds, first.id])}
          onChange={(choice) => {
            setSecond(choice);
            changed();
          }}
        />
        {dual && (
          <label>
            Division
            <Select
              value={division}
              onValueChange={(value) => {
                setDivision(value as Input['division'] | '');
                changed();
              }}
            >
              <SelectItem value="">Choose a division</SelectItem>
              <SelectItem value="upper">Upper</SelectItem>
              <SelectItem value="lower">Lower</SelectItem>
            </Select>
          </label>
        )}
        <Field
          label="Reason for adding the pair"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            changed();
          }}
          maxLength={200}
          required
        />
        <Button type="submit" disabled={!canReview || busy}>
          {review ? 'Refresh late pair preview' : 'Preview late pair'}
        </Button>
      </fieldset>
      {review && (
        <LatePairPreview
          result={review.result}
          dual={dual}
          callDesk={callDesk}
          heading={heading}
          disabled={disabled || busy}
          onApply={() => void apply()}
        />
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
    </form>
  );
}

function LatePairPreview({
  result,
  dual,
  callDesk,
  heading,
  disabled,
  onApply,
}: {
  result: Preview;
  dual: boolean;
  callDesk: UntakenCallDesk;
  heading: Ref<HTMLHeadingElement>;
  disabled: boolean;
  onApply: () => void;
}) {
  const {
    allowed,
    addedMatches,
    pendingForfeits,
    poolIndex,
    memberNames,
    finals,
    nextSeed,
    totalMatches,
  } = result;
  return (
    <div className="ops-attendance-preview">
      <h4 ref={heading} tabIndex={-1}>
        Late pair preview
      </h4>
      {result.issues.map((issue) => (
        <p className="error-text" key={issue}>
          {issue}
        </p>
      ))}
      <UntakenCallRecovery
        matchIds={result.returnCallMatchIds}
        desk={callDesk}
        showInstructions={false}
      />
      {allowed && poolIndex !== null && (
        <>
          <dl className="ops-attendance-review-facts">
            <div>
              <dt>Pair and placement</dt>
              <dd>{memberNames?.join(' / ')}</dd>
              <dd>
                {dual && (result.division === 'upper' ? 'Upper · ' : 'Lower · ')}
                Pool {poolLabel(poolIndex)} · Seed {nextSeed}
              </dd>
            </div>
            <div>
              <dt>Pool workload</dt>
              <dd>
                {addedMatches} additional sets · {totalMatches} total
              </dd>
              {pendingForfeits > 0 && (
                <dd>
                  {pendingForfeits} {pendingForfeits === 1 ? 'added set needs' : 'added sets need'}{' '}
                  a forfeit decision.
                </dd>
              )}
            </div>
            {finals && (
              <div>
                <dt>Prospective finals places</dt>
                <dd>
                  Championship {finals.championship.before} → {finals.championship.after}
                </dd>
                {Boolean(finals.consolation.before || finals.consolation.after) && (
                  <dd>
                    Consolation {finals.consolation.before} → {finals.consolation.after}
                  </dd>
                )}
              </div>
            )}
          </dl>
          <div className="ops-attendance-confirm">
            <p>Existing seeds and match rounds stay in place.</p>
            <Button variant="primary" disabled={disabled} onClick={onApply}>
              Confirm late pair
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
