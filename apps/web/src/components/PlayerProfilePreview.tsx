import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { isUuidPlayerId } from '../lib/playerSelection';
import { CharacterIcons } from './CharacterIcons';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { LoadingState, Notice } from './ui/Feedback';
import './PlayerProfilePreview.css';

export function PlayerProfileName({ playerId, name }: { playerId?: string | null; name: string }) {
  return playerId ? (
    <PlayerProfilePreview key={playerId} playerId={playerId} name={name} trigger="name" />
  ) : (
    name
  );
}

type MemberNames = Readonly<Record<string, string>>;

function publicDoublesMembers(
  name: string,
  entrantId: string | null | undefined,
  memberIds: readonly string[] | undefined,
  names: MemberNames | undefined,
) {
  if (!entrantId || !names || memberIds?.length !== 2) return;
  const [first, second] = memberIds;
  if (!first || !second || first === second) return;
  const [firstMember, secondMember] = [first, second].flatMap((id) => {
    const alias = Object.hasOwn(names, id) ? names[id] : undefined;
    return id !== entrantId && isUuidPlayerId(id) && alias && alias !== 'Player'
      ? [{ playerId: id, name: alias }]
      : [];
  });
  if (!firstMember || !secondMember) return;
  const members = [firstMember, secondMember] as const;

  // The public snapshot supplies member identity separately. Match only the
  // rendered suffix to preserve the optional team label and source fallbacks.
  const pair = members.map((member) => member.name).join(' / ');
  const suffix = ` (${pair})`;
  if (name === pair) return { members, teamName: '' };
  if (name.endsWith(suffix)) return { members, teamName: name.slice(0, -suffix.length) };
}

export function EventEntrantName({
  entrantId,
  name,
  singlesPreview,
  memberIds,
  memberNames,
}: {
  entrantId?: string | null;
  name: string;
  singlesPreview?: boolean;
  memberIds?: readonly string[];
  memberNames?: MemberNames;
}) {
  const doubles = publicDoublesMembers(name, entrantId, memberIds, memberNames);
  if (!doubles)
    return <PlayerProfileName playerId={singlesPreview ? entrantId : null} name={name} />;

  return <DoublesMemberNames {...doubles} />;
}

type DoublesMember = { playerId: string; name: string };

export function DoublesMemberNames({
  teamName,
  members,
}: {
  teamName: string | null;
  members: readonly [DoublesMember, DoublesMember];
}) {
  const [first, second] = members;
  const sameAlias = first.name === second.name;

  return (
    <span className="event-entrant-pair">
      {teamName && <span>{teamName}</span>}
      <span className="event-entrant-members">
        {members.map(({ playerId, name }, index) => (
          <PlayerProfilePreview
            key={playerId}
            playerId={playerId}
            name={name}
            trigger="name"
            teamMemberPosition={sameAlias ? index + 1 : undefined}
          />
        ))}
      </span>
    </span>
  );
}

export function PlayerProfilePreview({
  playerId,
  name,
  trigger = 'button',
  teamMemberPosition,
}: {
  playerId: string;
  name: string;
  trigger?: 'button' | 'name';
  teamMemberPosition?: number;
}) {
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
  const triggerName = teamMemberPosition === undefined ? name : `${name} (${teamMemberPosition})`;

  return (
    <Dialog
      title={profile?.name ?? name}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          size="small"
          variant={trigger === 'name' ? 'plain' : 'default'}
          className={
            trigger === 'name'
              ? 'link-button link-button-target player-profile-preview-name'
              : undefined
          }
          aria-label={`Preview ${triggerName}`}
        >
          {trigger === 'name' ? triggerName : 'Preview'}
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
