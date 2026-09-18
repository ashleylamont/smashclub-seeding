import { GuestQr } from './GuestQr';
import { guestInvitationUrl, guestTimeLeft, useGuestClock } from '../lib/guestReporting';

export function GuestOverlayQr({ planId, invitation }: { planId: string; invitation: { token: string; expiresAt: string } }) {
  const now = useGuestClock();
  if (Date.parse(invitation.expiresAt) <= now) return null;
  return <section className="broadcast-guest-pass" aria-label="Guest score reporting"><div className="broadcast-guest-heading"><span>PLAYED YOUR SET?</span><strong>SCAN IT IN ↗</strong></div><GuestQr value={guestInvitationUrl(planId, invitation.token)} /><p>No login. TO approval.<br /><span>Code refreshes · {guestTimeLeft(invitation.expiresAt, now)}</span></p></section>;
}
