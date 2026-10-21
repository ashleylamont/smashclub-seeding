import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  tournamentStructures,
  type CompetitionFormat,
  type TournamentStructure,
} from '@smashclub/shared';
import { Button } from '../../../components/ui/Button';
import { Input, Textarea } from '../../../components/ui/Input';
import { Select, SelectItem } from '../../../components/ui/Select';
import { trpc } from '../../../lib/trpc';
import type { RosterPreviewRow } from '../../../lib/apiTypes';
import { TournamentProjection } from './TournamentProjection';

/** Steps 1 and 2: the event's details and the paste that starts it off. */
export function NewPlanForm({ onCreated }: { onCreated: (planId: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState(defaultEventDate());
  const [slugPrefix, setSlugPrefix] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<RosterPreviewRow[] | null>(null);
  const [upperSize, setUpperSize] = useState<number | null>(null);
  const [bracketMode, setBracketMode] = useState<'native' | 'challonge'>('native');
  const [competitionFormat, setCompetitionFormat] = useState<CompetitionFormat>('singles');
  const [structure, setStructure] = useState<TournamentStructure>('dual_division');

  const previewRoster = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.previewRoster.mutate({ text }),
    onSuccess: (rows) => {
      setPreview(rows);
      setUpperSize(defaultUpperSize(rows.length));
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const rows = competitionFormat === 'doubles' ? [] : (preview ?? []);
      return trpc.admin.eventPlanner.createPlan.mutate({
        name: name.trim(),
        bracketMode,
        competitionFormat,
        structure,
        eventDate: new Date(eventDate).toISOString(),
        slugPrefix: slugPrefix.trim() === '' ? null : slugPrefix.trim(),
        upperTargetSize: upperSize,
        rows: rows.map((row) => ({
          lineNumber: row.lineNumber,
          rawInput: row.rawInput,
          cleanedName: row.cleanedName,
          companyId: row.companyId,
          playerId: row.playerId,
          resolutionMethod: row.method,
          divisionPreference: 'auto' as const,
        })),
      });
    },
    onSuccess: async ({ planId }) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'eventPlanner', 'plans'] });
      onCreated(planId);
    },
  });

  const total = preview?.length ?? 0;
  const sizes = validUpperSizes(total);
  const matched = preview?.filter((row) => row.playerId !== null).length ?? 0;

  return (
    <>
      <div className="card section">
        <h3>New event plan</h3>
        <label className="form-field">
          <span className="form-label">Competition</span>
          <Select
            value={competitionFormat}
            onValueChange={(value) => {
              setCompetitionFormat(value as CompetitionFormat);
              if (value === 'doubles') {
                setBracketMode('native');
                setStructure('round_robin');
              }
            }}
          >
            <SelectItem value="singles">Singles — 1v1</SelectItem>
            <SelectItem value="doubles">Doubles — 2v2 (Nemesis)</SelectItem>
          </Select>
        </label>
        {bracketMode === 'native' && (
          <label className="form-field">
            <span className="form-label">Tournament structure</span>
            <Select
              value={structure}
              onValueChange={(value) => setStructure(value as TournamentStructure)}
            >
              {tournamentStructures.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </Select>
            <span className="form-hint">
              {tournamentStructures.find((s) => s.value === structure)?.description}
            </span>
          </label>
        )}
        <div className="form-grid">
          <label className="form-field">
            <span className="form-label">Event name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. June Club Night"
            />
          </label>
          <label className="form-field">
            <span className="form-label">Date and time</span>
            <Input
              type="datetime-local"
              value={eventDate}
              onChange={(event) => setEventDate(event.target.value)}
            />
            <span className="form-hint">
              All stages share this event date. Singles and doubles ratings are kept separate.
            </span>
          </label>
          <label className="form-field">
            <span className="form-label">Slug prefix (optional)</span>
            <Input
              value={slugPrefix}
              onChange={(event) => setSlugPrefix(event.target.value)}
              placeholder="june25"
            />
            <span className="form-hint">Used to suggest Challonge slugs like june25_upper.</span>
          </label>
          <div className="form-field">
            <span className="form-label">Pool size</span>
            <Input
              value={structure === 'round_robin' ? 'All entrants' : '4'}
              readOnly
              aria-readonly="true"
            />
            <span className="form-hint">
              {structure === 'round_robin'
                ? 'One pool contains the whole field.'
                : 'Pools balance around four entrants.'}
            </span>
          </div>
        </div>

        {competitionFormat === 'singles' && (
          <>
            <label className="form-field">
              <span className="form-label">Attendance list</span>
              <Textarea
                className="planner-textarea"
                rows={10}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  'One person per line — bullets and numbering are fine.\n- [Atlas] Fox McCloud\n2. Samus Aran'
                }
              />
              <span className="form-hint">
                Lines are never split on commas: a display name may legitimately contain one.
              </span>
            </label>

            <div className="admin-form-row">
              <Button
                type="button"
                disabled={text.trim() === '' || previewRoster.isPending}
                onClick={() => previewRoster.mutate()}
              >
                {previewRoster.isPending ? 'Reading…' : 'Preview roster'}
              </Button>
              {previewRoster.isError && (
                <span className="error-text">{previewRoster.error.message}</span>
              )}
            </div>
          </>
        )}
        <label className="form-field">
          <span className="form-label">Bracket system</span>
          <Select
            value={bracketMode}
            onValueChange={(selectedValue) => {
              setBracketMode(selectedValue as 'native' | 'challonge');
              if (selectedValue === 'challonge') {
                setCompetitionFormat('singles');
                setStructure('dual_division');
              }
            }}
          >
            <SelectItem value="native">Nemesis — run the whole event here</SelectItem>
            {competitionFormat === 'singles' && (
              <SelectItem value="challonge">Challonge — manage external brackets</SelectItem>
            )}
          </Select>
          <span className="form-hint">
            Nemesis runs pools, championship and consolation, then records the finished night in
            club ratings. Existing Challonge events stay linked to Challonge.
          </span>
        </label>

        {competitionFormat === 'doubles' && (
          <div>
            <p>
              Save the draft, then choose the two players in each pair. The roster recommends a
              structure as teams are added.
            </p>
            <Button
              variant="primary"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Create doubles plan
            </Button>
            {create.isError && <p className="error-text">{create.error.message}</p>}
          </div>
        )}
        {competitionFormat === 'singles' && preview && (
          <div className="preview-summary">
            <p>
              <strong>{total}</strong> entrants, <strong>{matched}</strong> matched to a player.{' '}
              {total - matched > 0 && (
                <span className="muted">
                  The rest can be resolved or created on the next screen.
                </span>
              )}
            </p>
            {structure === 'dual_division' && (
              <label className="form-field">
                <span className="form-label">Upper division size</span>
                {sizes.length === 0 ? (
                  <span className="error-text">
                    At least six entrants are needed for two divisions.
                  </span>
                ) : (
                  <Select
                    value={upperSize ?? ''}
                    onValueChange={(selectedValue) =>
                      setUpperSize(selectedValue === '' ? null : Number(selectedValue))
                    }
                  >
                    <SelectItem value="">Choose…</SelectItem>
                    {sizes.map((size) => (
                      <SelectItem key={size} value={size}>
                        {size} Upper / {total - size} Lower
                      </SelectItem>
                    ))}
                  </Select>
                )}
                <span className="form-hint">
                  The default splits attendance evenly. Each pool advances two players; all
                  remaining players enter consolation.
                </span>
              </label>
            )}
            <Button
              variant="primary"
              type="button"
              disabled={name.trim() === '' || total === 0 || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Saving…' : 'Save plan'}
            </Button>
            {create.isError && <p className="error-text">{create.error.message}</p>}
          </div>
        )}
      </div>
      {bracketMode === 'native' && (
        <TournamentProjection
          key={competitionFormat}
          entrantCount={total}
          competitionFormat={competitionFormat}
          structure={structure}
          upperSize={upperSize}
          eventDate={eventDate}
        />
      )}
    </>
  );
}

/** `datetime-local` wants a local-time string, not an ISO instant. */
function defaultEventDate(): string {
  const now = new Date();
  now.setHours(18, 30, 0, 0);
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * Mirrors the server's `validUpperSizes`. Duplicated rather than imported
 * because apps/web deliberately depends on no server code; the server rejects
 * an invalid split regardless, so the worst this can be is out of date about
 * what to *offer*.
 */
function validUpperSizes(total: number, poolSize = 4): number[] {
  const minimum = Math.max(3, poolSize - 1);
  if (total < minimum * 2) return [];
  return Array.from({ length: total - minimum * 2 + 1 }, (_, index) => minimum + index);
}

function defaultUpperSize(total: number, poolSize = 4): number | null {
  const half = Math.ceil(total / 2);
  return validUpperSizes(total, poolSize).includes(half) ? half : null;
}
