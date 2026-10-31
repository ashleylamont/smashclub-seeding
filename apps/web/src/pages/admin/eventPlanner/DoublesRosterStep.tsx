import { Checkbox } from '../../../components/ui/Checkbox';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type TournamentStructure } from '@smashclub/shared';
import { trpc } from '../../../lib/trpc';
import type { EventPlanView } from '../../../lib/apiTypes';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select, SelectItem } from '../../../components/ui/Select';
import { PlayerLookupModal } from '../../../components/PlayerLookupModal';
import { IssueList } from './shared';
import { PairRatingEvidence } from './PairRatingEvidence';

type PairSort = 'roster' | 'skill_desc' | 'skill_asc' | 'seed_desc';

export function DoublesRosterStep({
  view,
  onChanged,
}: {
  view: EventPlanView;
  onChanged: () => void;
}) {
  const [first, setFirst] = useState(''),
    [second, setSecond] = useState(''),
    [teamName, setTeamName] = useState('');
  const [picking, setPicking] = useState<1 | 2 | null>(null);
  const [sort, setSort] = useState<PairSort>('roster');
  const players = useQuery({
    queryKey: ['admin', 'players'],
    queryFn: () => trpc.admin.players.query(),
  });
  const name = (id: string) =>
    players.data?.find((p) => p.id === id)?.canonicalName ?? 'Choose player';
  const planId = view.plan.id,
    editable = view.plan.status === 'draft';
  const add = useMutation({
    mutationFn: () =>
      trpc.admin.eventPlanner.addDoublesPair.mutate({
        planId,
        playerId: first,
        partnerPlayerId: second,
        teamName: teamName.trim() || null,
      }),
    onSuccess: () => {
      setFirst('');
      setSecond('');
      setTeamName('');
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: (entryId: string) =>
      trpc.admin.eventPlanner.removeEntry.mutate({ planId, entryId }),
    onSuccess: onChanged,
  });
  const pin = useMutation({
    mutationFn: ({
      entryId,
      divisionPreference,
    }: {
      entryId: string;
      divisionPreference: 'auto' | 'upper' | 'lower';
    }) => trpc.admin.eventPlanner.updateEntry.mutate({ planId, entryId, divisionPreference }),
    onSuccess: onChanged,
  });
  const freeze = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.freezeRoster.mutate({ planId }),
    onSuccess: onChanged,
  });
  const reopen = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.unfreezeRoster.mutate({ planId }),
    onSuccess: onChanged,
  });
  const format = useMutation({
    mutationFn: ({
      structure,
      usePairRatings,
    }: {
      structure: TournamentStructure;
      usePairRatings?: boolean;
    }) => trpc.admin.eventPlanner.updateNativeFormat.mutate({ planId, structure, usePairRatings }),
    onSuccess: onChanged,
  });
  const errors = [add, remove, pin, freeze, reopen, format].filter((m) => m.isError);
  const displayedEntries = [...view.entries].sort((a, b) => {
    const skill = (e: (typeof view.entries)[number]) => e.snapshotMean ?? e.currentMean ?? 1500;
    const seed = (e: (typeof view.entries)[number]) => e.snapshotScore ?? e.currentScore ?? 0;
    const difference =
      sort === 'skill_desc'
        ? skill(b) - skill(a)
        : sort === 'skill_asc'
          ? skill(a) - skill(b)
          : sort === 'seed_desc'
            ? seed(b) - seed(a)
            : 0;
    return difference || a.sourceLineNumber - b.sourceLineNumber;
  });
  return (
    <section className="card section">
      <h3>
        Doubles roster · {view.entries.length} teams / {view.entries.length * 2} players
      </h3>
      <p>
        Each person can enter once. Pairs are fixed when the pool draw is locked. A missing partner
        holds the pair until they return or a TO records a withdrawal.
      </p>
      <p className="muted">
        Seeding score = skill − 2 × SD. New pairs have a zero mean adjustment, but added pair
        uncertainty can lower their seeding score. Only earlier finalized doubles nights supply pair
        evidence.
      </p>
      {editable && (
        <>
          {view.plan.structure === 'dual_division' && (
            <p className="muted">
              Teams split evenly between Upper and Lower; review and reorder the frozen seeds before
              generating pools.
            </p>
          )}
          <label>
            <Checkbox
              checked={view.plan.usePairRatings ?? false}
              disabled={format.isPending}
              onCheckedChange={(checked) =>
                format.mutate({
                  structure: view.plan.structure ?? 'dual_division',
                  usePairRatings: checked,
                })
              }
            />{' '}
            Include experimental WHR pair adjustments in seeds
          </label>
          <p className="muted">
            With the model off, seeds use average singles skill and uncertainty. With it on, they
            also include the pair’s mean adjustment and uncertainty.
          </p>
          <div className="admin-form-row">
            <Button onClick={() => setPicking(1)}>
              {first ? name(first) : 'Choose first player'}
            </Button>
            <Button onClick={() => setPicking(2)}>
              {second ? name(second) : 'Choose partner'}
            </Button>
            <Input
              aria-label="Team name"
              placeholder="Team name (optional)"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              maxLength={60}
            />
            <Button
              disabled={!first || !second || first === second || add.isPending}
              onClick={() => add.mutate()}
            >
              Add pair
            </Button>
          </div>
        </>
      )}
      {picking && (
        <PlayerLookupModal
          title={picking === 1 ? 'Choose first player' : 'Choose partner'}
          onCancel={() => setPicking(null)}
          onPick={(id) => {
            if (picking === 1) setFirst(id);
            else setSecond(id);
            setPicking(null);
          }}
        />
      )}
      <label className="admin-form-row">
        Sort pairs
        <Select
          aria-label="Sort pairs"
          value={sort}
          onValueChange={(value) => setSort(value as PairSort)}
        >
          <SelectItem value="roster">Roster order</SelectItem>
          <SelectItem value="skill_desc">Skill: highest first</SelectItem>
          <SelectItem value="skill_asc">Skill: lowest first</SelectItem>
          <SelectItem value="seed_desc">Seeding score: highest first</SelectItem>
        </Select>
      </label>
      <p className="muted">Sorting changes this view only; it does not change saved seeds.</p>
      <div className="table-scroll" role="region" aria-label="Pair ratings" tabIndex={0}>
        <table className="pair-rating-table">
          <thead>
            <tr>
              <th>Pair</th>
              <th>Skill ± SD</th>
              <th>Seeding score</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {displayedEntries.map((e) => (
              <tr key={e.id}>
                <td>
                  {e.playerName}
                  {e.teamName && <> · {e.teamName}</>}
                  <PairRatingEvidence entry={e} />
                  {editable && view.plan.structure === 'dual_division' && (
                    <Select
                      aria-label={`Division preference for ${e.playerName}`}
                      value={e.divisionPreference}
                      onValueChange={(value) =>
                        pin.mutate({
                          entryId: e.id,
                          divisionPreference: value as 'auto' | 'upper' | 'lower',
                        })
                      }
                    >
                      <SelectItem value="auto">Automatic division</SelectItem>
                      <SelectItem value="upper">Pin to Upper</SelectItem>
                      <SelectItem value="lower">Pin to Lower</SelectItem>
                    </Select>
                  )}
                </td>
                <td>
                  {Math.round(e.snapshotMean ?? e.currentMean ?? 1500)} ±{' '}
                  {Math.round(e.snapshotSd ?? e.currentSd ?? 0)}
                </td>
                <td>{Math.round(e.snapshotScore ?? e.currentScore ?? 0)}</td>
                <td>
                  {editable && (
                    <Button
                      size="small"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(e.id)}
                    >
                      Remove pair
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <>
          <IssueList issues={view.issues.blocking} kind="blocking" />
          <Button
            variant="primary"
            disabled={Boolean(view.issues.blocking.length) || freeze.isPending || format.isPending}
            onClick={() => freeze.mutate()}
          >
            Freeze team seeds
          </Button>
        </>
      )}
      {!editable &&
        !view.plan.softLockedAt &&
        ['roster_frozen', 'pools_ready'].includes(view.plan.status) && (
          <Button disabled={reopen.isPending} onClick={() => reopen.mutate()}>
            Reopen roster
          </Button>
        )}
      {errors.map((m, i) => (
        <p key={i} role="alert" className="error-text">
          {m.error?.message}
        </p>
      ))}
    </section>
  );
}
