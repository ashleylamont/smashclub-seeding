import { useEffect, useState } from 'react';

/** The bearer invitation lives only in a fragment, which browsers never send to the server. */
export function guestInvitationUrl(planId: string, token: string, stationId?: string) {
  return `${window.location.origin}/guest/${encodeURIComponent(planId)}${stationId ? `?station=${encodeURIComponent(stationId)}` : ''}#token=${encodeURIComponent(token)}`;
}

export function useGuestClock(enabled = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function guestTimeLeft(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Null expiry is explicit durable access; dated passes issued by older servers still expire. */
export type GuestSession = { sessionToken: string; expiresAt: string | null };
const storageKey = (planId: string) => `nemesis:guest:${planId}`;
function storedSession(storage: Storage, key: string): GuestSession | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'sessionToken' in value &&
      typeof value.sessionToken === 'string' &&
      value.sessionToken.length >= 32 &&
      value.sessionToken.length <= 100 &&
      'expiresAt' in value &&
      (value.expiresAt === null ||
        (typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))))
    )
      return { sessionToken: value.sessionToken, expiresAt: value.expiresAt };
  } catch {
    /* Storage may be disabled or contain a partial/older value. */
  }
  return null;
}
export function readGuestSession(planId: string): GuestSession | null {
  const key = storageKey(planId);
  try {
    const saved = storedSession(localStorage, key);
    if (saved) return saved;
  } catch {
    /* Accessing a disabled storage getter can itself throw. */
  }
  try {
    const legacy = storedSession(sessionStorage, key);
    if (legacy) saveGuestSession(planId, legacy);
    return legacy;
  } catch {
    return null;
  }
}
export function saveGuestSession(planId: string, session: GuestSession) {
  const key = storageKey(planId);
  try {
    localStorage.setItem(key, JSON.stringify(session));
  } catch {
    // A stale persistent copy must not shadow the replacement tab pass on reload
    // when a full/disabled storage area allows reads but refuses new writes.
    try {
      localStorage.removeItem(key);
    } catch {
      /* Storage access can be disabled completely. */
    }
    try {
      sessionStorage.setItem(key, JSON.stringify(session));
    } catch {
      /* The pass still works in memory when the browser disallows storage. */
    }
    return;
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Durable storage succeeded; removing a legacy copy is best effort. */
  }
}

export function guestSessionCurrent(session: GuestSession | null, now: number) {
  return session !== null && (session.expiresAt === null || Date.parse(session.expiresAt) > now);
}
