import { Select, SelectItem } from './ui/Select';
import type { BroadcastPresentation } from '../lib/broadcastProgress';

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
        </Select>
      </label>
      <label>
        Change progress page every
        <Select value={String(seconds)} onValueChange={(value) => onSeconds(Number(value))}>
          {[15, 30, 60].map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value} seconds
            </SelectItem>
          ))}
        </Select>
      </label>
      <p className="muted">
        These settings belong to this browser source. Copy the updated URL into OBS. Reduced motion
        keeps pages manual.
      </p>
    </>
  );
}
