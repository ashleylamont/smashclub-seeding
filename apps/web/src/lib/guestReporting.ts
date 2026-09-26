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

export type GuestSession = { sessionToken: string; expiresAt: string };
const storageKey = (planId: string) => `nemesis:guest:${planId}`;
export function readGuestSession(planId: string): GuestSession | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(planId)) ?? 'null');
    if (value && typeof value === 'object' && 'sessionToken' in value && typeof value.sessionToken === 'string' && 'expiresAt' in value && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))) return { sessionToken: value.sessionToken, expiresAt: value.expiresAt };
  } catch { /* Browsers may disallow session storage; a pass still works in this tab. */ }
  return null;
}
export function saveGuestSession(planId: string, session: GuestSession) {
  try { sessionStorage.setItem(storageKey(planId), JSON.stringify(session)); } catch { /* Session stays in memory. */ }
}
