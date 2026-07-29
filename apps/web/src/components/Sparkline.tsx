/**
 * A rating trace, small enough to sit in a table row.
 *
 * Deliberately austere: no axes, no grid, no tooltip. It answers one question —
 * which way has this player been going — and the player page carries the full
 * chart with scales and interaction. A 2px line with a single end marker, per
 * the mark specs.
 */
interface Props {
  points: number[];
  width?: number;
  height?: number;
}

export function Sparkline({ points, width = 68, height = 22 }: Props) {
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (points.length - 1);

  const coords = points.map((value, index) => {
    const x = pad + index * stepX;
    const y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1]!;
  const rising = points[points.length - 1]! >= points[0]!;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="presentation" focusable="false">
      <path d={path} fill="none" stroke={rising ? 'var(--good)' : 'var(--bad)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={rising ? 'var(--good)' : 'var(--bad)'} />
    </svg>
  );
}
