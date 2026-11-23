import { Select, SelectItem } from './ui/Select';
import { progressIntervals, type BroadcastPresentation } from '../lib/broadcastProgress';

export function BroadcastPresentationControls({
  mode,
  seconds,
  onMode,
  onSeconds,
}: {
  mode: BroadcastPresentation;
  seconds: number;
  onMode: (mode: BroadcastPresentation) => void;
  onSeconds: (seconds: number) => void;
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
    </>
  );
}
