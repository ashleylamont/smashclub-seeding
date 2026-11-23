import { useId, useState } from 'react';
import { twitchChannel } from '@smashclub/shared';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Switch } from './ui/Switch';

export function OverlayTwitchLink({ channel }: { channel: string }) {
  return (
    <a
      className="broadcast-twitch-link"
      href={`https://www.twitch.tv/${channel}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`twitch.tv/${channel} (opens in a new tab)`}
    >
      <span className="broadcast-twitch-url">twitch.tv/{channel}</span>
      <span className="broadcast-twitch-short">@{channel}</span>
    </a>
  );
}

export function OverlayTwitchSetting({
  channel,
  useEventAnnouncement,
  eventChannel,
  onChange,
  onUseEventAnnouncement,
}: {
  channel: string;
  useEventAnnouncement: boolean;
  eventChannel?: string;
  onChange: (channel: string) => void;
  onUseEventAnnouncement: (use: boolean) => void;
}) {
  const [draft, setDraft] = useState(channel);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const announcementDetail = useId();

  return (
    <>
      <label className="ui-actions overlay-source-switch">
        <Switch
          checked={useEventAnnouncement}
          aria-describedby={useEventAnnouncement ? announcementDetail : undefined}
          onCheckedChange={(checked) => {
            setDraft('');
            setError('');
            setMessage('');
            onUseEventAnnouncement(checked);
          }}
        />
        Use event Twitch announcement
      </label>
      {useEventAnnouncement ? (
        <p id={announcementDetail} className="muted">
          {eventChannel === undefined
            ? 'The event announcement is unavailable while the connection is interrupted.'
            : eventChannel
              ? `Event channel · twitch.tv/${eventChannel}`
              : 'No active Twitch announcement.'}
        </p>
      ) : (
        <form
          className="overlay-twitch-setting"
          onSubmit={(event) => {
            event.preventDefault();
            const next = twitchChannel(draft);
            if (draft.trim() && !next) {
              setMessage('');
              setError('Enter a Twitch channel name or channel URL.');
              return;
            }
            onChange(next);
            setDraft(next);
            setMessage(next ? 'Twitch link saved to this source.' : 'Twitch link removed.');
          }}
        >
          <Field
            label="Twitch channel (optional)"
            hint="Enter a channel name or Twitch channel URL. Save a blank field to remove the link."
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError('');
              setMessage('');
            }}
            error={error}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={draft === channel}>
            Save Twitch link
          </Button>
          {message && <p role="status">{message}</p>}
        </form>
      )}
    </>
  );
}
