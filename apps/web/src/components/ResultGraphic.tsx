import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CHARACTERS, characterName, isCharacterSlug } from '@smashclub/shared';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Disclosure } from './ui/Disclosure';
import { LoadingState, Notice } from './ui/Feedback';
import { Input } from './ui/Input';
import { Select, SelectItem } from './ui/Select';
import {
  graphicMemberKey,
  graphicMembers,
  rankedGraphicResults,
  resultsSvg,
  type GraphicContext,
  type GraphicResult,
} from '../lib/resultGraphic';
import { renderResultsPng, type GraphicPortraits } from '../lib/resultGraphicPng';
import { authClient } from '../lib/auth';
import { trpc } from '../lib/trpc';
import { downloadBlob } from '../lib/shareCard';
import { readResultPortrait, RESULT_PORTRAIT_TYPES } from '../lib/resultGraphicPortrait';
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

const noPortraits: GraphicPortraits = {};

function ResultGraphicPreview(props: {
  context: GraphicContext;
  results: readonly GraphicResult[];
}) {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const { source, kind, scopeLabel } = props.context;
  const artworkScope = JSON.stringify([userId, source, kind, scopeLabel]);
  return <ResultGraphicSession key={artworkScope} userId={userId} {...props} />;
}

function ResultGraphicSession({
  context,
  results,
  userId,
}: {
  context: GraphicContext;
  results: readonly GraphicResult[];
  userId: string | undefined;
}) {
  const rows = useMemo(() => rankedGraphicResults(results, context.kind), [results, context.kind]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [portraits, setPortraits] = useState<GraphicPortraits>({});
  const access = useQuery({
    queryKey: ['canCustomizeResultGraphic', userId, context.source],
    queryFn: () => trpc.eventOps.canCustomizeResultGraphic.query(context.source),
    enabled: Boolean(userId),
    retry: false,
  });
  const canCustomize = Boolean(userId && access.data);
  const previewPortraits = canCustomize ? portraits : noPortraits;
  const previewRows = useMemo(
    () =>
      canCustomize && Object.keys(overrides).length
        ? rows.map((row, rowIndex) => ({
            ...row,
            graphic: {
              teamName: row.graphic?.teamName ?? null,
              members: graphicMembers(row).map((member, index) => {
                const choice = overrides[graphicMemberKey(row, rowIndex, index)];
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
    portraits: GraphicPortraits;
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
        portraits: previewPortraits,
        image: blob && url ? { blob, url } : null,
      });
    };
    void renderResultsPng(context, previewRows, previewPortraits).then(receive, () =>
      receive(null),
    );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [context, previewRows, previewPortraits]);
  const current =
    output?.rows === previewRows &&
    output.context === context &&
    output.portraits === previewPortraits
      ? output
      : undefined;
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
      {canCustomize && (
        <ArtworkChoices
          rows={rows}
          overrides={overrides}
          portraits={portraits}
          onChange={setOverrides}
          onPortraitChange={(member, portrait) =>
            setPortraits((current) => {
              const next = { ...current };
              if (portrait) next[member] = portrait;
              else delete next[member];
              return next;
            })
          }
        />
      )}
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
  portraits,
  onChange,
  onPortraitChange,
}: {
  rows: readonly GraphicResult[];
  overrides: Record<string, string>;
  portraits: GraphicPortraits;
  onChange: (next: Record<string, string>) => void;
  onPortraitChange: (member: string, portrait: HTMLCanvasElement | null) => void;
}) {
  const prefix = useId();
  const members = rows.flatMap((row, rowIndex) =>
    graphicMembers(row).map(({ name }, index) => ({
      value: graphicMemberKey(row, rowIndex, index),
      label: `${row.place} · ${name}`,
    })),
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState('');
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState('');
  const selectedMember = members.some(({ value }) => value === selected)
    ? selected
    : (members[0]?.value ?? '');
  return (
    <Disclosure title="Customize graphic">
      <p className="muted">Character choices and portraits apply only to this export.</p>
      <div className="result-graphic-choices">
        <div className="ui-field">
          <label htmlFor={`${prefix}-member`}>Entrant or team member</label>
          <Select
            id={`${prefix}-member`}
            value={selectedMember}
            disabled={reading}
            onValueChange={(member) => {
              setSelected(member);
              setFileError('');
            }}
          >
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
      <div className="result-graphic-portrait">
        <p id={`${prefix}-portrait-hint`} className="muted">
          Choose a PNG, JPEG or WebP you have permission to use. The file stays in this browser.
        </p>
        <div className="result-graphic-actions">
          <Button
            type="button"
            size="small"
            disabled={!selectedMember || reading}
            aria-describedby={`${prefix}-portrait-hint`}
            onClick={() => fileInput.current?.click()}
          >
            {reading
              ? 'Reading portrait…'
              : portraits[selectedMember]
                ? 'Replace portrait…'
                : 'Choose portrait…'}
          </Button>
          {portraits[selectedMember] && (
            <Button
              type="button"
              size="small"
              disabled={reading}
              onClick={() => {
                onPortraitChange(selectedMember, null);
                setFileError('');
              }}
            >
              Remove portrait
            </Button>
          )}
        </div>
        <Input
          ref={fileInput}
          type="file"
          tabIndex={-1}
          aria-label="Portrait file"
          className="visually-hidden"
          accept={RESULT_PORTRAIT_TYPES.join(',')}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (!file || !selectedMember) return;
            setReading(true);
            setFileError('');
            void readResultPortrait(file)
              .then(
                (image) => onPortraitChange(selectedMember, image),
                (error: Error) => setFileError(error.message),
              )
              .finally(() => setReading(false));
          }}
        />
        {fileError && <Notice tone="warning">{fileError}</Notice>}
      </div>
    </Disclosure>
  );
}
