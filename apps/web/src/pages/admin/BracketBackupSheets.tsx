import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { useEffect, useRef, useState } from 'react';
import { bracketBackupSheets } from '../../lib/bracketBackupSheets';
import type { Overview } from './dispatchTypes';
import './BracketBackupSheets.css';

type Sheet = ReturnType<typeof bracketBackupSheets>[number];

export function BracketBackupSheets({ data }: { data: Overview }) {
  const [preview, setPreview] = useState<{
    sheets: Sheet[];
    eventName: string;
    capturedAt: string;
    resultRevision: number | null;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const resultRevision =
    data.plan.status === 'complete' &&
    'publication' in data &&
    data.publication?.status === 'published'
      ? data.publication.revision
      : null;
  const published = resultRevision !== null;
  const sheets = bracketBackupSheets(data).filter((sheet) => !published || !sheet.blank);
  if (!sheets.length) return null;
  return (
    <div className="bracket-backup-launch">
      <Button
        size="small"
        type="submit"
        ref={trigger}
        onClick={() =>
          setPreview({
            sheets,
            eventName: data.plan.name,
            capturedAt: new Date().toLocaleString(),
            resultRevision,
          })
        }
      >
        {published ? 'Print draw record' : 'Print bracket backup sheets'}
      </Button>
      <small>
        {sheets.length}{' '}
        {published ? (
          sheets.length === 1 ? (
            'bracket record'
          ) : (
            'bracket records'
          )
        ) : (
          <>
            {sheets.length === 1 ? 'TO worksheet' : 'TO worksheets'}
            {sheets.some((sheet) => sheet.blank)
              ? ', including paper templates for draws not generated yet.'
              : ', with the current draw and recorded results.'}
          </>
        )}
      </small>
      {preview && (
        <PrintPreview
          {...preview}
          onClose={() => {
            setPreview(null);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function PrintPreview({
  sheets,
  eventName,
  capturedAt,
  resultRevision,
  onClose,
}: {
  sheets: Sheet[];
  eventName: string;
  capturedAt: string;
  resultRevision: number | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(sheets.map((sheet) => sheet.key));
  const published = resultRevision !== null;
  useEffect(() => {
    document.body.classList.add('printing-bracket-backups');
    return () => document.body.classList.remove('printing-bracket-backups');
  }, []);
  return (
    <Dialog
      title={published ? 'Print draw record' : 'Print bracket backup sheets'}
      className="bracket-backup-dialog"
      print
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="bracket-backup-toolbar">
        {published ? (
          <p>Snapshot captured at {capturedAt}. Reopen the preview after a published correction.</p>
        ) : (
          <p>
            Snapshot captured at {capturedAt}. Reopen the preview after the draw or results change.
            Before finals are generated, Nemesis sheets show an estimated round structure from the
            current pool sizes. Fill qualifiers and byes by hand if needed.
          </p>
        )}
        <fieldset>
          <legend>Brackets to print</legend>
          {sheets.map((sheet) => (
            <label key={sheet.key}>
              <Checkbox
                checked={selected.includes(sheet.key)}
                onCheckedChange={(nextChecked) =>
                  setSelected(
                    nextChecked
                      ? [...selected, sheet.key]
                      : selected.filter((key) => key !== sheet.key),
                  )
                }
              />
              {sheet.title}
            </label>
          ))}
        </fieldset>
        {published ? (
          <p>Use A4 portrait.</p>
        ) : (
          <p>
            Use A4 portrait. Reprint if attendance changes; print extra copies if you need more
            match rows.
          </p>
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={!selected.length}
          onClick={() => window.print()}
        >
          Print selected brackets
        </Button>
        <Button type="submit" onClick={onClose}>
          Close preview
        </Button>
      </div>
      <div className="bracket-backup-pages">
        {sheets
          .filter((sheet) => selected.includes(sheet.key))
          .map((sheet) => (
            <article
              className={`bracket-backup-page${sheet.blank && sheet.matches.length <= 7 ? ' is-short-template' : ''}`}
              key={sheet.key}
            >
              <header>
                <p className="bracket-backup-event">NEMESIS / {eventName}</p>
                <h1>{sheet.title}</h1>
                <p>{sheet.source}</p>
              </header>
              <p className="bracket-backup-instructions">
                {published
                  ? `Published draw record · Result revision ${resultRevision}`
                  : 'TO paper backup · Record every played set once. Mark byes and forfeits clearly. When service returns, enter and reconcile these results before advancing online.'}
              </p>
              {sheet.roster.length > 0 && (
                <section className="bracket-backup-roster">
                  <h2>
                    {sheet.blank
                      ? 'Division roster — mark qualifiers for this bracket'
                      : 'Draw entrants'}
                  </h2>
                  <p>{sheet.roster.join(' · ')}</p>
                </section>
              )}
              {!sheet.blank && !sheet.matches.length ? (
                <p>No entrants in this bracket.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Round / match</th>
                      <th>Player 1</th>
                      <th>Player 2</th>
                      <th>{published ? 'Recorded result / winner' : 'Paper score / winner'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.matches.map((match) => (
                      <tr key={match.key}>
                        <td>
                          {match.round && (
                            <strong>
                              {match.round}
                              <br />
                            </strong>
                          )}
                          {match.label}
                        </td>
                        <td>{match.player1}</td>
                        <td>{match.player2}</td>
                        <td className="bracket-backup-score">
                          {published ? (
                            <>
                              <span>
                                {match.unplayedReset
                                  ? 'Not played'
                                  : match.recorded || 'No result recorded'}
                              </span>
                              {match.winner && <small>Winner: {match.winner}</small>}
                            </>
                          ) : (
                            <>
                              {match.recorded && <small>Online: {match.recorded}</small>}____ – ____
                              <br />
                              Winner: ______________
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <footer>
                Captured {capturedAt} · {sheet.title}
                {!published && ' · Paper backup — reconcile online before finalizing.'}
              </footer>
            </article>
          ))}
      </div>
    </Dialog>
  );
}
