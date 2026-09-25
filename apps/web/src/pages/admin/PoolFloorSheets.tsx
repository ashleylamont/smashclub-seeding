import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { poolFloorSheets, type FloorSheetData } from '../../lib/poolFloorSheets';
import './PoolFloorSheets.css';

type Sheet = ReturnType<typeof poolFloorSheets>[number];
export function PoolFloorSheets({ data }: { data: FloorSheetData }) {
  const [preview, setPreview] = useState<{ sheets: Sheet[]; eventName: string; capturedAt: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (data.plan.bracketMode !== 'native' || !data.poolRounds?.length) return null;
  return <div className="floor-sheet-launch"><button className="btn btn-small" ref={trigger} onClick={() => setPreview({ sheets: poolFloorSheets(data, window.location.origin), eventName: data.plan.name, capturedAt: new Date().toLocaleString() })}>Print pool sheets</button><small>Station signs, pairings and paper score backup.</small>{preview && createPortal(<PrintPreview {...preview} onClose={() => { setPreview(null); trigger.current?.focus(); }} />, document.body)}</div>;
}
function PrintPreview({ sheets, eventName, capturedAt, onClose }: { sheets: Sheet[]; eventName: string; capturedAt: string; onClose: () => void }) {
  const [selected, setSelected] = useState(sheets.map(sheet => sheet.key));
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [qrReady, setQrReady] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    document.body.classList.add('printing-pool-sheets');
    return () => document.body.classList.remove('printing-pool-sheets');
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.all(sheets.filter(sheet => sheet.boardUrl).map(async sheet => {
      try { return [sheet.key, await QRCode.toDataURL(sheet.boardUrl!, { width: 300, margin: 4, errorCorrectionLevel: 'M' })] as const; }
      catch { return [sheet.key, ''] as const; }
    })).then(entries => { if (active) { setQrImages(Object.fromEntries(entries)); setQrReady(true); } });
    return () => { active = false; };
  }, [sheets]);
  return <dialog className="floor-sheet-dialog" ref={dialog} aria-label="Print pool sheets" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="floor-sheet-toolbar"><h2>Print pool sheets</h2><p>This preview is frozen at {capturedAt}. Close and reopen it to capture changes.</p><fieldset><legend>Pools to print</legend>{sheets.map(sheet => <label key={sheet.key}><input type="checkbox" checked={selected.includes(sheet.key)} onChange={event => setSelected(event.target.checked ? [...selected, sheet.key] : selected.filter(key => key !== sheet.key))} />{sheet.title}</label>)}</fieldset><p>Use A4 portrait. Turn off browser headers and footers for a clean print.</p><button className="btn btn-primary" disabled={!selected.length || !qrReady} onClick={() => window.print()}>{qrReady ? 'Print selected pools' : 'Preparing QR codes…'}</button><button className="btn" onClick={onClose}>Close preview</button></div>
    <div className="floor-sheet-pages">{sheets.filter(sheet => selected.includes(sheet.key)).map(sheet => <article className="floor-sheet-page" key={sheet.key}>
      <header><p className="floor-sheet-event">NEMESIS / {eventName}</p><h1>{sheet.title}</h1><p className="floor-sheet-stations">{sheet.stations.length ? sheet.stations.join(' + ') : 'Stations not assigned — ask a TO'}</p><strong>{sheet.status}</strong></header>
      <section className="floor-sheet-directions"><div><h2>Find your next match</h2><p>{sheet.instructions}</p><p>Pairings below are a reference, not start times or fixed station assignments. Check the live board for the current queue; it can change.</p><p>Paper scores are a backup. Have them entered online once only; ask a TO to correct a recorded result.</p></div><aside>{sheet.boardUrl ? <>{qrImages[sheet.key] ? <img src={qrImages[sheet.key]} width="120" height="120" alt={`QR code for ${sheet.title} live board`} /> : qrReady ? <span>QR unavailable — use the link below.</span> : <span>Preparing QR…</span>}<strong>Live pool board</strong><a href={sheet.boardUrl}>{sheet.boardUrl}</a><small>This link does not grant score reporting access. Guests need the event’s current reporting QR.</small></> : <p>Live board is not published. Ask a TO for the current queue.</p>}</aside></section>
      <section className="floor-sheet-roster"><h2>Players</h2><p>{sheet.roster.map(player => `${player.name}${player.withdrawn ? ' (withdrawn)' : ''}`).join(' · ')}</p></section>
      <table><thead><tr><th>Round / match</th><th>Player 1</th><th>Player 2</th><th>Score / status</th></tr></thead><tbody>{sheet.rounds.flatMap(round => [
        ...round.matches.map((match, index) => <tr key={match.id}><td>{index === 0 && <strong>Round {round.round}</strong>}<small>{match.label}</small></td><td>{match.player1}</td><td>{match.player2}</td><td className="floor-sheet-score">{match.result}</td></tr>),
        ...(round.resting.length ? [<tr key={`rest-${round.round}`} className="floor-sheet-rest"><td colSpan={4}>Round {round.round} rest: {round.resting.join(', ')}</td></tr>] : []),
      ])}</tbody></table>
      <footer>Snapshot captured {capturedAt} · {sheet.title} · This sheet does not update. Scan the live board for changes.</footer>
    </article>)}</div>
  </dialog>;
}
