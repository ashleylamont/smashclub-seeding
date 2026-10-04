import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field } from '../components/ui/Field';
import { EmptyState, LoadingState, Notice } from '../components/ui/Feedback';
import { PageHeader } from '../components/ui/PageHeader';
import { Tab, TabList, TabPanel, Tabs } from '../components/ui/Tabs';
import { ScoreFields } from '../components/ScoreFields';
import { InfoTip } from '../components/InfoTip';
import './UiGallery.css';

/** Local examples: this page never submits to the tournament API. */
export function UiGalleryPage() {
  return (
    <div className="ui-gallery">
      <PageHeader
        title="UI guide"
        description="Shared controls, states and event workflows. Examples use local data."
      />
      <Tabs defaultValue="controls">
        <TabList aria-label="Component examples">
          <Tab value="controls">Controls</Tab>
          <Tab value="reporting">Reporting</Tab>
          <Tab value="foundations">Foundations</Tab>
        </TabList>
        <TabPanel value="controls">
          <ControlExamples />
        </TabPanel>
        <TabPanel value="reporting">
          <ReportingExamples />
        </TabPanel>
        <TabPanel value="foundations">
          <Foundations />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function ControlExamples() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Alex');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="ui-gallery-grid">
      <section className="card ui-example">
        <h2>Actions</h2>
        <div className="ui-actions">
          <Button variant="primary" onClick={() => setSaved('Result confirmed.')}>
            Confirm result
          </Button>
          <Button>Cancel</Button>
          <Button variant="danger">Remove access</Button>
          <Button disabled>Event closed</Button>
          <Button pending>Saving…</Button>
        </div>
        <Dialog
          title="Edit player"
          description="Change the name in this local example."
          open={open}
          onOpenChange={setOpen}
          trigger={<Button onClick={() => setSaved('')}>Edit player</Button>}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) {
                setError('Enter a player name.');
                return;
              }
              setError('');
              setSaved(`${name.trim()} saved.`);
              setOpen(false);
            }}
          >
            <Field
              label="Registry name"
              value={name}
              error={error}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="modal-actions">
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" variant="primary">
                Save player
              </Button>
            </div>
          </form>
        </Dialog>
        {saved && <Notice tone="success">{saved}</Notice>}
      </section>
      <section className="card ui-example">
        <h2>Fields</h2>
        <Field label="Player name" placeholder="Search players" hint="Names and public aliases." />
        <Field
          label="TO email"
          defaultValue="alex"
          error="Enter a valid email address."
          type="email"
        />
        <Field label="Station" value="Main stage" disabled readOnly />
        <label className="ui-field">
          Match view
          <select className="select" defaultValue="playing">
            <option value="playing">Playing</option>
            <option value="all">All matches</option>
          </select>
        </label>
      </section>
      <section className="card ui-example">
        <h2>Feedback</h2>
        <LoadingState>Loading matches…</LoadingState>
        <Notice tone="success">Result confirmed.</Notice>
        <Notice tone="warning">Live updates interrupted. Last received scores are shown.</Notice>
        <Notice tone="danger">Could not save. Try again.</Notice>
        <p>
          Ranked rating{' '}
          <InfoTip label="Ranked rating">
            Rating minus the uncertainty allowance. It can differ from a tournament seed.
          </InfoTip>
        </p>
      </section>
      <EmptyState title="No matches in this view" action={<Button>Clear filters</Button>}>
        Choose another view or clear your filters.
      </EmptyState>
    </div>
  );
}

function ReportingExamples() {
  const [score1, setScore1] = useState(0);
  const [score2, setScore2] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div className="ui-gallery-grid">
      <article className="card ui-example">
        <h2>Report a score</h2>
        <p>Upper · Pool A · Round 2</p>
        <form
          className="ui-example"
          onSubmit={(event) => {
            event.preventDefault();
            setConfirmed(true);
          }}
        >
          <ScoreFields
            player1Name="Alex with a long tournament alias"
            player2Name="Jordan"
            score1={score1}
            score2={score2}
            onScore1={(value) => {
              setScore1(value);
              setConfirmed(false);
            }}
            onScore2={(value) => {
              setScore2(value);
              setConfirmed(false);
            }}
          />
          <Button type="submit" variant="primary" disabled={score1 === score2}>
            Confirm result
          </Button>
          <p className="ui-field-hint">A different score goes to TO review.</p>
          {confirmed && (
            <Notice tone="success">
              Result confirmed: {score1}–{score2}.
            </Notice>
          )}
        </form>
      </article>
      <section className="card ui-example">
        <h2>Event workflows</h2>
        <ol>
          <li>Player: open event → choose name → find match → report score.</li>
          <li>Guest: scan event QR → choose name → report score → check confirmation.</li>
          <li>TO: Run matches → choose pairing → finish match or review a report.</li>
          <li>TO: Players → find player → open match or adjust attendance.</li>
          <li>Broadcast: select station → update live score → finish match.</li>
        </ol>
        <p>Player, TO and OBS screens share data and score controls. Each has its own layout.</p>
      </section>
    </div>
  );
}

function Foundations() {
  const colors = [
    ['bg', 'Page'],
    ['surface', 'Control'],
    ['text-h', 'Heading'],
    ['text', 'Body'],
    ['accent', 'Action'],
    ['good', 'Success'],
    ['warn', 'Warning'],
    ['bad', 'Error'],
  ];
  return (
    <div className="ui-gallery-grid">
      <section className="card ui-example">
        <h2>Color</h2>
        <div className="ui-swatches">
          {colors.map(([token, label]) => (
            <div key={token}>
              <span className="ui-swatch" style={{ background: `var(--${token})` }} />
              <strong>{label}</strong>
              <code>--{token}</code>
            </div>
          ))}
        </div>
        <p>
          Change the theme in the navigation to review both palettes. States use words as well as
          color.
        </p>
      </section>
      <section className="card ui-example">
        <h2>Type and spacing</h2>
        <h3>Oswald · headings</h3>
        <p>Body text · 15px / 1.5</p>
        <p className="mono">JetBrains Mono · 2–1 · 1472</p>
        <p>Spacing: 4, 8, 12, 16, 24, 32, 48px (--s1…--s7).</p>
        <p>
          Controls: 36px; small actions: 32px; touch targets: 44px. Square edges and red actions
          retain the current identity.
        </p>
      </section>
      <section className="card ui-example">
        <h2>Copy</h2>
        <p>
          Name the task, state or consequence. Use “Confirm result”, “Awaiting TO approval” and
          “Event closed”.
        </p>
        <p>
          Keep explanations beside the decision or behind contextual help. Avoid slogans and
          repeated branding.
        </p>
        <p>
          Use player aliases, event names and station names in full. Keep forfeit, bye, pending and
          confirmed distinct.
        </p>
      </section>
    </div>
  );
}
