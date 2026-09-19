import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import { GuestQr } from '../../components/GuestQr';
import { guestInvitationUrl, guestTimeLeft, useGuestClock } from '../../lib/guestReporting';

export function GuestReportingControls({ planId, closed, published }: { planId: string; closed: boolean; published: boolean }) {
  const cache = useQueryClient();
  const settings = useQuery({ queryKey: ['guestSettings', planId], queryFn: () => trpc.eventOps.guests.settings.query({ planId }), refetchInterval: 5000 });
  const [invitation, setInvitation] = useState<{ token: string; expiresAt: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const now = useGuestClock();
  const act = async (work: () => Promise<unknown>) => {
    setPending(true); setError(''); setNotice('');
    try { await work(); await cache.invalidateQueries({ queryKey: ['guestSettings', planId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update guest reporting.'); }
    finally { setPending(false); }
  };
  const valid = invitation && Date.parse(invitation.expiresAt) > now && settings.data?.enabled && !closed && published;
  const link = valid ? guestInvitationUrl(planId, invitation.token) : '';
  return <section className="card guest-controls"><h3>Guest score reporting</h3><p className="muted">Each QR link works for at least an hour, even after the screen rotates to a new code. Scanning it gives an hour of reporting access. Scores follow the event and pool approval settings; conflicting reports can be reviewed by TOs.</p>
    {settings.data && <><label className="ops-check"><input type="checkbox" checked={settings.data.enabled} disabled={pending || closed} onChange={e => void act(async () => { await trpc.eventOps.guests.configure.mutate({ planId, enabled: e.target.checked, showOnOverlay: settings.data!.showOnOverlay }); setInvitation(null); })} /> Allow guest score reports</label>
      <label className="ops-check"><input type="checkbox" checked={settings.data.showOnOverlay} disabled={pending || closed || !settings.data.enabled} onChange={e => void act(() => trpc.eventOps.guests.configure.mutate({ planId, enabled: settings.data!.enabled, showOnOverlay: e.target.checked }))} /> Show a rotating QR on the OBS overlay</label><p className="muted">Stream viewers can scan the overlay too. Keep this off for an in-person-only invitation.</p>
      {!published && <p>Publish the event to issue guest passes.</p>}
      <div className="ops-match-actions"><button className="btn" disabled={pending || closed || !published || !settings.data.enabled} onClick={() => void act(async () => { setInvitation(await trpc.eventOps.guests.invitation.mutate({ planId })); })}>Generate guest QR</button>
        <button className="btn" disabled={pending || closed || !settings.data.enabled} onClick={() => { if (window.confirm('Revoke all current guest passes and QR invitations? Guests will need to scan a new code.')) void act(async () => { await trpc.eventOps.guests.rotate.mutate({ planId }); setInvitation(null); setNotice('All guest passes revoked. Generate a new QR to admit guests again.'); }); }}>Revoke all guest passes</button></div>
    </>}
    {valid && <div className="guest-invitation"><GuestQr value={link} /><div><strong>Scan. Play. Report.</strong><p>Invitation expires in {guestTimeLeft(invitation.expiresAt, now)}. Guests get a temporary reporting pass.</p><a href={link} rel="noreferrer">Open guest reporting</a><button className="btn" onClick={() => void act(async () => { await navigator.clipboard.writeText(link); setNotice('Guest invitation copied.'); })}>Copy invitation link</button></div></div>}
    {invitation && !valid && <p>Invitation expired or guest access is unavailable. Generate a fresh code when ready.</p>}
    {notice && <p role="status">{notice}</p>}{(error || settings.error) && <p role="alert">{error || settings.error?.message}</p>}
  </section>;
}
