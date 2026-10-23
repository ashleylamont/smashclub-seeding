import {
  tournamentStructures,
  isKnockout,
  type StructureOptions,
  type TournamentStructure,
} from '@smashclub/shared';
import { useMutation } from '@tanstack/react-query';
import { useId } from 'react';
import { Checkbox } from '../../../components/ui/Checkbox';
import { Input } from '../../../components/ui/Input';
import { Select, SelectItem } from '../../../components/ui/Select';
import { trpc } from '../../../lib/trpc';
import type { EventPlanView } from '../../../lib/apiTypes';

export function TournamentFormatFields({
  structure,
  structureOptions = { roundRobinMeetings: 1 },
  onChange,
  disabled,
}: {
  structure: TournamentStructure;
  structureOptions?: StructureOptions;
  onChange: (value: { structure: TournamentStructure; structureOptions: StructureOptions }) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <>
      <label className="form-field">
        <span className="form-label">Tournament structure</span>
        <Select
          aria-label="Tournament structure"
          aria-describedby={`${id}-structure-help`}
          value={structure}
          disabled={disabled}
          onValueChange={(value) =>
            onChange({ structure: value as TournamentStructure, structureOptions })
          }
        >
          {tournamentStructures.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </Select>
        <span className="form-hint" id={`${id}-structure-help`}>
          {tournamentStructures.find((s) => s.value === structure)?.description}
        </span>
      </label>
      {!isKnockout(structure) && (
        <>
          <label className="form-field">
            <span className="form-label">Round-robin meetings per pairing</span>
            <Input
              aria-label="Round-robin meetings per pairing"
              aria-describedby={`${id}-meetings-help`}
              type="number"
              min={1}
              step={1}
              value={structureOptions.roundRobinMeetings}
              disabled={disabled}
              onChange={(event) => {
                const meetings = Number(event.target.value);
                if (Number.isSafeInteger(meetings) && meetings > 0)
                  onChange({
                    structure,
                    structureOptions: { ...structureOptions, roundRobinMeetings: meetings },
                  });
              }}
            />
            <span className="form-hint" id={`${id}-meetings-help`}>
              1 for single round robin, 2 for double round robin. Applies to every pool; return
              meetings alternate sides.
            </span>
          </label>
          {structure === 'round_robin_finals' && (
            <label className="form-field">
              <span className="form-label">Playoff entrants (blank = everyone)</span>
              <Input
                aria-label="Playoff entrants"
                type="number"
                min={2}
                step={1}
                value={structureOptions.playoffSize ?? ''}
                disabled={disabled}
                onChange={(e) => {
                  const size = Number(e.target.value);
                  if (e.target.value === '' || (Number.isSafeInteger(size) && size >= 2))
                    onChange({
                      structure,
                      structureOptions: {
                        ...structureOptions,
                        playoffSize: e.target.value === '' ? null : size,
                      },
                    });
                }}
              />
            </label>
          )}
          {structure !== 'round_robin' && (
            <label className="form-field">
              <span>
                <Checkbox
                  disabled={disabled}
                  checked={structureOptions.consolation ?? structure !== 'round_robin_finals'}
                  onCheckedChange={(checked) =>
                    onChange({
                      structure,
                      structureOptions: { ...structureOptions, consolation: checked },
                    })
                  }
                />{' '}
                Include a consolation bracket
              </span>
            </label>
          )}
        </>
      )}
    </>
  );
}

export function NativeFormatEditor({
  view,
  onChanged,
}: {
  view: EventPlanView;
  onChanged: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (value: { structure: TournamentStructure; structureOptions: StructureOptions }) =>
      trpc.admin.eventPlanner.updateNativeFormat.mutate({ planId: view.plan.id, ...value }),
    onSuccess: onChanged,
  });
  return (
    <section className="card section" aria-label="Tournament format">
      <TournamentFormatFields
        structure={view.plan.structure ?? 'dual_division'}
        structureOptions={view.plan.structureOptions}
        onChange={(value) => mutation.mutate(value)}
        disabled={mutation.isPending}
      />
      {mutation.isError && <p className="error-text">{mutation.error.message}</p>}
    </section>
  );
}
