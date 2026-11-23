import { Select, SelectItem } from './ui/Select';
import { Switch } from './ui/Switch';
import {
  progressIntervals,
  type BroadcastPresentation,
  type ProgressContent,
} from '../lib/broadcastProgress';

export function BroadcastPresentationControls({
  mode,
  content,
  seconds,
  recentCount,
  showGuestQr,
  onMode,
  onContent,
  onSeconds,
  onRecentCount,
  onGuestQr,
}: {
  mode: BroadcastPresentation;
  content: ProgressContent;
  seconds: number;
  recentCount: number;
  showGuestQr: boolean;
  onMode: (mode: BroadcastPresentation) => void;
  onContent: (content: ProgressContent) => void;
  onSeconds: (seconds: number) => void;
  onRecentCount: (count: number) => void;
  onGuestQr: (show: boolean) => void;
}) {
  return (
    <>
      <label>
        Broadcast presentation
        <Select value={mode} onValueChange={(value) => onMode(value as BroadcastPresentation)}>
          <SelectItem value="gameplay">Gameplay overlay</SelectItem>
          <SelectItem value="auto">Automatic intermission when idle</SelectItem>
          <SelectItem value="progress">Tournament progress only</SelectItem>
          <SelectItem value="event">Follow event</SelectItem>
        </Select>
      </label>
      {mode === 'event' && (
        <p className="muted">The event organiser controls this source’s presentation.</p>
      )}
      <label>
        Intermission pages
        <Select value={content} onValueChange={(value) => onContent(value as ProgressContent)}>
          <SelectItem value="all">All pages</SelectItem>
          <SelectItem value="standings">Standings and brackets</SelectItem>
          <SelectItem value="recent">Recent results</SelectItem>
        </Select>
      </label>
      <label>
        Change progress page every
        <Select value={String(seconds)} onValueChange={(value) => onSeconds(Number(value))}>
          {progressIntervals.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value} seconds
            </SelectItem>
          ))}
        </Select>
      </label>
      <p className="muted">Reduced motion keeps pages manual.</p>
      <label>
        Recent results in the gameplay sidebar
        <Select value={recentCount} onValueChange={(value) => onRecentCount(Number(value))}>
          <SelectItem value={1}>1 set</SelectItem>
          <SelectItem value={2}>2 sets</SelectItem>
        </Select>
      </label>
      <label className="ui-actions overlay-source-switch">
        <Switch checked={showGuestQr} onCheckedChange={onGuestQr} />
        Show score-reporting QR on this source
      </label>
      <p className="muted">Guest access follows the event settings.</p>
    </>
  );
}
