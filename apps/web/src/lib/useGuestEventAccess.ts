import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { trpc } from './trpc';
import {
  guestSessionCurrent,
  readGuestSession,
  saveGuestSession,
  useGuestClock,
  type GuestSession,
} from './guestReporting';

export function useGuestEventAccess(planId: string) {
  const [invitation, setInvitation] = useState(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('token'),
  );
  const [invitationGeneration, setInvitationGeneration] = useState(0);
  const [session, setSession] = useState<GuestSession | null>(() => readGuestSession(planId));
  const [redeeming, setRedeeming] = useState(Boolean(invitation));
  const [error, setError] = useState('');
  const [reportingPreference, setReportingPreference] = useState<'guest' | 'signed-in'>('guest');
  const [cacheId] = useState(() => crypto.randomUUID());
  const [passVersion, setPassVersion] = useState(0);
  const redemption = useRef<{
    token: string;
    generation: number;
    promise: Promise<GuestSession>;
  } | null>(null);
  const now = useGuestClock(Boolean(session?.expiresAt));
  const valid = guestSessionCurrent(session, now);
  useEffect(() => {
    const acceptInvitation = () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
      if (token) {
        setReportingPreference('guest');
        setInvitation(token);
        setInvitationGeneration((value) => value + 1);
        setRedeeming(true);
        setError('');
      }
    };
    window.addEventListener('hashchange', acceptInvitation);
    return () => window.removeEventListener('hashchange', acceptInvitation);
  }, []);
  useEffect(() => {
    if (!invitation) return;
    // Strip the invitation before navigation, analytics or a user copying the address.
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    if (
      redemption.current?.token !== invitation ||
      redemption.current.generation !== invitationGeneration
    )
      redemption.current = {
        token: invitation,
        generation: invitationGeneration,
        promise: trpc.eventOps.guests.redeem.mutate({ planId, token: invitation }),
      };
    let active = true;
    void redemption.current.promise
      .then((value) => {
        if (!active) return;
        setSession(value);
        setReportingPreference('guest');
        saveGuestSession(planId, value);
        setPassVersion((version) => version + 1);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Invitation could not be redeemed. Scan a fresh QR.',
          );
      })
      .finally(() => {
        if (active) setRedeeming(false);
      });
    return () => {
      active = false;
    };
  }, [invitation, invitationGeneration, planId]);
  const matches = useQuery({
    // The opaque version changes on re-redemption; credentials never enter query keys.
    queryKey: ['guestMatches', planId, cacheId, passVersion],
    queryFn: () =>
      trpc.eventOps.guests.matches.mutate({ planId, sessionToken: session!.sessionToken }),
    enabled: valid && !redeeming,
    refetchInterval: 2500,
    retry: false,
  });
  const accessDenied =
    matches.error instanceof TRPCClientError && matches.error.data?.code === 'FORBIDDEN';
  // FORBIDDEN also covers temporary event unavailability. Retain the saved pass
  // and let the server revalidate it; only a successful redemption replaces it.
  return {
    session,
    redeeming,
    error,
    setError,
    reportingPreference,
    setReportingPreference,
    cacheId,
    passVersion,
    now,
    valid,
    matches,
    accessDenied,
  };
}
