import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { GlickoSettings, SettingsData } from '../../lib/apiTypes';
import { ModelComparison } from './ModelComparison';

/**
 * Numeric tuning parameters. Non-numeric settings (the active model, the league
 * bands) get their own controls below, because a bare number input cannot
 * express them.
 */
const GROUPS: Array<{
  title: string;
  note?: string;
  fields: Array<{ key: keyof GlickoSettings; label: string; hint?: string }>;
}> = [
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
    title: 'Whole-History Rating',
    note: 'Used when WHR is the active model.',
    fields: [
      {
        key: 'whrDriftVariancePerDay',
        label: 'Drift variance / day',
        hint: 'How fast skill is assumed to move. Higher tracks recent form more closely.',
      },
      {
        key: 'whrPriorSd',
        label: 'Prior SD',
        hint: 'Natural units. Also anchors the scale across weakly-linked brackets.',
      },
    ],
  },
  {
    title: 'Match weights',
    note: 'Glicko-2 only.',
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
    note: 'Glicko-2 only — WHR handles thin cross-bracket linkage with wider uncertainty instead.',
    fields: [
      { key: 'rookieBracketBaseScale', label: 'Base scale' },
      { key: 'rookiePartialPenaltyThreshold', label: 'Partial penalty threshold' },
      { key: 'rookieFullPenaltyThreshold', label: 'Full penalty threshold' },
      { key: 'rookieOverPenaltyThreshold', label: 'Over-penalty threshold' },
    ],
  },
  {
    title: 'Inactivity decay',
    note: 'Glicko-2 only.',
    fields: [
      { key: 'missedTournamentRdScale', label: 'RD per missed tournament' },
      { key: 'missedTournamentEscalation', label: 'Escalation per miss' },
    ],
  },
  {
    title: 'Sample confidence',
    note: 'Glicko-2 only.',
    fields: [
      { key: 'confidenceTournamentWeight', label: 'Tournament weight' },
      { key: 'confidenceOpponentWeight', label: 'Opponent weight' },
      { key: 'confidenceMatchWeight', label: 'Match weight' },
      { key: 'confidenceFloor', label: 'Confidence floor' },
      { key: 'anchorFloor', label: 'Anchor floor' },
    ],
  },
];

const MODEL_LABELS: Record<GlickoSettings['activeModel'], string> = {
  glicko2: 'Glicko-2 (per-tournament periods)',
  whr: 'Whole-History Rating',
};

export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => trpc.admin.settings.query(),
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [model, setModel] = useState<GlickoSettings['activeModel']>('glicko2');
  const [bands, setBands] = useState<GlickoSettings['leagueBands']>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<SettingsData | null>(null);

  // Seed the form whenever fresh settings arrive (render-time adjustment).
  if (settings.data && settings.data !== lastLoaded) {
    setLastLoaded(settings.data);
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings.data.glicko)) {
      if (typeof value === 'number') next[key] = String(value);
    }
    setValues(next);
    setModel(settings.data.glicko.activeModel);
    setBands(settings.data.glicko.leagueBands);
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

    /**
     * Start from the settings as loaded and override only what the form edits.
     * Building the payload from the form's own field list would drop every
     * setting it has no input for — including the calibrated league bands, which
     * would silently revert to the arbitrary shipped defaults on any save.
     */
    const parsed: GlickoSettings = { ...settings.data.glicko, activeModel: model, leagueBands: bands };
    for (const group of GROUPS) {
      for (const field of group.fields) {
        const raw = values[field.key];
        const num = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
        if (Number.isNaN(num)) {
          setFormError(`"${field.label}" must be a number.`);
          return;
        }
        (parsed as unknown as Record<string, number>)[field.key] = num;
      }
    }
    save.mutate(parsed);
  };

  if (settings.isPending) return <p className="loading-text">Loading settings…</p>;
  if (settings.isError) return <p className="error-text">{settings.error.message}</p>;

  const modelChanged = model !== settings.data.glicko.activeModel;

  return (
    <div className="settings-page">
      <div className="page-header">
        <h2>
          Rating settings <span className="chip">v{settings.data.version}</span>
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

      <section className="section">
        <h3>Active model</h3>
        <label className="settings-field">
          <span>
            Authoritative ratings
            <span className="muted settings-hint">
              Both models are fitted from the same history. This chooses which one the public site publishes.
            </span>
          </span>
          <select
            className="select"
            value={model}
            onChange={(event) => setModel(event.target.value as GlickoSettings['activeModel'])}
          >
            {Object.entries(MODEL_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {modelChanged && (
          <p className="banner banner-warning">
            Switching the model changes every member&apos;s published number. Compare the two below before saving.
          </p>
        )}
      </section>

      <section className="section">
        <h3>
          Leagues{' '}
          <span className="chip">{settings.data.glicko.leagueBandsCalibrated ? 'calibrated' : 'not yet calibrated'}</span>
        </h3>
        <p className="muted">
          Absolute thresholds on the skill rating, so a league label means the same thing over time. The first
          recompute fits these to the club&apos;s distribution; after that they only change here. The bottom band is
          the catch-all.
        </p>
        {bands.map((band, index) => (
          <label key={index} className="settings-field">
            <input
              className="input league-name-input"
              type="text"
              value={band.name}
              onChange={(event) =>
                setBands((prev) => prev.map((b, i) => (i === index ? { ...b, name: event.target.value } : b)))
              }
            />
            {index === bands.length - 1 ? (
              <span className="muted">everyone else</span>
            ) : (
              <input
                className="input"
                type="number"
                step="1"
                value={band.minRating}
                onChange={(event) =>
                  setBands((prev) =>
                    prev.map((b, i) => (i === index ? { ...b, minRating: Number(event.target.value) } : b)),
                  )
                }
              />
            )}
          </label>
        ))}
      </section>

      <div className="settings-groups">
        {GROUPS.map((group) => (
          <div key={group.title} className="settings-group">
            <h3>{group.title}</h3>
            {group.note && <p className="muted settings-hint">{group.note}</p>}
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

      <ModelComparison activeModel={settings.data.glicko.activeModel} />
    </div>
  );
}
