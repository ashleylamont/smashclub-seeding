import { useEffect, useState } from 'react';

/** The bearer invitation lives only in a fragment, which browsers never send to the server. */
export function guestInvitationUrl(planId: string, token: string) {
  return `${window.location.origin}/guest/${encodeURIComponent(planId)}#token=${encodeURIComponent(token)}`;
}

export function useGuestClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return now;
}

export function guestTimeLeft(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
