import { useId, useState } from 'react';
import { Switch } from './ui/Switch';
import { Notice } from './ui/Feedback';
import { includesPlayer, matchStation } from '../lib/playerMatchView';
import type { PublicEventSnapshot } from '../lib/usePlayerEventHub';

const preferenceKey = 'smashclub:player-call-alerts';

type Call = {
  sequence: number;
  matchId: string;
  player1Id: string;
  player2Id: string;
  opponent: string;
  location: string;
};

type CallStatus = 'called' | 'returned' | 'cancelled';
type CallNotice = { call: Call; status: CallStatus };
type Observation = { version: number; call?: Call; notice?: CallNotice };

function currentCall(data: PublicEventSnapshot, player: string, version: number): Call | undefined {
  const match = data.matches.find(
    (row) =>
      row.status === 'playing' &&
      row.called &&
      !row.started &&
      row.callSequence !== undefined &&
      row.callSequence <= version &&
      includesPlayer(row, player),
  );
  if (!match?.player1Id || !match.player2Id || match.callSequence === undefined) return;
  const firstSide = match.player1Id === player || match.player1MemberIds?.includes(player);
  const opponent = firstSide ? match.player2Name : match.player1Name;
  const location = matchStation(data, match).name;
  if (!opponent || !location) return;
  return {
    sequence: match.callSequence,
    matchId: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    opponent,
    location,
  };
}

function observe(
  data: PublicEventSnapshot,
  player: string,
  previous: Observation | null,
): Observation | null {
  const version = data.callSnapshotVersion;
  if (version === undefined || (previous && version < previous.version)) return previous;
  const call = currentCall(data, player, version);
  if (!previous) return { version, call };

  // A snapshot's committed version covers older calls, including any missed
  // during a reload or excluded from the currently selected player's view.
  if (call && call.sequence > previous.version)
    return { version, call, notice: { call, status: 'called' } };

  const notice = previous.notice;
  if (call) {
    // Edits to public call details are shown in the match list. Replacing the
    // message in the live region would announce that same call a second time.
    const unchanged =
      notice?.status === 'called' &&
      call.sequence === notice.call.sequence &&
      call.opponent === notice.call.opponent &&
      call.location === notice.call.location &&
      call.player1Id === notice.call.player1Id &&
      call.player2Id === notice.call.player2Id;
    return { version, call, notice: unchanged ? notice : undefined };
  }

  const formerCall = previous.call ?? notice?.call;
  if (formerCall) {
    const match = data.matches.find(
      (row) =>
        row.id === formerCall.matchId &&
        row.player1Id === formerCall.player1Id &&
        row.player2Id === formerCall.player2Id,
    );
    if (match?.status === 'ready')
      return { version, notice: { call: formerCall, status: 'returned' } };
    if (match?.status === 'blocked')
      return { version, notice: { call: formerCall, status: 'cancelled' } };
  }
  return { version };
}

export function PlayerCallAlerts({
  data,
  player,
  connected,
  playOpen,
}: {
  data: PublicEventSnapshot;
  player: string;
  connected: boolean;
  playOpen: boolean;
}) {
  const scope = JSON.stringify([data.plan.id, player]);
  const [enabled, setEnabled] = useState(() => {
    try {
      return sessionStorage.getItem(preferenceKey) === scope;
    } catch {
      return false;
    }
  });
  const hintId = useId();
  const active = enabled && playOpen;
  const source = active && connected ? data : null;
  const [record, setRecord] = useState<{
    source: typeof source;
    active: boolean;
    observation: Observation | null;
  }>();
  if (record?.source !== source || record.active !== active) {
    const previous = record?.observation ?? null;
    let observation: Observation | null = null;
    if (active)
      observation = source
        ? observe(source, player, previous)
        : previous && { ...previous, notice: undefined };
    setRecord({ source, active, observation });
  }

  const toggle = (checked: boolean) => {
    setEnabled(checked);
    try {
      if (checked) sessionStorage.setItem(preferenceKey, scope);
      else if (sessionStorage.getItem(preferenceKey) === scope)
        sessionStorage.removeItem(preferenceKey);
    } catch {
      // The current page can still announce calls when storage is unavailable.
    }
  };

  const notice = active && source ? record?.observation?.notice : undefined;
  return (
    <div className="player-call-alerts">
      <label className="ui-actions">
        <Switch checked={enabled} onCheckedChange={toggle} aria-describedby={hintId} />
        Match call alerts
      </label>
      <p className="muted" id={hintId}>
        Show new calls for this player while this page is open.
      </p>
      <div
        role="status"
        aria-label="Player call announcements"
        aria-live="polite"
        aria-atomic="true"
      >
        {notice && (
          <Notice live={false} key={notice.call.sequence}>
            {notice.status === 'called' ? (
              <>
                <strong>Match called.</strong>{' '}
                {`Play ${notice.call.opponent} at ${notice.call.location}.`}
              </>
            ) : notice.status === 'returned' ? (
              <>
                <strong>Call returned to the queue.</strong> Wait for a new call.
              </>
            ) : (
              <>
                <strong>Call cancelled.</strong> Check your match status for updates.
              </>
            )}
          </Notice>
        )}
      </div>
    </div>
  );
}
