import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { CharacterPicker } from './CharacterPicker';
import { Button } from './ui/Button';
import { LoadingState, Notice } from './ui/Feedback';
import { Field } from './ui/Field';
import { Input } from './ui/Input';
import type { MyClaim } from '../lib/apiTypes';
import { useMyClaims } from '../lib/auth';
import { formatDate } from '../lib/format';
import { mainCharactersAnchor } from '../lib/profileClaim';
import { trpc } from '../lib/trpc';

export function ProfileClaimSection({ userId, targetId }: { userId: string; targetId?: string }) {
  const queryClient = useQueryClient();
  const claims = useMyClaims(userId);
  const hash = useLocation({ select: (location) => location.hash });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['me', 'claims'] });
    void queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
    void queryClient.invalidateQueries({ queryKey: ['player'] });
  };

  if (claims.isPending) return <LoadingState>Loading player profile…</LoadingState>;
  if (claims.isError)
    return (
      <section className="card player-claim" aria-label="Player profile">
        <Notice tone="danger">Could not load your claims. {claims.error.message}</Notice>
        <Button onClick={() => void claims.refetch()} pending={claims.isFetching}>
          Retry loading claims
        </Button>
      </section>
    );

  const liveClaim =
    claims.data.find((c) => c.status === 'pending' || c.status === 'approved') ?? null;
  const pastClaims = claims.data.filter((c) => c !== liveClaim);
  const targetMismatch = Boolean(liveClaim && targetId && targetId !== liveClaim.playerId);

  return (
    <section className="card player-claim" aria-labelledby="player-claim-heading">
      <h2 id="player-claim-heading">Player profile</h2>
      {targetMismatch && (
        <Notice>
          This account already has a claim for a different player. Its current claim is shown below.
        </Notice>
      )}
      {liveClaim ? (
        <LiveClaim
          key={liveClaim.id}
          claim={liveClaim}
          editorAnchor={targetMismatch ? undefined : mainCharactersAnchor}
          focusCharacters={!targetMismatch && hash === mainCharactersAnchor}
          onChanged={invalidate}
          onCheck={() => void claims.refetch()}
          checking={claims.isFetching}
        />
      ) : (
        <ClaimSearch key={targetId ?? 'search'} targetId={targetId} onChanged={invalidate} />
      )}
      {pastClaims.length > 0 && (
        <div className="claim-history">
          <h3>Claim history</h3>
          <ul className="claim-search-results">
            {pastClaims.map((c) => (
              <li key={c.id}>
                <span>
                  {c.playerName} <span className="muted">({formatDate(c.createdAt)})</span>
                </span>
                <span className="chip">{c.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function LiveClaim({
  claim,
  editorAnchor,
  focusCharacters,
  onChanged,
  onCheck,
  checking,
}: {
  claim: MyClaim;
  editorAnchor?: string;
  focusCharacters: boolean;
  onChanged: () => void;
  onCheck: () => void;
  checking: boolean;
}) {
  const withdraw = useMutation({
    mutationFn: () => trpc.me.withdrawClaim.mutate({ claimId: claim.id }),
    onSuccess: onChanged,
  });

  return (
    <div>
      <div className="claim-status">
        <span>
          {claim.status === 'approved' ? 'Linked player' : 'Claim requested for'}{' '}
          <Link to="/players/$playerId" params={{ playerId: claim.playerId }}>
            <strong>{claim.playerName}</strong>
          </Link>
          {claim.companyCode ? ` (${claim.companyCode})` : ''}
        </span>
        <span className="chip">
          {claim.status === 'approved' ? '✓ approved' : 'pending review'}
        </span>
      </div>
      {claim.status === 'pending' && (
        <p>An administrator must approve your claim before you can edit this player profile.</p>
      )}
      {claim.note && <p className="muted">Note: {claim.note}</p>}
      <div className="claim-actions">
        {claim.status === 'approved' ? (
          <Button asChild variant="primary">
            <Link to="/me" search={{ claim: claim.playerId }} hash={mainCharactersAnchor}>
              Edit main characters
            </Link>
          </Button>
        ) : (
          <Button onClick={onCheck} pending={checking}>
            Check approval
          </Button>
        )}
        <Button variant="danger" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>
          {claim.status === 'approved' ? 'Unlink profile' : 'Withdraw request'}
        </Button>
      </div>
      {withdraw.isError && <Notice tone="danger">{withdraw.error.message}</Notice>}
      {claim.status === 'approved' && (
        <ProfileEditor
          claim={claim}
          editorAnchor={editorAnchor}
          focusCharacters={focusCharacters}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/**
 * Self-service profile editing for an approved claimant. Both fields are the
 * player's own to set — an admin should not be the bottleneck on someone
 * changing their tag or switching mains.
 */
function ProfileEditor({
  claim,
  editorAnchor,
  focusCharacters,
  onChanged,
}: {
  claim: MyClaim;
  editorAnchor?: string;
  focusCharacters: boolean;
  onChanged: () => void;
}) {
  const mainHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusCharacters) {
      mainHeading.current?.focus({ preventScroll: true });
      mainHeading.current?.scrollIntoView({ block: 'start' });
    }
  }, [focusCharacters]);
  const [displayName, setDisplayName] = useState(claim.displayName ?? '');
  const [characters, setCharacters] = useState<string[]>(claim.characters);

  const updateName = useMutation({
    mutationFn: (name: string | null) =>
      trpc.me.updateDisplayName.mutate({ playerId: claim.playerId, displayName: name }),
    onSuccess: onChanged,
  });

  const updateCharacters = useMutation({
    mutationFn: (slugs: string[]) =>
      trpc.me.updateCharacters.mutate({ playerId: claim.playerId, characters: slugs }),
    onSuccess: onChanged,
  });

  const dirtyCharacters = characters.join(',') !== claim.characters.join(',');

  return (
    <section className="profile-editor" aria-label="Edit player profile">
      <div className="display-name-row">
        <label htmlFor="display-name" className="muted">
          Public alias
        </label>
        <Input
          id="display-name"
          value={displayName}
          placeholder={claim.defaultAlias}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <Button
          size="small"
          type="button"
          disabled={updateName.isPending}
          onClick={() => updateName.mutate(displayName.trim() === '' ? null : displayName.trim())}
        >
          Save alias
        </Button>
        {updateName.isSuccess && (
          <span className="chip" role="status">
            Saved
          </span>
        )}
        {updateName.isError && <span className="error-text">{updateName.error.message}</span>}
      </div>
      <p className="muted">
        The name shown on the leaderboard. Leave it blank to go by “{claim.defaultAlias}”.
      </p>

      <div className="character-editor">
        <div className="display-name-row">
          <h3 id={editorAnchor} ref={mainHeading} tabIndex={-1}>
            Main characters
          </h3>
          <Button
            size="small"
            type="button"
            disabled={!dirtyCharacters || updateCharacters.isPending}
            onClick={() => updateCharacters.mutate(characters)}
          >
            Save characters
          </Button>
          {updateCharacters.isSuccess && !dirtyCharacters && (
            <span className="chip" role="status">
              Saved
            </span>
          )}
          {updateCharacters.isError && (
            <span className="error-text">{updateCharacters.error.message}</span>
          )}
        </div>
        <CharacterPicker value={characters} onChange={setCharacters} />
      </div>
    </section>
  );
}

function ClaimSearch({ targetId, onChanged }: { targetId?: string; onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const trimmed = query.trim();
  const target = useQuery({
    queryKey: ['player', targetId],
    queryFn: () => trpc.public.player.query({ playerId: targetId! }),
    enabled: Boolean(targetId),
  });
  const selected = target.data && 'player' in target.data ? target.data.player : null;

  const search = useQuery({
    queryKey: ['searchPlayers', trimmed],
    queryFn: () => trpc.public.searchPlayers.query({ query: trimmed }),
    enabled: trimmed.length >= 1,
  });

  const request = useMutation({
    mutationFn: (playerId: string) =>
      trpc.me.requestClaim.mutate({ playerId, note: note.trim() === '' ? undefined : note.trim() }),
    onSuccess: onChanged,
  });

  const noteField = (
    <Field
      label="Note for administrators (optional)"
      value={note}
      maxLength={500}
      onChange={(event) => setNote(event.target.value)}
    />
  );
  const requestError = request.isError && <Notice tone="danger">{request.error.message}</Notice>;

  if (targetId && target.isPending)
    return <LoadingState>Finding the selected player…</LoadingState>;
  if (selected && !selected.verified)
    return (
      <div className="claim-flow">
        <p>
          Request a claim for{' '}
          <Link to="/players/$playerId" params={{ playerId: selected.id }}>
            <strong>{selected.name}</strong>
          </Link>
          {selected.companyCode ? ` (${selected.companyCode})` : ''}. An administrator reviews your
          request before you can edit this profile.
        </p>
        {noteField}
        {requestError}
        <div className="claim-actions">
          <Button
            variant="primary"
            pending={request.isPending}
            onClick={() => request.mutate(selected.id)}
          >
            Request claim
          </Button>
          <Link to="/me" search={{}}>
            Find a different player
          </Link>
        </div>
      </div>
    );

  return (
    <div className="claim-flow">
      {targetId && (
        <Notice>
          {selected?.verified
            ? 'This profile is already linked. If it is yours, sign in with the account you linked before.'
            : 'The selected profile is unavailable. You can search for your current player profile below.'}
        </Notice>
      )}
      <p>
        Find your player by the name shown on the leaderboard. An administrator reviews your claim.
      </p>
      <div className="claim-form-row">
        <Field
          label="Search players"
          placeholder="Leaderboard name"
          value={query}
          maxLength={100}
          onChange={(event) => setQuery(event.target.value)}
        />
        {noteField}
      </div>
      {search.isFetching && <LoadingState>Searching…</LoadingState>}
      {search.isError && <Notice tone="danger">{search.error.message}</Notice>}
      {requestError}
      {search.data && search.data.length === 0 && <p className="muted">No players found.</p>}
      {search.data && search.data.length > 0 && (
        <ul className="claim-search-results">
          {search.data.map((player) => (
            <li key={player.id}>
              <span>
                {player.name}
                {player.companyCode ? <span className="muted"> ({player.companyCode})</span> : null}
                {player.verified && <span className="muted"> · Already linked</span>}
              </span>
              <Button
                disabled={player.verified || request.isPending}
                onClick={() => request.mutate(player.id)}
                aria-label={`This is me: ${player.name}`}
              >
                This is me
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
