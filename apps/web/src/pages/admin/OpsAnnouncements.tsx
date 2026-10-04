import { Textarea, Input } from '../../components/ui/Input';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
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
            <Textarea
              value={announcement}
              onChange={(e) => setAnnouncement(e.target.value)}
              maxLength={500}
              required
              placeholder="Upper finals on the stage in five minutes"
            />
          </label>
          <label>
            Show for
            <Select
              value={announcementMinutes}
              onValueChange={(selectedValue) => setAnnouncementMinutes(Number(selectedValue))}
            >
              <SelectItem value={1}>1 minute</SelectItem>
              <SelectItem value={5}>5 minutes</SelectItem>
              <SelectItem value={10}>10 minutes</SelectItem>
              <SelectItem value={30}>30 minutes</SelectItem>
            </Select>
          </label>
          <Button type="submit" disabled={pending || closed}>
            Post announcement
          </Button>
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
            <Input
              value={prizeTitle}
              onChange={(e) => setPrizeTitle(e.target.value)}
              placeholder="Upper champion / Best comeback"
              maxLength={100}
              required
            />
          </label>
          <label>
            Recipient
            <Select value={prizePlayer} onValueChange={setPrizePlayer}>
              <SelectItem value="">To be announced</SelectItem>
              {[...entrants].map(([id, name]) => (
                <SelectItem value={id} key={id}>
                  {name}
                </SelectItem>
              ))}
            </Select>
          </label>
          <Button type="submit" disabled={pending || closed}>
            Save prize
          </Button>
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
