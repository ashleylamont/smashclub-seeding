import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select, SelectItem } from './ui/Select';
import { Dialog } from './ui/Dialog';
import { Field } from './ui/Field';
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { defaultPublicAlias } from '@smashclub/shared';
import { trpc } from '../lib/trpc';
import type { AdminCompany } from '../lib/apiTypes';
import { CharacterPicker } from './CharacterPicker';
import './PlayerFormModal.css';

/**
 * The one form for a player's details, used wherever a player is created or
 * edited: the registry's "New player", the registry's row Edit, and the review
 * queue when it mints a player from a bracket entry. Those three used to
 * disagree about which fields even existed — the queue offered none at all —
 * which is how players ended up in the registry with a bracket's spelling as
 * their permanent name.
 */

export interface PlayerFormValues {
  canonicalName: string;
  /** Empty string means "no alias"; callers map it to null. */
  displayName: string;
  /** Empty string means "no company". */
  companyCode: string;
  characters: string[];
  /** Extra spellings to match on. Only offered when creating. */
  aliases: string[];
}

interface Props {
  title: string;
  submitLabel: string;
  initial?: Partial<PlayerFormValues>;
  companies: AdminCompany[];
  /** Alias entry is only meaningful when minting a player. */
  showAliases?: boolean;
  /**
   * An escape hatch that commits without the form — the review queue uses it
   * for "create as-is", so working a long queue never costs more clicks than
   * it did before details existed.
   */
  secondary?: { label: string; onClick: () => void };
  busy?: boolean;
  error?: string | null;
  /** Context for the reviewer — the raw bracket entry, candidates, etc. */
  children?: ReactNode;
  onSubmit: (values: PlayerFormValues) => void;
  onCancel: () => void;
}

export function PlayerFormModal({
  title,
  submitLabel,
  initial,
  companies,
  showAliases = false,
  secondary,
  busy = false,
  error,
  children,
  onSubmit,
  onCancel,
}: Props) {
  const [canonicalName, setCanonicalName] = useState(initial?.canonicalName ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [companyCode, setCompanyCode] = useState(initial?.companyCode ?? '');
  const [characters, setCharacters] = useState<string[]>(initial?.characters ?? []);
  const [aliases, setAliases] = useState<string[]>(initial?.aliases ?? []);
  const [aliasInput, setAliasInput] = useState('');

  const valid = canonicalName.trim() !== '';

  const submit = () => {
    if (!valid || busy) return;
    onSubmit({
      canonicalName: canonicalName.trim(),
      displayName: displayName.trim(),
      companyCode,
      characters,
      // A half-typed alias would otherwise be silently discarded on save.
      aliases: aliasInput.trim() === '' ? aliases : [...aliases, aliasInput.trim()],
    });
  };

  const addAlias = () => {
    const value = aliasInput.trim();
    if (value === '' || aliases.includes(value)) return;
    setAliases([...aliases, value]);
    setAliasInput('');
  };

  return (
    <Dialog
      title={title}
      open
      wide
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      {children}

      <div className="form-grid">
        <Field
          label="Registry name"
          autoFocus
          value={canonicalName}
          onChange={(event) => setCanonicalName(event.target.value)}
          placeholder="e.g. Ashley Lamont"
          hint="Used for identity matching. Hidden publicly when an alias is set."
        />
        <Field
          label="Public alias"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={
            canonicalName.trim() ? defaultPublicAlias(canonicalName) : 'optional username'
          }
          hint={
            <>
              The tag shown on the leaderboard. Leave blank to go by{' '}
              {canonicalName.trim()
                ? `“${defaultPublicAlias(canonicalName)}”`
                : 'the shortened registry name'}
              .
            </>
          }
        />

        <div className="form-field">
          <span className="form-label">Company</span>
          <CompanySelect companies={companies} value={companyCode} onChange={setCompanyCode} />
        </div>

        <div className="form-field">
          <span className="form-label">Characters</span>
          <CharacterPicker value={characters} onChange={setCharacters} />
        </div>

        {showAliases && (
          <div className="form-field">
            <span className="form-label">Extra aliases</span>
            <div className="alias-editor">
              {aliases.map((alias) => (
                <span key={alias} className="chip">
                  {alias}
                  <Button
                    variant="plain"
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove alias ${alias}`}
                    onClick={() => setAliases(aliases.filter((entry) => entry !== alias))}
                  >
                    ×
                  </Button>
                </span>
              ))}
            </div>
            <div className="admin-form-row">
              <Input
                placeholder="other spelling…"
                aria-label="Extra alias"
                value={aliasInput}
                onChange={(event) => setAliasInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addAlias();
                  }
                }}
              />
              <Button
                size="small"
                type="button"
                disabled={aliasInput.trim() === ''}
                onClick={addAlias}
              >
                Add
              </Button>
            </div>
            <span className="form-hint">
              Other names this player enters brackets under. Future imports of these match silently
              instead of queueing for review.
            </span>
          </div>
        )}
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <div className="modal-actions">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        {secondary && (
          <Button type="button" disabled={busy} onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )}
        <Button variant="primary" type="button" disabled={!valid || busy} onClick={submit}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Company dropdown with an inline create. Without it, tagging a player from a
 * company that does not exist yet means abandoning a half-filled form to go to
 * another screen — which is exactly when a player silently gets no company.
 */
function CompanySelect({
  companies,
  value,
  onChange,
}: {
  companies: AdminCompany[];
  value: string;
  onChange: (code: string) => void;
}) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      trpc.admin.upsertCompany.mutate({ code: code.trim(), name: name.trim(), aliases: [] }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });
      onChange(code.trim().toUpperCase());
      setCreating(false);
      setCode('');
      setName('');
    },
  });

  return (
    <div className="company-select">
      <div className="admin-form-row">
        <Select aria-label="Company" value={value} onValueChange={onChange}>
          <SelectItem value="">No company</SelectItem>
          {companies.map((company) => (
            <SelectItem key={company.code} value={company.code}>
              {company.code} — {company.name}
            </SelectItem>
          ))}
        </Select>
        <Button size="small" type="button" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : '+ New company'}
        </Button>
      </div>

      {creating && (
        <div className="admin-form-row company-select-create">
          <Input
            className="company-code-input"
            placeholder="CODE"
            aria-label="Company code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            maxLength={10}
          />
          <Input
            placeholder="Company name"
            aria-label="Company name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            variant="primary"
            size="small"
            type="button"
            disabled={code.trim() === '' || name.trim() === '' || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </div>
      )}
      {create.isError && <p className="error-text">{create.error.message}</p>}
    </div>
  );
}
