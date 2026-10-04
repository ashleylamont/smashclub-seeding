import { Dialog } from '../../components/ui/Dialog';
import { Checkbox } from '../../components/ui/Checkbox';
import { Button } from '../../components/ui/Button';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { guestInvitationUrl } from '../../lib/guestReporting';
import './StationSignPreview.css';

type Station = { id: string; name: string };

export function StationSignPreview({
  planId,
  eventName,
  stations,
  token,
  onClose,
}: {
  planId: string;
  eventName: string;
  stations: Station[];
  token: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => stations.map((station) => station.id));
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.body.classList.add('printing-station-signs');
    return () => document.body.classList.remove('printing-station-signs');
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all(
      stations.map(
        async (station) =>
          [
            station.id,
            await QRCode.toDataURL(guestInvitationUrl(planId, token, station.id), {
              width: 720,
              margin: 4,
              errorCorrectionLevel: 'M',
            }),
          ] as const,
      ),
    )
      .then((entries) => {
        if (active) {
          setCodes(Object.fromEntries(entries));
          setReady(true);
        }
      })
      .catch(() => {
        if (active)
          setError('Could not prepare station QR codes. Close the preview and try again.');
      });
    return () => {
      active = false;
    };
  }, [planId, stations, token]);

  return (
    <Dialog
      title="Print station signs"
      className="station-sign-dialog"
      print
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="station-sign-toolbar">
        <p>
          One A4 page per station. These QR codes remain valid until guest access is revoked,
          disabled, or switched back to rotating invitations.
        </p>
        <fieldset>
          <legend>Stations to print</legend>
          {stations.map((station) => (
            <label key={station.id}>
              <Checkbox
                checked={selected.includes(station.id)}
                onCheckedChange={(nextChecked) =>
                  setSelected(
                    nextChecked
                      ? [...selected, station.id]
                      : selected.filter((id) => id !== station.id),
                  )
                }
              />
              {station.name}
            </label>
          ))}
        </fieldset>
        <p>Print at actual size on A4 portrait paper. Turn off browser headers and footers.</p>
        <Button
          variant="primary"
          type="submit"
          disabled={!selected.length || !ready || Boolean(error)}
          onClick={() => window.print()}
        >
          {ready ? 'Print selected signs' : 'Preparing QR codes…'}
        </Button>
        <Button type="submit" onClick={onClose}>
          Close preview
        </Button>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="station-sign-pages">
        {stations
          .filter((station) => selected.includes(station.id))
          .map((station) => (
            <article className="station-sign-page" key={station.id}>
              <p className="station-sign-brand">NEMESIS / SMASH CLUB</p>
              <p className="station-sign-event">{eventName}</p>
              <h1>{station.name}</h1>
              <p className="station-sign-callout">PLAY HERE · REPORT HERE</p>
              {codes[station.id] && (
                <img
                  src={codes[station.id]}
                  width="480"
                  height="480"
                  alt={`Guest score reporting QR for ${station.name}`}
                />
              )}
              <h2>Scan to see the queue and report your score</h2>
              <ol>
                <li>Find your match at this station.</li>
                <li>Start it when both players are ready, if your pool allows it.</li>
                <li>Agree on the final score and submit it together.</li>
              </ol>
              <p className="station-sign-note">
                No account needed. Your guest pass lasts one hour; scan this sign again if it
                expires. For a forfeit or correction, ask a tournament organiser.
              </p>
            </article>
          ))}
      </div>
    </Dialog>
  );
}
