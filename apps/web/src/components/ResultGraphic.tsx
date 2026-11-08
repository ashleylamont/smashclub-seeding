import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CHARACTERS, characterName, isCharacterSlug } from '@smashclub/shared';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Disclosure } from './ui/Disclosure';
import { LoadingState, Notice } from './ui/Feedback';
import { Select, SelectItem } from './ui/Select';
import {
  graphicMembers,
  rankedGraphicResults,
  resultsSvg,
  type GraphicContext,
  type GraphicResult,
} from '../lib/resultGraphic';
import { renderResultsPng } from '../lib/resultGraphicPng';
import { authClient } from '../lib/auth';
import { trpc } from '../lib/trpc';
import { downloadBlob } from '../lib/shareCard';
import './ResultGraphic.css';

export function ResultGraphic({
  title,
  context,
  results,
}: {
  title: string;
  context: GraphicContext;
  results: readonly GraphicResult[];
}) {
  const [open, setOpen] = useState(false);
  if (!results.length) return null;
  return (
    <div className="result-graphic-actions">
      <Dialog
        title="Results graphic"
        description={context.scopeLabel}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button type="button" aria-label={`Preview results PNG for ${context.scopeLabel}`}>
            Preview results PNG
          </Button>
        }
        wide
        className="result-graphic-dialog"
      >
        {open && <ResultGraphicPreview context={context} results={results} />}
      </Dialog>
      <Button
        type="button"
        onClick={() =>
          downloadBlob(
            new Blob([resultsSvg(title, results, context.kind)], {
              type: 'image/svg+xml;charset=utf-8',
            }),
            'smash-club-results.svg',
          )
        }
      >
        Download SVG ↓
      </Button>
    </div>
  );
}

const profileDefault = '__profile_default__';

function memberKey(row: GraphicResult, rowIndex: number, index: number) {
  return `${row.entryKey ?? rowIndex}:${index}`;
}

function ResultGraphicPreview({
  context,
  results,
}: {
  context: GraphicContext;
  results: readonly GraphicResult[];
}) {
  const rows = useMemo(() => rankedGraphicResults(results, context.kind), [results, context.kind]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const { data: session } = authClient.useSession();
  const access = useQuery({
    queryKey: ['canCustomizeResultGraphic', session?.user.id, context.source],
    queryFn: () => trpc.eventOps.canCustomizeResultGraphic.query(context.source),
    enabled: Boolean(session?.user.id),
    retry: false,
  });
  const canCustomize = Boolean(session && access.data);
  const previewRows = useMemo(
    () =>
      canCustomize && Object.keys(overrides).length
        ? rows.map((row, rowIndex) => ({
            ...row,
            graphic: {
              teamName: row.graphic?.teamName ?? null,
              members: graphicMembers(row).map((member, index) => {
                const choice = overrides[memberKey(row, rowIndex, index)];
                return choice === undefined ? member : { ...member, character: choice || null };
              }),
            },
          }))
        : rows,
    [rows, canCustomize, overrides],
  );
  const [output, setOutput] = useState<{
    context: GraphicContext;
    rows: readonly GraphicResult[];
    image: { blob: Blob; url: string } | null;
  }>();
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    const receive = (blob: Blob | null) => {
      if (!active) return;
      url = blob ? URL.createObjectURL(blob) : undefined;
      setOutput({
        context,
        rows: previewRows,
        image: blob && url ? { blob, url } : null,
      });
    };
    void renderResultsPng(context, previewRows).then(receive, () => receive(null));
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [context, previewRows]);
  const current = output?.rows === previewRows && output.context === context ? output : undefined;
  const fileLabel = context.scopeLabel
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 64);
  return (
    <div className="result-graphic-preview">
      {current?.image ? (
        <img
          src={current.image.url}
          alt={`Nemesis results graphic for ${context.eventName}, ${context.scopeLabel}`}
        />
      ) : current ? (
        <Notice tone="warning">
          This PNG could not be prepared. You can download the SVG from the results page.
        </Notice>
      ) : (
        <LoadingState>Preparing results PNG…</LoadingState>
      )}
      <p className="muted">
        Character labels use current profile choices when available. They may differ from the
        characters played at this event.
      </p>
      <Disclosure title="Placements in this graphic">
        <ul className="result-graphic-placements">
          {previewRows.map((row, index) => (
            <li key={row.entryKey ?? index}>
              <strong>{row.place}</strong> · {row.graphic?.teamName && `${row.graphic.teamName} · `}
              {graphicMembers(row)
                .map(({ name, character }) =>
                  character && isCharacterSlug(character)
                    ? `${name} (${characterName(character)})`
                    : name,
                )
                .join(' / ')}
            </li>
          ))}
        </ul>
      </Disclosure>
      {canCustomize && <ArtworkChoices rows={rows} overrides={overrides} onChange={setOverrides} />}
      <Button
        type="button"
        variant="primary"
        disabled={!current?.image}
        onClick={() => {
          if (current?.image)
            downloadBlob(current.image.blob, `nemesis-${fileLabel || 'results'}-results.png`);
        }}
      >
        Download PNG ↓
      </Button>
    </div>
  );
}

function ArtworkChoices({
  rows,
  overrides,
  onChange,
}: {
  rows: readonly GraphicResult[];
  overrides: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const prefix = useId();
  const members = rows.flatMap((row, rowIndex) =>
    graphicMembers(row).map(({ name }, index) => ({
      value: memberKey(row, rowIndex, index),
      label: `${row.place} · ${name}`,
    })),
  );
  const [selected, setSelected] = useState('');
  const selectedMember = members.some(({ value }) => value === selected)
    ? selected
    : (members[0]?.value ?? '');
  return (
    <Disclosure title="Choose character labels">
      <p className="muted">Changes apply only to this export.</p>
      <div className="result-graphic-choices">
        <div className="ui-field">
          <label htmlFor={`${prefix}-member`}>Entrant or team member</label>
          <Select id={`${prefix}-member`} value={selectedMember} onValueChange={setSelected}>
            {members.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div className="ui-field">
          <label htmlFor={`${prefix}-character`}>Character label</label>
          <Select
            id={`${prefix}-character`}
            value={overrides[selectedMember] ?? profileDefault}
            onValueChange={(value) => {
              const next = { ...overrides };
              if (value === profileDefault) delete next[selectedMember];
              else next[selectedMember] = value;
              onChange(next);
            }}
          >
            <SelectItem value={profileDefault}>Use profile choice</SelectItem>
            <SelectItem value="">No character label</SelectItem>
            {CHARACTERS.map(({ slug, name }) => (
              <SelectItem key={slug} value={slug}>
                {name}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
    </Disclosure>
  );
}
