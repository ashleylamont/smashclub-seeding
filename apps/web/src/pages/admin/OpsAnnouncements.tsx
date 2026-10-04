import { useState } from 'react';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function OpsAnnouncements({
  data,
  pending,
  closed,
  act,
}: {
  data: Overview;
  pending: boolean;
  closed: boolean;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const planId = data.plan.id;
  const [announcementMinutes, setAnnouncementMinutes] = useState(5);
  const [announcement, setAnnouncement] = useState('');
  const [prizeTitle, setPrizeTitle] = useState('');
  const [prizePlayer, setPrizePlayer] = useState('');
  const entrants = new Map<string, string>();
  for (const match of data.matches) {
    if (match.player1Id) entrants.set(match.player1Id, match.player1Name);
    if (match.player2Id) entrants.set(match.player2Id, match.player2Name);
  }
  return (
    <div className="ops-bottom-grid">
      <section className="card">
        <h3>Announcements</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await trpc.eventOps.announce.mutate({
                planId,
                message: announcement,
                durationSeconds: announcementMinutes * 60,
              });
              setAnnouncement('');
            }, 'Announcement published to the event feed');
          }}
        >
          <label>
            Message
            <textarea
              className="input"
              value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              maxLength={500}
              required
              placeholder="Upper finals on the stage in five minutes"
            />
          </label>
          <label>
            Show for
            <select
              className="select"
              value={announcementMinutes}
              onChange={(event) => setAnnouncementMinutes(Number(event.target.value))}
            >
              <option value={1}>1 minute</option>
              <option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option>
              <option value={30}>30 minutes</option>
            </select>
          </label>
          <button className="btn" disabled={pending || closed}>
            Post announcement
          </button>
        </form>
        {data.announcements.slice(0, 3).map((item) => (
          <p key={item.id} className="ops-announcement">
            {item.message}
            {item.expiresAt && (
              <small>
                {' '}
                · until{' '}
                {new Date(item.expiresAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </small>
            )}
          </p>
        ))}
      </section>
      <section className="card">
        <h3>Prizes</h3>
        <p className="muted">Publish confirmed awards. You choose the recipient.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await trpc.eventOps.savePrize.mutate({
                planId,
                title: prizeTitle,
                ...(prizePlayer ? { playerId: prizePlayer } : {}),
              });
              setPrizeTitle('');
            });
          }}
        >
          <label>
            Award
            <input
              className="input"
              value={prizeTitle}
              onChange={(e) => setPrizeTitle(e.target.value)}
              placeholder="Upper champion / Best comeback"
              maxLength={100}
              required
            />
          </label>
          <label>
            Recipient
            <select
              className="select"
              value={prizePlayer}
              onChange={(e) => setPrizePlayer(e.target.value)}
            >
              <option value="">To be announced</option>
              {[...entrants].map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" disabled={pending || closed}>
            Save prize
          </button>
        </form>
        {data.prizes.map((prize) => (
          <p key={prize.id}>
            <strong>{prize.title}</strong> — {prize.playerName ?? 'To be announced'}
          </p>
        ))}
      </section>
    </div>
  );
}
