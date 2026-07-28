import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { GlickoSettings, SettingsData } from '../../lib/apiTypes';

const GROUPS: Array<{ title: string; fields: Array<{ key: keyof GlickoSettings; label: string; hint?: string }> }> = [
  {
    title: 'Core Glicko-2',
    fields: [
      { key: 'initialRating', label: 'Initial rating' },
      { key: 'initialRd', label: 'Initial RD' },
      { key: 'initialVol', label: 'Initial volatility' },
      { key: 'tau', label: 'Tau (τ)' },
      { key: 'rdCap', label: 'RD cap' },
    ],
  },
  {
    title: 'Match weights',
    fields: [
      {
        key: 'inverseDiminishingExponent',
        label: 'Inverse-diminishing exponent',
        hint: 'w = (matchNum / totalInTournament) ^ exponent',
      },
    ],
  },
  {
    title: 'Rookie brackets',
    fields: [
      { key: 'rookieBracketBaseScale', label: 'Base scale' },
      { key: 'rookiePartialPenaltyThreshold', label: 'Partial penalty threshold' },
      { key: 'rookieFullPenaltyThreshold', label: 'Full penalty threshold' },
      { key: 'rookieOverPenaltyThreshold', label: 'Over-penalty threshold' },
    ],
  },
  {
    title: 'Inactivity decay',
    fields: [
      { key: 'missedTournamentRdScale', label: 'RD per missed tournament' },
      { key: 'missedTournamentEscalation', label: 'Escalation per miss' },
    ],
  },
  {
    title: 'Sample confidence',
    fields: [
      { key: 'confidenceTournamentWeight', label: 'Tournament weight' },
      { key: 'confidenceOpponentWeight', label: 'Opponent weight' },
      { key: 'confidenceMatchWeight', label: 'Match weight' },
      { key: 'confidenceFloor', label: 'Confidence floor' },
      { key: 'anchorFloor', label: 'Anchor floor' },
    ],
  },
];

export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => trpc.admin.settings.query(),
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<SettingsData | null>(null);

  // Seed the form whenever fresh settings arrive (render-time adjustment).
  if (settings.data && settings.data !== lastLoaded) {
    setLastLoaded(settings.data);
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings.data.glicko)) {
      next[key] = String(value);
    }
    setValues(next);
  }

  const save = useMutation({
    mutationFn: (input: GlickoSettings) => trpc.admin.updateSettings.mutate(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
  });

  const recompute = useMutation({
    mutationFn: () => trpc.admin.recomputeNow.mutate(),
  });

  const handleSave = () => {
    setFormError(null);
    if (!settings.data) return;
    const parsed = {} as Record<string, number>;
    for (const group of GROUPS) {
      for (const field of group.fields) {
        const raw = values[field.key];
        const num = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
        if (Number.isNaN(num)) {
          setFormError(`"${field.label}" must be a number.`);
          return;
        }
        parsed[field.key] = num;
      }
    }
    save.mutate(parsed as unknown as GlickoSettings);
  };

  if (settings.isPending) return <p className="loading-text">Loading settings…</p>;
  if (settings.isError) return <p className="error-text">{settings.error.message}</p>;

  return (
    <div className="settings-page">
      <div className="page-header">
        <h2>
          Glicko settings <span className="chip">v{settings.data.version}</span>
        </h2>
        <span className="row-actions">
          <button
            type="button"
            className="btn"
            disabled={recompute.isPending}
            onClick={() => recompute.mutate()}
            title="Re-run the full rating recompute with current settings"
          >
            {recompute.isPending ? 'Recomputing…' : 'Recompute now'}
          </button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={handleSave}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </span>
      </div>
      <p className="banner banner-warning">Saving changed settings triggers a full recompute of all ratings.</p>
      {formError && <p className="error-text">{formError}</p>}
      {save.isError && <p className="error-text">{save.error.message}</p>}
      {save.isSuccess && <p className="banner banner-success">Saved (settings v{save.data.version}) — recompute queued.</p>}
      {recompute.isError && <p className="error-text">{recompute.error.message}</p>}
      {recompute.isSuccess && <p className="banner banner-success">Recompute finished.</p>}

      <div className="settings-groups">
        {GROUPS.map((group) => (
          <div key={group.title} className="card settings-group">
            <h3>{group.title}</h3>
            {group.fields.map((field) => (
              <label key={field.key} className="settings-field">
                <span>
                  {field.label}
                  {field.hint && <span className="muted settings-hint">{field.hint}</span>}
                </span>
                <input
                  className="input"
                  type="number"
                  step="any"
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
