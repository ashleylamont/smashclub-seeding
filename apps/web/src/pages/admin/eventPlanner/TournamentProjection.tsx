import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  tournamentStructures,
  type CompetitionFormat,
  type TournamentStructure,
} from '@smashclub/shared';
import { trpc } from '../../../lib/trpc';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select, SelectItem } from '../../../components/ui/Select';
import { Disclosure } from '../../../components/ui/Disclosure';
import { Tabs, TabList, Tab, TabPanel } from '../../../components/ui/Tabs';
import { ProjectionTimeline } from './ProjectionTimeline';
import { ProjectionBrackets } from './ProjectionBrackets';
import { duration, projectedTime } from './projectionView';
import './TournamentProjection.css';

const FIELDS = [
  { key: 'stationCount', label: 'Available stations', min: 1, max: 32 },
  { key: 'matchMinutes', label: 'Minutes per set', min: 1, max: 60 },
  { key: 'turnaroundMinutes', label: 'Station turnaround (minutes)', min: 0, max: 30 },
  { key: 'restMinutes', label: 'Player recovery (minutes)', min: 0, max: 30 },
  { key: 'transitionMinutes', label: 'Pools to finals break (minutes)', min: 0, max: 60 },
] as const;

/** Hypothetical counts and timings stay local; the saved plan is never edited. */
export function TournamentProjection({
  entrantCount,
  competitionFormat,
  structure,
  upperSize,
  eventDate,
}: {
  entrantCount: number;
  competitionFormat: CompetitionFormat;
  structure: TournamentStructure;
  upperSize: number | null;
  eventDate: string;
}) {
  const [countOverride, setCountOverride] = useState<string | null>(null);
  const count = countOverride ?? String(entrantCount || (competitionFormat === 'doubles' ? 8 : 16));
  const [upperOverride, setUpperOverride] = useState<string | null>(null);
  const upper = upperOverride ?? (upperSize === null ? '' : String(upperSize));
  const [timing, setTiming] = useState({
    stationCount: '4',
    matchMinutes: competitionFormat === 'doubles' ? '15' : '10',
    turnaroundMinutes: '2',
    restMinutes: '2',
    transitionMinutes: '10',
  });
  const [formatOverride, setFormatOverride] = useState<TournamentStructure | null>(null);
  const format = formatOverride ?? structure;
  const date = new Date(eventDate);
  const defaultStart = Number.isNaN(date.getTime())
    ? '18:30'
    : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const [startOverride, setStartOverride] = useState<string | null>(null);
  const start = startOverride ?? defaultStart;
  const [tab, setTab] = useState('timeline');
  const input = {
    entrantCount: Number(count),
    upperSize: upper === '' ? null : Number(upper),
    stationCount: Number(timing.stationCount),
    matchMinutes: Number(timing.matchMinutes),
    turnaroundMinutes: Number(timing.turnaroundMinutes),
    restMinutes: Number(timing.restMinutes),
    transitionMinutes: Number(timing.transitionMinutes),
  };
  const valid =
    count.trim() !== '' &&
    Number.isInteger(input.entrantCount) &&
    input.entrantCount >= 2 &&
    input.entrantCount <= 128 &&
    (input.upperSize === null ||
      (Number.isInteger(input.upperSize) && input.upperSize >= 3 && input.upperSize <= 125)) &&
    FIELDS.every(
      (f) =>
        timing[f.key].trim() !== '' &&
        Number.isInteger(input[f.key]) &&
        input[f.key] >= f.min &&
        input[f.key] <= f.max,
    ) &&
    /^\d{2}:\d{2}$/.test(start);
  const query = useQuery({
    queryKey: ['admin', 'eventPlanner', 'projection', input],
    queryFn: () => trpc.admin.eventPlanner.projectTournament.query(input),
    enabled: valid,
    staleTime: Infinity,
  });
  const projection = valid ? query.data?.formats.find((f) => f.structure === format) : undefined;
  const unit = competitionFormat === 'doubles' ? 'teams' : 'players';
  return (
    <section className="card section planner-projection" aria-label="Tournament night preview">
      <h3>Night preview</h3>
      <p className="muted">
        Compare formats, station use and bracket shapes before committing the draw.
      </p>
      <Disclosure title="Explore timeline, run order and brackets">
        <p>
          Approximate rehearsal from entrant counts. Changing these controls does not change the
          plan, book stations or publish a draw.
        </p>
        <div className="projection-controls">
          <label>
            Projected {unit}
            <Input
              type="number"
              min={2}
              max={128}
              step={1}
              value={count}
              onChange={(e) => setCountOverride(e.target.value)}
            />
          </label>
          <label>
            Preview start time
            <Input type="time" value={start} onChange={(e) => setStartOverride(e.target.value)} />
          </label>
          {FIELDS.slice(0, 2).map((field) => (
            <label key={field.key}>
              {field.label}
              <Input
                type="number"
                min={field.min}
                max={field.max}
                step={1}
                value={timing[field.key]}
                onChange={(e) => setTiming({ ...timing, [field.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <Disclosure title="Timing and division assumptions">
          <div className="projection-controls">
            {FIELDS.slice(2).map((field) => (
              <label key={field.key}>
                {field.label}
                <Input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={1}
                  value={timing[field.key]}
                  onChange={(e) => setTiming({ ...timing, [field.key]: e.target.value })}
                />
              </label>
            ))}
            <label>
              Upper size (blank = even split)
              <Input
                type="number"
                min={3}
                max={125}
                step={1}
                value={upper}
                placeholder="Even split"
                onChange={(e) => setUpperOverride(e.target.value)}
              />
            </label>
          </div>
        </Disclosure>
        <p className="muted">
          Assuming {timing.turnaroundMinutes}m station turnaround, {timing.restMinutes}m player
          recovery and a {timing.transitionMinutes}m finals break.
        </p>
        <p className="muted">
          {entrantCount
            ? `Roster: ${entrantCount} ${unit}.`
            : 'No roster yet; use a hypothetical headcount.'}
          {competitionFormat === 'doubles' && (
            <>
              {' '}
              {input.entrantCount * 2} people in {count} fixed pairs; one team uses one station per
              set.
            </>
          )}{' '}
          Minutes per set includes every game in that set.
        </p>
        {(countOverride !== null || upperOverride !== null || formatOverride !== null) && (
          <Button
            size="small"
            onClick={() => {
              setCountOverride(null);
              setUpperOverride(null);
              setFormatOverride(null);
            }}
          >
            Use plan counts and format
          </Button>
        )}
        {!valid && (
          <p role="alert">
            Enter whole numbers within the shown limits: 2–128 entrants, 1–32 stations, and a valid
            start time.
          </p>
        )}
        {valid && query.isPending && <p role="status">Projecting the night…</p>}
        {query.isError && <p role="alert">Could not project the night: {query.error.message}</p>}
        {valid && query.data && (
          <>
            <div className="projection-comparison" role="group" aria-label="Format comparison">
              {query.data.formats.map((candidate) => (
                <Button
                  key={candidate.structure}
                  className="projection-format"
                  aria-pressed={candidate.structure === format}
                  onClick={() => setFormatOverride(candidate.structure)}
                >
                  <strong>
                    {tournamentStructures.find((s) => s.value === candidate.structure)!.label}
                  </strong>
                  <span>
                    {candidate.issues.length
                      ? candidate.issues[0]
                      : `${duration(candidate.totalMinutes)} · ${candidate.setCount} sets · ${candidate.pools.length} pools`}
                  </span>
                  <small>
                    {candidate.structure === structure ? 'Plan format' : 'What-if format'}
                  </small>
                </Button>
              ))}
            </div>
            <label className="projection-format-select">
              Detailed preview format
              <Select
                value={format}
                onValueChange={(value) => setFormatOverride(value as TournamentStructure)}
              >
                {tournamentStructures.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </Select>
            </label>
          </>
        )}
        {projection &&
          (projection.issues.length ? (
            <ul role="alert">
              {projection.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : (
            <>
              <dl className="projection-summary" aria-label="Projection summary">
                <div>
                  <dt>Approximate finish</dt>
                  <dd>{projectedTime(start, projection.totalMinutes)}</dd>
                </div>
                <div>
                  <dt>Play window</dt>
                  <dd>{duration(projection.totalMinutes)}</dd>
                </div>
                <div>
                  <dt>Played sets</dt>
                  <dd>
                    {projection.setCount} <small>· {projection.byeCount} byes</small>
                  </dd>
                </div>
                <div>
                  <dt>At least per {competitionFormat === 'doubles' ? 'team' : 'player'}</dt>
                  <dd>{projection.minimumSets} sets</dd>
                </div>
              </dl>
              <p className="muted">
                Set-length sensitivity: {projectedTime(start, projection.fastMinutes)}–
                {projectedTime(start, projection.slowMinutes)} if sets take 20% less to 25% more
                time (rounded to minutes). Allow extra venue time for check-in, disputes and
                overruns.
              </p>
              <Tabs value={tab} onValueChange={setTab}>
                <TabList aria-label="Projection views">
                  <Tab value="timeline">Station timeline</Tab>
                  <Tab value="brackets">Pools and bracket layout</Tab>
                </TabList>
                <TabPanel value="timeline">
                  <ProjectionTimeline
                    key={`${format}-${JSON.stringify(input)}`}
                    projection={projection}
                    stations={input.stationCount}
                    start={start}
                  />
                </TabPanel>
                <TabPanel value="brackets">
                  <ProjectionBrackets projection={projection} />
                </TabPanel>
              </Tabs>
              <p className="muted">
                All stations share one queue; each can run any set. Players recover between sets;
                automatic byes use no station time. All pools finish before the finals break. Finals
                wait for their feeder matches. Station banks, real seed identities, pauses,
                withdrawals and differing set lengths can change the order.
              </p>
            </>
          ))}
      </Disclosure>
    </section>
  );
}
