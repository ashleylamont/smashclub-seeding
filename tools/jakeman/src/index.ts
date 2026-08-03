/**
 * The Jakeman scale (Jk): the stock ratio a player is expected to take off
 * Matt J in a 7-minute battle. 2.0 Jk means two stocks taken for every one
 * given back; 0.5 Jk means the reverse.
 *
 * Calibrated against the live leaderboard from three empirically observed
 * anchors (Shirley 0.8 Jk, Ashley 1.2 Jk, Mitch 3.3 Jk) by least-squares of
 * ln(Jk) on WHR skill rating. On the August 2026 board the anchors sit on an
 * almost exact exponential — one e-fold of stock ratio per ~300 rating
 * points — so the fit is re-run against the current board each time rather
 * than hard-coding the curve: as ratings move, the scale recalibrates.
 *
 * Usage:
 *   pnpm jakeman                       # full club table from nemesis.ashl.dev
 *   pnpm jakeman --player shirley      # single player lookup
 *   pnpm jakeman --url http://localhost:3000
 */
import { parseArgs } from 'node:util';

interface LeaderboardRow {
  playerId: string;
  rank: number;
  name: string;
  skillRating: number;
  skillSd: number;
}

interface Anchor {
  playerId: string;
  name: string;
  jk: number;
}

const MATT_J_ID = 'cb4c5764-84fa-41a0-89f2-9a9d91d9bd06';

// Observed 7-minute-battle stock ratios against Matt J. IDs pin the anchors
// to the right people; names are only a fallback for other databases.
const ANCHORS: Anchor[] = [
  { playerId: '7aaa9374-bf2c-41f7-a7c6-35f8a4d46da5', name: 'Shirley Z', jk: 0.8 },
  { playerId: '1e48ee82-b15b-461f-9cea-6919dc22f1d7', name: 'Ashley L', jk: 1.2 },
  { playerId: '91a488e3-91f6-4794-ab06-ab30be804576', name: 'Mitchell M', jk: 3.3 },
];

interface Calibration {
  /** Rating at which a player breaks even with Matt J (1.0 Jk). */
  neutralRating: number;
  /** Rating points per e-fold of stock ratio. */
  scale: number;
  jkOf: (rating: number) => number;
  residuals: { name: string; given: number; fitted: number }[];
}

function calibrate(rows: readonly LeaderboardRow[]): Calibration {
  const points = ANCHORS.map((anchor) => {
    const row =
      rows.find((r) => r.playerId === anchor.playerId) ?? rows.find((r) => r.name === anchor.name);
    if (!row) throw new Error(`anchor player not on the leaderboard: ${anchor.name}`);
    return { name: row.name, rating: row.skillRating, jk: anchor.jk, y: Math.log(anchor.jk) };
  });

  const n = points.length;
  const meanRating = points.reduce((sum, p) => sum + p.rating, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  const slope =
    points.reduce((sum, p) => sum + (p.rating - meanRating) * (p.y - meanY), 0) /
    points.reduce((sum, p) => sum + (p.rating - meanRating) ** 2, 0);
  const intercept = meanY - slope * meanRating;

  const jkOf = (rating: number) => Math.exp(intercept + slope * rating);
  return {
    neutralRating: -intercept / slope,
    scale: 1 / slope,
    jkOf,
    residuals: points.map((p) => ({ name: p.name, given: p.jk, fitted: jkOf(p.rating) })),
  };
}

function formatJk(value: number): string {
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

async function fetchLeaderboard(baseUrl: string): Promise<LeaderboardRow[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/trpc/public.leaderboard`);
  if (!response.ok) throw new Error(`leaderboard fetch failed: HTTP ${response.status}`);
  const body = (await response.json()) as { result: { data: { rows: LeaderboardRow[] } } };
  return body.result.data.rows;
}

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://nemesis.ashl.dev' },
    player: { type: 'string' },
  },
});

const rows = await fetchLeaderboard(values.url);
const calibration = calibrate(rows);
const matt = rows.find((r) => r.playerId === MATT_J_ID) ?? rows.find((r) => r.name === 'Matthew J');

console.log(
  `Jk(R) = exp((R − ${calibration.neutralRating.toFixed(1)}) / ${calibration.scale.toFixed(1)})`,
);
for (const r of calibration.residuals) {
  console.log(`  anchor ${r.name.padEnd(12)} given ${r.given}  fitted ${r.fitted.toFixed(4)}`);
}
if (matt) {
  console.log(
    `  Matt J is rated ${matt.skillRating.toFixed(0)} and projects to ` +
      `${formatJk(calibration.jkOf(matt.skillRating))} Jk against himself — the scale says he ` +
      `punches ~${(matt.skillRating - calibration.neutralRating).toFixed(0)} rating points below ` +
      'his bracket rating in a timed free-for-all.',
  );
}
console.log();

const filter = values.player?.toLowerCase();
const table = [...rows]
  .filter((r) => !filter || r.name.toLowerCase().includes(filter))
  .sort((a, b) => b.skillRating - a.skillRating);

if (table.length === 0) {
  console.log(`no player matching "${values.player}"`);
} else {
  for (const r of table) {
    const jk = calibration.jkOf(r.skillRating);
    // The rating's ±1σ band, pushed through the same curve.
    const low = calibration.jkOf(r.skillRating - r.skillSd);
    const high = calibration.jkOf(r.skillRating + r.skillSd);
    const marker =
      r.playerId === matt?.playerId ? '  ← Matt J' : ANCHORS.some((a) => a.playerId === r.playerId) ? '  * anchor' : '';
    console.log(
      `${String(r.rank).padStart(3)}  ${r.name.padEnd(14)} ${formatJk(jk).padStart(6)} Jk  ` +
        `(${formatJk(low)}–${formatJk(high)})${marker}`,
    );
  }
}
