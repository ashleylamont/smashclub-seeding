import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/Button';

export function EventTwitchPromotion({
  data,
  closed,
  interrupted,
  now,
}: {
  data?: { twitchPromotion?: { channel: string; expiresAt: string } };
  closed: boolean;
  interrupted: boolean;
  now: number;
}) {
  const promotion = data?.twitchPromotion;
  if (closed || interrupted || !promotion || Date.parse(promotion.expiresAt) <= now) return null;
  return <TwitchPlayer key={promotion.channel} channel={promotion.channel} />;
}

/* oxlint-disable react/iframe-missing-sandbox -- Twitch asset requests fail from an opaque origin. This fixed cross-origin frame cannot access Nemesis. */
function TwitchPlayer({ channel }: { channel: string }) {
  const frameSlot = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  const [requested, setRequested] = useState(false);
  const canEmbed = window.location.protocol === 'https:' && window.isSecureContext && fits;

  useEffect(() => {
    const slot = frameSlot.current;
    if (!slot || !window.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => {
      const wideEnough = entry!.contentRect.width >= 400;
      setFits(wideEnough);
      if (!wideEnough) setRequested(false);
    });
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="card event-twitch" aria-label="Twitch stream">
      <div className="ui-actions">
        <Button asChild size="small">
          <a href={`https://www.twitch.tv/${channel}`} target="_blank" rel="noreferrer">
            Watch on Twitch
          </a>
        </Button>
        {canEmbed && (
          <Button size="small" onClick={() => setRequested(!requested)}>
            {requested ? 'Close Twitch player' : 'Load Twitch player'}
          </Button>
        )}
      </div>
      <div ref={frameSlot}>
        {canEmbed && requested && (
          <iframe
            title="Twitch stream"
            className="event-twitch-player"
            width={640}
            height={360}
            src={`https://player.twitch.tv/?${new URLSearchParams({
              channel,
              parent: window.location.hostname,
              autoplay: 'false',
            })}`}
            referrerPolicy="strict-origin"
            sandbox="allow-same-origin allow-scripts"
            allowFullScreen
          />
        )}
      </div>
    </section>
  );
}
/* oxlint-enable react/iframe-missing-sandbox */
