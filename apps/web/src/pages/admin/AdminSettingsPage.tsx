import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { RatingSettings, SettingsData } from '../../lib/apiTypes';

/**
 * Numeric tuning parameters. Non-numeric settings (the league bands) get their own controls below, because a bare number input cannot
 * express them.
 */
const GROUPS: {
  title: string;
  note?: string;
  fields: { key: keyof RatingSettings; label: string; hint?: string }[];
}[] = [
  {
    title: 'Whole-History Rating',
    fields: [
      {
        key: 'whrDriftVariancePerDay',
        label: 'Drift variance / day',
        hint: 'How fast skill is assumed to move. Higher tracks recent form more closely, and widens the band faster during absence.',
      },
      {
        key: 'whrPriorSd',
        label: 'Prior SD',
        hint: 'Natural units. Also anchors the scale across weakly-linked brackets.',
      },
      { key: 'whrRookieDebutPrior', label: 'Rookie debut prior' },
      {
        key: 'whrGamesWeight',
        label: 'Decisive-set weight',
        hint: 'A set counts as 1 + weight × (game margin − 1) results, capped at 2 — so at 0.5 a 3-0 counts as two results and a 3-2 as one. Zero ignores scorelines.',
      },
    ],
  },
  {
    title: 'Activity policy',
    note: 'What missing club nights costs on the board. This is club policy, separate from the WHR fit.',
    fields: [
      {
        key: 'activityGraceEvents',
        label: 'Free missed events',
        hint: 'Missed events before anything is docked. At 1, the every-other-event regular never pays.',
      },
      {
        key: 'activityPenaltyPerEvent',
        label: 'Points per missed event',
        hint: 'Subtracted from the skill estimate for each missed event past the grace window.',
      },
      {
        key: 'activityPenaltyCap',
        label: 'Penalty cap',
        hint: 'Most that can ever be docked. Playing once clears the whole penalty.',
      },
    ],
  },
  {
    title: 'Provisional threshold',
    note: 'Below either figure a player is badged provisional rather than pushed down the board.',
    fields: [
      { key: 'provisionalEventCount', label: 'Events needed' },
      { key: 'provisionalMatchCount', label: 'Sets needed' },
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
  const [bands, setBands] = useState<RatingSettings['leagueBands']>([]);
  const [isolationAnchor, setIsolationAnchor] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastLoaded, setLastLoaded] = useState<SettingsData | null>(null);

  // Seed the form whenever fresh settings arrive (render-time adjustment).
  if (settings.data && settings.data !== lastLoaded) {
    setLastLoaded(settings.data);
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings.data.rating)) {
      if (typeof value === 'number') next[key] = String(value);
    }
    setValues(next);
    setBands(settings.data.rating.leagueBands);
    setIsolationAnchor(settings.data.rating.whrIsolationAnchor);
  }

  const save = useMutation({
    mutationFn: (input: RatingSettings) => trpc.admin.updateSettings.mutate(input),
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
    const parsed: RatingSettings = {
      ...settings.data.rating,
      leagueBands: bands,
      whrIsolationAnchor: isolationAnchor,
    };
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
          <button
            type="button"
            className="btn btn-primary"
            disabled={save.isPending}
            onClick={handleSave}
          >
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </span>
      </div>
      <p className="banner banner-warning">
        Saving changed settings triggers a full recompute of all ratings.
      </p>
      {formError && <p className="error-text">{formError}</p>}
      {save.isError && <p className="error-text">{save.error.message}</p>}
      {save.isSuccess && (
        <p className="banner banner-success">
          Saved (settings v{save.data.version}) — recompute queued.
        </p>
      )}
      {recompute.isError && <p className="error-text">{recompute.error.message}</p>}
      {recompute.isSuccess && <p className="banner banner-success">Recompute finished.</p>}

      <p className="muted">Whole-History Rating (WHR)</p>

      <section className="section">
        <h3>
          Leagues{' '}
          <span className="chip">
            {settings.data.rating.leagueBandsCalibrated ? 'calibrated' : 'not yet calibrated'}
          </span>
        </h3>
        <p className="muted">
          Absolute thresholds on the club rating — the number the board ranks on — so a league label
          means the same thing over time. The first recompute fits these to the club&apos;s
          distribution; after that they only change here. The bottom band is the catch-all.
        </p>
        {bands.map((band, index) => (
          <label key={index} className="settings-field">
            <input
              className="input league-name-input"
              type="text"
              value={band.name}
              onChange={(event) =>
                setBands((prev) =>
                  prev.map((b, i) => (i === index ? { ...b, name: event.target.value } : b)),
                )
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
                    prev.map((b, i) =>
                      i === index ? { ...b, minRating: Number(event.target.value) } : b,
                    ),
                  )
                }
              />
            )}
          </label>
        ))}
      </section>

      <label className="settings-field">
        <span>Anchor isolated rookie ratings</span>
        <input
          type="checkbox"
          checked={isolationAnchor}
          onChange={(event) => setIsolationAnchor(event.target.checked)}
        />
      </label>
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
    </div>
  );
}
