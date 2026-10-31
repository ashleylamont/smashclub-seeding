import { useEffect } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
export { PlayerEvent as GuestEvent } from './PlayerEventPage';

/** Printed QR links retain their fragment and filters until the canonical hub redeems them. */
export function GuestEventPage() {
  return <PlayerEventAlias />;
}
export function PlayerEventAlias() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({
      to: '/play/$planId',
      params: { planId },
      search: () => Object.fromEntries(new URLSearchParams(window.location.search)),
      hash: window.location.hash.slice(1),
      replace: true,
    });
  }, [navigate, planId]);
  return <p role="status">Opening your event…</p>;
}
