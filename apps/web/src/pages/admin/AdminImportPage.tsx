import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { RegistryEntryPlan, RegistryImportPlan } from '../../lib/apiTypes';

/**
 * players.yaml import, as a wizard: paste or upload, look at exactly what it
 * would do, then apply. The preview is a server-side diff rather than a
 * client-side guess, and applying re-parses the same document server-side —
 * so the two can never disagree, and re-importing an unchanged file is a
 * genuine no-op instead of a pile of writes.
 */

type Step = 'input' | 'preview' | 'done';

const ACTION_LABEL: Record<RegistryEntryPlan['action'], string> = {
  create: 'create',
  update: 'update',
  unchanged: 'unchanged',
};

export function AdminImportPage() {
  const queryClient = useQueryClient();
  const [yaml, setYaml] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [showUnchanged, setShowUnchanged] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const preview = useMutation({
    mutationFn: (document: string) => trpc.admin.previewRegistryImport.mutate({ yaml: document }),
    onSuccess: () => setStep('preview'),
  });

  const apply = useMutation({
    mutationFn: (document: string) => trpc.admin.applyRegistryImport.mutate({ yaml: document }),
    onSuccess: () => {
      setStep('done');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'players'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'reviewQueue'] });
      void queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
    },
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setYaml(text);
    setStep('input');
    apply.reset();
    preview.mutate(text);
  };

  const restart = () => {
    setStep('input');
    preview.reset();
    apply.reset();
  };

  const plan = preview.data ?? null;
  const blocked = (plan?.issues.length ?? 0) > 0;
  /** Nothing to write: a re-import of an unchanged file, which is the norm. */
  const noop = plan !== null && plan.counts.create + plan.counts.update === 0;

  return (
    <div className="section">
      <div className="page-header">
        <h2>Import players.yaml</h2>
        <span className="muted">registry → players, aliases, characters</span>
      </div>

      <p className="muted import-intro">
        The same file the CLI importer takes. Players are keyed on their registry <code>id</code>, so re-importing
        updates rather than duplicating. <code>numeric_id</code> is ignored (nothing reads it) and{' '}
        <code>past_companies</code> only widens which company tags a player's names resolve under — neither is stored
        as a column.
      </p>

      <div className="import-input">
        <textarea
          className="textarea import-textarea"
          placeholder={'players:\n  - id: alex-h\n    canonical_name: Alex Hogue\n    company: Atlassian\n    aliases: [Alex H, Alex]\n    main_character: Ness'}
          value={yaml}
          spellCheck={false}
          onChange={(event) => {
            setYaml(event.target.value);
            if (step !== 'input') restart();
          }}
        />
        <div className="import-actions">
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={yaml.trim() === '' || preview.isPending}
            onClick={() => preview.mutate(yaml)}
          >
            {preview.isPending ? 'Reading…' : 'Preview'}
          </button>
          <button type="button" className="btn btn-small" onClick={() => fileInput.current?.click()}>
            Upload file…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,.txt,text/yaml"
            className="visually-hidden"
            onChange={(event) => {
              void onFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          {yaml !== '' && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setYaml('');
                restart();
              }}
            >
              Clear
            </button>
          )}
          {preview.isError && <span className="error-text">{preview.error.message}</span>}
        </div>
      </div>

      {step === 'done' && apply.data && (
        <div className="banner banner-success">
          Imported: {apply.data.created} created, {apply.data.updated} updated, {apply.data.unchanged} unchanged.
          {apply.data.companiesCreated > 0 && ` ${apply.data.companiesCreated} new compan${apply.data.companiesCreated === 1 ? 'y' : 'ies'}.`}
          {` ${apply.data.aliasesAdded} aliases and ${apply.data.charactersAdded} characters added.`}
          {apply.data.candidates.changed > 0 &&
            ` ${apply.data.candidates.changed} review item${apply.data.candidates.changed === 1 ? '' : 's'} picked up new candidates.`}
        </div>
      )}

      {plan && step !== 'done' && (
        <PlanView
          plan={plan}
          showUnchanged={showUnchanged}
          onToggleUnchanged={() => setShowUnchanged((value) => !value)}
        />
      )}

      {plan && step === 'preview' && (
        <div className="import-actions import-apply">
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={blocked || noop || apply.isPending}
            onClick={() => apply.mutate(yaml)}
            title={blocked ? 'Fix the errors above first' : undefined}
          >
            {apply.isPending
              ? 'Applying…'
              : `Apply ${plan.counts.create + plan.counts.update} change${plan.counts.create + plan.counts.update === 1 ? '' : 's'}`}
          </button>
          {blocked && <span className="muted">Nothing is applied while the file has errors.</span>}
          {noop && !blocked && (
            <span className="muted">Everything in this file is already in the registry.</span>
          )}
          {apply.isError && <span className="error-text">{apply.error.message}</span>}
        </div>
      )}
    </div>
  );
}

function PlanView({
  plan,
  showUnchanged,
  onToggleUnchanged,
}: {
  plan: RegistryImportPlan;
  showUnchanged: boolean;
  onToggleUnchanged: () => void;
}) {
  const visible = showUnchanged ? plan.entries : plan.entries.filter((entry) => entry.action !== 'unchanged');

  return (
    <div className="import-plan">
      {plan.issues.length > 0 && (
        <div className="banner banner-danger">
          <strong>
            {plan.issues.length} problem{plan.issues.length === 1 ? '' : 's'} — fix these and preview again:
          </strong>
          <ul className="import-issues">
            {plan.issues.map((issue, index) => (
              <li key={`${issue.id ?? issue.index}-${index}`}>
                <code>{issue.id ?? `entry #${issue.index + 1}`}</code> {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="import-summary">
        <span className="chip">{plan.counts.create} create</span>
        <span className="chip">{plan.counts.update} update</span>
        <span className="chip">{plan.counts.unchanged} unchanged</span>
        <span className="chip">+{plan.counts.aliases} aliases</span>
        <span className="chip">+{plan.counts.characters} characters</span>
        {plan.counts.companies > 0 && <span className="chip chip-warning">+{plan.counts.companies} companies</span>}
      </div>

      {plan.companiesToCreate.length > 0 && (
        <div className="banner banner-warning">
          New companies will be created: {plan.companiesToCreate.map((company) => `${company.name} (${company.code})`).join(', ')}.
          Rename or re-code them on the Companies tab afterwards if the generated code is wrong.
        </div>
      )}

      {plan.entries.length > 0 && (
        <>
          <label className="checkbox-label">
            <input type="checkbox" checked={showUnchanged} onChange={onToggleUnchanged} />
            Show unchanged ({plan.counts.unchanged})
          </label>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Registry id</th>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Aliases added</th>
                  <th>Characters</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <PlanRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One row per spelling rather than per row-to-be-written. Each alias is stored
 * once per company scope it should resolve under — company, past employers,
 * company-less — which is three rows for a typical player and a wall of
 * near-identical chips if listed flat. The scopes live in the tooltip and the
 * summary's alias count still reflects the real number of writes.
 */
function groupAliases(aliases: RegistryEntryPlan['aliasesToAdd']): Array<[string, string[]]> {
  const byAlias = new Map<string, string[]>();
  for (const entry of aliases) {
    const scopes = byAlias.get(entry.alias) ?? [];
    scopes.push(entry.companyCode ?? 'no company');
    byAlias.set(entry.alias, scopes);
  }
  return [...byAlias];
}

function PlanRow({ entry }: { entry: RegistryEntryPlan }) {
  return (
    <tr className={entry.action === 'unchanged' ? 'import-row-unchanged' : undefined}>
      <td>
        <code>{entry.id}</code>
      </td>
      <td>
        {entry.canonicalName}
        {entry.nameChange && <div className="muted">was “{entry.nameChange.from}”</div>}
        {entry.warnings.map((warning) => (
          <div key={warning} className="import-warning">
            {warning}
          </div>
        ))}
      </td>
      <td>
        {entry.companyCode ?? <span className="muted">—</span>}
        {entry.companyChange && <div className="muted">was {entry.companyChange.from ?? '—'}</div>}
      </td>
      <td>
        <span className="alias-chips">
          {entry.aliasesToAdd.length === 0 && <span className="muted">—</span>}
          {groupAliases(entry.aliasesToAdd).map(([alias, scopes]) => (
            <span key={alias} className="chip" title={`resolves under: ${scopes.join(', ')}`}>
              {alias}
              {scopes.length > 1 && <span className="muted"> ×{scopes.length}</span>}
            </span>
          ))}
        </span>
      </td>
      <td>
        {entry.charactersToAdd.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          entry.charactersToAdd.join(', ')
        )}
      </td>
      <td>
        <span className={`chip import-action-${entry.action}`}>{ACTION_LABEL[entry.action]}</span>
      </td>
    </tr>
  );
}
