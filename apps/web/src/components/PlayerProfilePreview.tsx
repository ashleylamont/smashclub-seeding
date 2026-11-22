import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { CharacterIcons } from './CharacterIcons';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { LoadingState, Notice } from './ui/Feedback';
import './PlayerProfilePreview.css';

export function PlayerProfilePreview({ playerId, name }: { playerId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['playerPreview', playerId],
    queryFn: ({ signal }) => trpc.public.playerPreview.query({ playerId }, { signal }),
    enabled: open,
    retry: false,
  });
  const data = query.data;
  const profile = data?.profile;
  const redirectTo = data?.redirectTo;

  return (
    <Dialog
      title={profile?.name ?? name}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="small" aria-label={`Preview ${name}`}>
          Preview
        </Button>
      }
    >
      {query.isPending && <LoadingState>Loading player preview…</LoadingState>}
      {query.isError && <Notice tone="danger">The player preview could not be loaded.</Notice>}
      {redirectTo && <p className="muted">This profile has moved.</p>}
      {data === null && <p className="muted">Public profile unavailable.</p>}
      {profile && (
        <dl className="player-profile-preview">
          <div>
            <dt>Club rating</dt>
            <dd>
              {profile.rating ? (
                <>
                  <span className="num">{profile.rating.clubRating.toFixed(0)}</span>
                  {profile.rating.isProvisional && <span className="chip">Provisional</span>}
                </>
              ) : (
                'Unrated'
              )}
            </dd>
          </div>
          <div>
            <dt>Rated sets (W–L)</dt>
            <dd>
              {profile.rating ? (
                <span className="num">
                  {profile.rating.wins}–{profile.rating.losses}
                </span>
              ) : (
                'No rated sets'
              )}
            </dd>
          </div>
          <div>
            <dt>Mains</dt>
            <dd>
              {profile.characters.length ? (
                <CharacterIcons slugs={profile.characters} size="lg" loading="eager" />
              ) : (
                'No mains listed'
              )}
            </dd>
          </div>
        </dl>
      )}
      <div className="modal-actions">
        {query.isError && <Button onClick={() => void query.refetch()}>Retry preview</Button>}
        <Button asChild>
          <Link to="/players/$playerId" params={{ playerId: redirectTo ?? playerId }}>
            View full profile
          </Link>
        </Button>
      </div>
    </Dialog>
  );
}
