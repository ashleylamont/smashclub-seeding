import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { trpc } from '../../lib/trpc'
import { GuestQr } from '../../components/GuestQr'
import { guestInvitationUrl, guestTimeLeft, useGuestClock } from '../../lib/guestReporting'
import { StationSignPreview } from './StationSignPreview'

type Station = { id: string; name: string }
export function GuestReportingControls({
  planId,
  eventName,
  stations,
  closed,
  published,
}: {
  planId: string
  eventName: string
  stations: Station[]
  closed: boolean
  published: boolean
}) {
  const cache = useQueryClient()
  const settings = useQuery({
    queryKey: ['guestSettings', planId],
    queryFn: () => trpc.eventOps.guests.settings.query({ planId }),
    refetchInterval: 5000,
  })
  const [invitation, setInvitation] = useState<{ token: string; expiresAt: string | null } | null>(
    null,
  )
  const [printInvitation, setPrintInvitation] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const now = useGuestClock()
  const act = async (work: () => Promise<unknown>) => {
    setPending(true)
    setError('')
    setNotice('')
    try {
      await work()
      await cache.invalidateQueries({ queryKey: ['guestSettings', planId] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update guest reporting.')
    } finally {
      setPending(false)
    }
  }
  const valid =
    invitation &&
    (!invitation.expiresAt || Date.parse(invitation.expiresAt) > now) &&
    settings.data?.enabled &&
    !closed
  const link = valid ? guestInvitationUrl(planId, invitation.token) : ''
  const configure = (
    changes: Partial<
      Pick<NonNullable<typeof settings.data>, 'enabled' | 'showOnOverlay' | 'rotateInvitations'>
    >,
  ) =>
    void act(async () => {
      await trpc.eventOps.guests.configure.mutate({
        planId,
        enabled: settings.data!.enabled,
        showOnOverlay: settings.data!.showOnOverlay,
        rotateInvitations: settings.data!.rotateInvitations,
        ...changes,
      })
      setInvitation(null)
      setPrintInvitation(null)
    })
  return (
    <section className="card guest-controls">
      <h3>Guest score reporting</h3>
      <p className="muted">
        Choose whether QR invitations rotate or remain valid until revoked. Each scan gives one hour
        of reporting access; players can scan the same permanent sign again. Scores follow the event
        and pool approval settings.
      </p>
      {settings.data && (
        <>
          <label className="ops-check">
            <input
              type="checkbox"
              checked={settings.data.enabled}
              disabled={pending || closed}
              onChange={(e) => configure({ enabled: e.target.checked })}
            />{' '}
            Allow guest score reports
          </label>
          <label className="ops-check">
            <input
              type="checkbox"
              checked={!settings.data.rotateInvitations}
              disabled={pending || closed || !settings.data.enabled}
              onChange={(e) => configure({ rotateInvitations: !e.target.checked })}
            />{' '}
            Keep QR invitations valid until revoked
          </label>
          <p className="muted">
            Use this for signs printed before the event. Changing this setting revokes previously
            issued QR invitations and guest passes.
          </p>
          <label className="ops-check">
            <input
              type="checkbox"
              checked={settings.data.showOnOverlay}
              disabled={pending || closed || !settings.data.enabled}
              onChange={(e) => configure({ showOnOverlay: e.target.checked })}
            />{' '}
            {settings.data.rotateInvitations
              ? 'Show a rotating QR on the OBS overlay'
              : 'Show the guest QR on the OBS overlay'}
          </label>
          <p className="muted">
            Stream viewers can scan the overlay too. Keep this off for an in-person-only invitation.
          </p>
          {!published && (
            <p>Signs can be prepared now. Publish the event before guests scan them.</p>
          )}
          <div className="ops-match-actions">
            <button
              className="btn"
              disabled={pending || closed || !settings.data.enabled}
              onClick={() =>
                void act(async () => {
                  setInvitation(await trpc.eventOps.guests.invitation.mutate({ planId }))
                })
              }
            >
              Generate guest QR
            </button>
            <button
              className="btn"
              disabled={
                pending ||
                closed ||
                !settings.data.enabled ||
                settings.data.rotateInvitations ||
                !stations.length
              }
              onClick={() =>
                void act(async () => {
                  const issued = await trpc.eventOps.guests.invitation.mutate({ planId })
                  if (issued && !issued.expiresAt) setPrintInvitation(issued.token)
                })
              }
            >
              Print station signs
            </button>
            <button
              className="btn"
              disabled={pending || closed || !settings.data.enabled}
              onClick={() => {
                if (
                  window.confirm(
                    'Revoke all current guest passes and QR invitations? Printed station signs will need replacing.',
                  )
                )
                  void act(async () => {
                    await trpc.eventOps.guests.rotate.mutate({ planId })
                    setInvitation(null)
                    setPrintInvitation(null)
                    setNotice(
                      'All guest passes revoked. Print fresh signs or generate a new guest QR.',
                    )
                  })
              }}
            >
              Revoke all guest passes
            </button>
          </div>
        </>
      )}
      {valid && (
        <div className="guest-invitation">
          <GuestQr value={link} />
          <div>
            <strong>Scan. Play. Report.</strong>
            <p>
              {invitation.expiresAt
                ? `Invitation expires in ${guestTimeLeft(invitation.expiresAt, now)}.`
                : 'Invitation valid until revoked.'}{' '}
              Guests get a temporary reporting pass.
              {!published && ' Reporting opens when the event is published.'}
            </p>
            <a href={link} rel="noreferrer">
              Open guest reporting
            </a>
            <button
              className="btn"
              onClick={() =>
                void act(async () => {
                  await navigator.clipboard.writeText(link)
                  setNotice('Guest invitation copied.')
                })
              }
            >
              Copy invitation link
            </button>
          </div>
        </div>
      )}
      {invitation && !valid && (
        <p>Invitation expired or guest access is unavailable. Generate a fresh code when ready.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {(error || settings.error) && <p role="alert">{error || settings.error?.message}</p>}
      {printInvitation && settings.data?.enabled && !settings.data.rotateInvitations && !closed && (
        <StationSignPreview
          planId={planId}
          eventName={eventName}
          stations={stations}
          token={printInvitation}
          onClose={() => setPrintInvitation(null)}
        />
      )}
    </section>
  )
}
