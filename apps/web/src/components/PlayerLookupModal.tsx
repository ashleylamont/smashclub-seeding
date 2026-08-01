import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import { searchPlayers } from '../lib/playerSearch';
import './PlayerLookupModal.css';

/**
 * Free-text player lookup for the review queue. The ranked candidate list only
 * ever contains players whose *name* resembles the bracket entry, so a reviewer
 * who knows the person answers to something else entirely — a gamertag, a
 * married name, a bracket handle nobody has aliased yet — previously had no way
 * to say so without leaving the queue to go and add an alias by hand.
 */

interface Props {
  title: string;
  /** Context for the reviewer — which bracket entry they are resolving. */
  children?: ReactNode;
  /** Players already offered as candidates, marked so the list is not confusing. */
  candidatePlayerIds?: readonly string[];
  busy?: boolean;
  error?: string | null;
  onPick: (playerId: string) => void;
  onCancel: () => void;
}

const RESULT_LIMIT = 25;

/** Aliases worth showing: the ones that are not just the names already in the row. */
function otherAliases(player: { canonicalName: string; displayName: string | null; aliases: string[] }): string[] {
  const shown = new Set([player.canonicalName.toLowerCase(), (player.displayName ?? '').toLowerCase()]);
  return player.aliases.filter((alias) => !shown.has(alias.toLowerCase()));
}

export function PlayerLookupModal({
  title,
  children,
  candidatePlayerIds = [],
  busy = false,
  error,
  onPick,
  onCancel,
}: Props) {
  const [query, setQuery] = useState('');

  const players = useQuery({
    queryKey: ['admin', 'players'],
    queryFn: () => trpc.admin.players.query(),
  });

  // Escape closes, matching every other dismissable surface in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const all = useMemo(() => players.data ?? [], [players.data]);
  const results = useMemo(() => searchPlayers(all, query, RESULT_LIMIT), [all, query]);
  const alreadyOffered = new Set(candidatePlayerIds);
  const activeCount = all.filter((player) => player.status === 'active').length;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        {children}

        <input
          className="input lookup-search"
          autoFocus
          placeholder="Search by name, public alias, or any stored alias…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter on a single unambiguous hit is the whole point of typing a
            // name you already know; anything else needs a deliberate click.
            if (event.key === 'Enter' && results.length === 1 && !busy) onPick(results[0]!.player.id);
          }}
        />

        {players.isPending && <p className="loading-text">Loading players…</p>}
        {players.isError && <p className="error-text">{players.error.message}</p>}

        {players.data && results.length === 0 && (
          <p className="muted">No player matches “{query}”. They may need creating instead.</p>
        )}

        {results.length > 0 && (
          <ul className="lookup-list">
            {results.map(({ player, matchedAlias }) => (
              <li key={player.id} className="lookup-row">
                <span className="lookup-name">
                  {player.canonicalName}
                  {player.displayName && <span className="muted"> aka “{player.displayName}”</span>}
                  {player.companyCode && <span className="chip">{player.companyCode}</span>}
                  {alreadyOffered.has(player.id) && <span className="chip chip-warning">already suggested</span>}
                </span>
                <span className="lookup-aliases">
                  {matchedAlias ? (
                    <>
                      matched alias <span className="chip">{matchedAlias}</span>
                    </>
                  ) : (
                    // Only the spellings the row does not already show: nearly
                    // every player is aliased under their own name, and echoing
                    // it back turns the column into noise.
                    otherAliases(player).length > 0 && (
                      <span className="muted">{otherAliases(player).slice(0, 4).join(', ')}</span>
                    )
                  )}
                </span>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => onPick(player.id)}>
                  Link
                </button>
              </li>
            ))}
          </ul>
        )}

        {players.data && results.length === RESULT_LIMIT && activeCount > RESULT_LIMIT && (
          <p className="muted">
            Showing the first {RESULT_LIMIT} of {activeCount} players — keep typing to narrow it down.
          </p>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
