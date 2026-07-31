import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { AdminCompany } from '../../lib/apiTypes';

/**
 * Company taxonomy management.
 *
 * The taxonomy drives identity matching — a bracket entry tagged "[Woolies]"
 * only resolves to Woolworths because an alias says so — so this screen exists
 * to make that mapping visible and editable. Previously the mutations existed
 * but nothing called them: companies could only be changed by editing the
 * engine's default table and re-importing.
 */

export function AdminCompaniesPage() {
  const queryClient = useQueryClient();
  const companies = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: () => trpc.admin.companies.query(),
  });

  const [editing, setEditing] = useState<AdminCompany | null>(null);
  const [creating, setCreating] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'players'] });
  };

  return (
    <div className="section">
      <div className="page-header">
        <h2>Companies</h2>
        <button type="button" className="btn btn-small btn-primary" onClick={() => setCreating(true)}>
          New company
        </button>
      </div>

      <p className="muted">
        Codes tag players on the leaderboard. Aliases are the other spellings that appear in bracket entries —
        every alias listed here is matched automatically on import, so adding one is usually cheaper than
        resolving the same name in the review queue every event.
      </p>

      {companies.isPending && <p className="loading-text">Loading companies…</p>}
      {companies.isError && <p className="error-text">{companies.error.message}</p>}

      {companies.data && (
        <div className="table-scroll" style={{ marginTop: 'var(--s4)' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Aliases</th>
                <th className="num">Players</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {companies.data.map((company) => (
                <CompanyRow
                  key={company.id}
                  company={company}
                  onEdit={() => setEditing(company)}
                  onChanged={invalidate}
                />
              ))}
              {companies.data.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No companies yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <CompanyFormModal
          company={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={invalidate}
        />
      )}
    </div>
  );
}

function CompanyRow({
  company,
  onEdit,
  onChanged,
}: {
  company: AdminCompany;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const removeAlias = useMutation({
    mutationFn: (alias: string) => trpc.admin.removeCompanyAlias.mutate({ companyId: company.id, alias }),
    onSuccess: onChanged,
  });

  const remove = useMutation({
    mutationFn: () => trpc.admin.deleteCompany.mutate({ companyId: company.id }),
    onSuccess: () => {
      setConfirmingDelete(false);
      onChanged();
    },
  });

  const error = removeAlias.error ?? remove.error;

  return (
    <tr>
      <td className="mono">{company.code}</td>
      <td>{company.name}</td>
      <td>
        <span className="alias-chips">
          {company.aliases.length === 0 && <span className="muted">—</span>}
          {company.aliases.map((alias) => (
            <span key={alias} className="chip">
              {alias}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove alias ${alias}`}
                disabled={removeAlias.isPending}
                onClick={() => removeAlias.mutate(alias)}
              >
                ×
              </button>
            </span>
          ))}
        </span>
        {error && <div className="error-text">{error.message}</div>}
      </td>
      <td className="num">{company.playerCount}</td>
      <td>
        <span className="row-actions">
          <button type="button" className="btn btn-small" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="btn btn-small btn-danger" onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
        </span>

        {confirmingDelete && (
          <div className="modal-overlay" onClick={() => setConfirmingDelete(false)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h3>Delete {company.code}?</h3>
              <p>
                {company.playerCount === 0
                  ? 'No players are tagged with this company.'
                  : `${company.playerCount} player${company.playerCount === 1 ? '' : 's'} tagged with this company will
                     become untagged.`}{' '}
                Its {company.aliases.length} alias{company.aliases.length === 1 ? '' : 'es'} will also be removed, so
                bracket entries carrying this tag will go to the review queue instead of matching automatically.
                Ratings and match history are unaffected.
              </p>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete company'}
                </button>
              </div>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

function CompanyFormModal({
  company,
  onClose,
  onSaved,
}: {
  company: AdminCompany | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(company?.code ?? '');
  const [name, setName] = useState(company?.name ?? '');
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = useMutation({
    mutationFn: () =>
      trpc.admin.upsertCompany.mutate({
        ...(company ? { id: company.id } : {}),
        code: code.trim(),
        name: name.trim(),
        // Existing aliases are removed from the row, not re-sent here, so this
        // list only ever adds.
        aliases: aliasInput.trim() === '' ? aliases : [...aliases, aliasInput.trim()],
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const addAlias = () => {
    const value = aliasInput.trim();
    if (value === '' || aliases.includes(value)) return;
    setAliases([...aliases, value]);
    setAliasInput('');
  };

  const valid = code.trim() !== '' && name.trim() !== '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h3>{company ? `Edit ${company.code}` : 'New company'}</h3>

        <div className="form-grid">
          <label className="form-field">
            <span className="form-label">Code</span>
            <input
              className="input company-code-input"
              autoFocus
              maxLength={10}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ATL"
            />
            <span className="form-hint">Short tag shown on the leaderboard.</span>
          </label>

          <label className="form-field">
            <span className="form-label">Name</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Atlassian"
            />
          </label>

          <div className="form-field">
            <span className="form-label">{company ? 'Add aliases' : 'Aliases'}</span>
            <div className="alias-editor">
              {aliases.map((alias) => (
                <span key={alias} className="chip">
                  {alias}
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`Remove ${alias}`}
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
                placeholder="e.g. Atlas"
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
              Spellings that appear in bracket entries. Matching ignores case.
              {company && ' Existing aliases are removed from the table row.'}
            </span>
          </div>
        </div>

        {save.isError && <p className="error-text">{save.error.message}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : company ? 'Save changes' : 'Create company'}
          </button>
        </div>
      </div>
    </div>
  );
}
