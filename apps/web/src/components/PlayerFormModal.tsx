import { useEffect, useState, type ReactNode } from 'react';
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

  // Escape closes, matching every other dismissable surface in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

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
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(event) => event.stopPropagation()}>
        <h3>{title}</h3>
        {children}

        <div className="form-grid">
          <label className="form-field">
            <span className="form-label">Registry name</span>
            <input
              className="input"
              autoFocus
              value={canonicalName}
              onChange={(event) => setCanonicalName(event.target.value)}
              placeholder="e.g. Ashley Lamont"
            />
            <span className="form-hint">
              The club's own record of who this is. Used for identity matching, not shown publicly when an
              alias is set.
            </span>
          </label>

          <label className="form-field">
            <span className="form-label">Public alias</span>
            <input
              className="input"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={canonicalName.trim() ? defaultPublicAlias(canonicalName) : 'optional username'}
            />
            <span className="form-hint">
              The tag shown on the leaderboard. Leave blank to go by{' '}
              {canonicalName.trim() ? `“${defaultPublicAlias(canonicalName)}”` : 'the shortened registry name'}.
            </span>
          </label>

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
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Remove alias ${alias}`}
                      onClick={() => setAliases(aliases.filter((entry) => entry !== alias))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="admin-form-row">
                <input
                  className="input"
                  placeholder="other spelling…"
                  value={aliasInput}
                  onChange={(event) => setAliasInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addAlias();
                    }
                  }}
                />
                <button type="button" className="btn btn-small" disabled={aliasInput.trim() === ''} onClick={addAlias}>
                  Add
                </button>
              </div>
              <span className="form-hint">
                Other names this player enters brackets under. Future imports of these match silently instead of
                queueing for review.
              </span>
            </div>
          )}
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          {secondary && (
            <button type="button" className="btn" disabled={busy} onClick={secondary.onClick}>
              {secondary.label}
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
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
    mutationFn: () => trpc.admin.upsertCompany.mutate({ code: code.trim(), name: name.trim(), aliases: [] }),
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
        <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">No company</option>
          {companies.map((company) => (
            <option key={company.code} value={company.code}>
              {company.code} — {company.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-small" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : '+ New company'}
        </button>
      </div>

      {creating && (
        <div className="admin-form-row company-select-create">
          <input
            className="input company-code-input"
            placeholder="CODE"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            maxLength={10}
          />
          <input
            className="input"
            placeholder="Company name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={code.trim() === '' || name.trim() === '' || create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </button>
        </div>
      )}
      {create.isError && <p className="error-text">{create.error.message}</p>}
    </div>
  );
}
