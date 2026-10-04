import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { useEffect, useRef, useState } from 'react';
import { bracketBackupSheets, type BracketBackupData } from '../../lib/bracketBackupSheets';
import './BracketBackupSheets.css';

type Sheet = ReturnType<typeof bracketBackupSheets>[number];

export function BracketBackupSheets({
  data,
}: {
  data: BracketBackupData & { plan: BracketBackupData['plan'] & { name: string } };
}) {
  const [preview, setPreview] = useState<{
    sheets: Sheet[];
    eventName: string;
    capturedAt: string;
  } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="bracket-backup-launch">
      <Button
        size="small"
        type="submit"
        ref={trigger}
        onClick={() =>
          setPreview({
            sheets: bracketBackupSheets(data),
            eventName: data.plan.name,
            capturedAt: new Date().toLocaleString(),
          })
        }
      >
        Print bracket backup sheets
      </Button>
      <small>Four TO worksheets, including blank draws before finals are generated.</small>
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
  onClose,
}: {
  sheets: Sheet[];
  eventName: string;
  capturedAt: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(sheets.map((sheet) => sheet.key));
  useEffect(() => {
    document.body.classList.add('printing-bracket-backups');
    return () => document.body.classList.remove('printing-bracket-backups');
  }, []);
  return (
    <Dialog
      title="Print bracket backup sheets"
      className="bracket-backup-dialog"
      print
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="bracket-backup-toolbar">
        <p>
          Snapshot captured at {capturedAt}. Reopen the preview after the draw or results change.
          Before finals are generated, Nemesis sheets show an estimated round structure from the
          current pool sizes. Fill qualifiers and byes by hand if needed.
        </p>
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
        <p>
          Use A4 portrait. Reprint if attendance changes; print extra copies if you need more match
          rows.
        </p>
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
                TO paper backup · Record every played set once. Mark byes and forfeits clearly. When
                service returns, enter and reconcile these results before advancing online.
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
                      <th>Paper score / winner</th>
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
                          {match.recorded && <small>Online: {match.recorded}</small>}____ – ____
                          <br />
                          Winner: ______________
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <footer>
                Captured {capturedAt} · {sheet.title} · Paper backup — reconcile online before
                finalizing.
              </footer>
            </article>
          ))}
      </div>
    </Dialog>
  );
}
