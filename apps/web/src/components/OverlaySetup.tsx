import { useEffect, useRef, useState } from 'react';
import { captureError, LocalCapture } from '../lib/localCapture';

/** Capture stays on this device: no upload, audio request, or automatic permission prompt. */
export function OverlaySetup({ stations, focus, onFocus }: { stations: { id: string; name: string }[]; focus: string; onFocus: (id: string) => void }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('setup') === '1');
  const [showButton, setShowButton] = useState(() => new URLSearchParams(location.search).get('controls') !== '0');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const alive = useRef(true);
  const attempt = useRef(0);
  const [capture] = useState(() => new LocalCapture(setStream));
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; capture.dispose(); };
  }, [capture]);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.target instanceof HTMLElement && event.target.closest('input,select,textarea,button,[contenteditable="true"]')) return;
      if (event.key.toLowerCase() === 's') { setOpen(value => !value); event.preventDefault(); }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) { setError('Device selection needs a supported browser on HTTPS or localhost.'); return; }
    try { const found = await navigator.mediaDevices.enumerateDevices(); if (alive.current) setDevices(found.filter(item => item.kind === 'videoinput')); }
    catch (cause) { if (alive.current) setError(captureError(cause)); }
  };
  const start = async (kind: 'screen' | 'camera') => {
    const version = ++attempt.current;
    setError(''); setPending(true);
    try {
      if (!navigator.mediaDevices || kind === 'screen' && !navigator.mediaDevices.getDisplayMedia || kind === 'camera' && !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open that source. Use a supported desktop browser on HTTPS or localhost, or add this page as an OBS browser source.');
      const started = await capture.start(() => kind === 'screen' ? navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }) : navigator.mediaDevices.getUserMedia({ video: device ? { deviceId: { exact: device } } : true, audio: false }));
      if (alive.current && version === attempt.current && started) { setLabel(kind === 'screen' ? 'Shared window / screen' : 'Camera / capture card'); if (kind === 'camera') void refreshDevices(); }
    } catch (cause) { if (alive.current && version === attempt.current) setError(captureError(cause)); }
    finally { if (alive.current && version === attempt.current) setPending(false); }
  };
  const stop = () => { ++attempt.current; capture.stop(); setPending(false); setLabel(''); };
  const fullscreen = async () => {
    try { if (!document.documentElement.requestFullscreen) throw new Error('Fullscreen is unavailable here. Open this overlay in a desktop browser.'); await document.documentElement.requestFullscreen(); setOpen(false); }
    catch (cause) { setError(captureError(cause)); }
  };
  return <>
    <div className={`event-capture${stream ? ' has-local-video' : ''}`} aria-label={stream ? 'Local game capture video' : 'Transparent game capture area'}>
      {stream && <video ref={video} muted autoPlay playsInline aria-label="Selected local video source" onError={() => { stop(); setError('The selected video could not be displayed. Choose another source.'); }} />}
      <span className="capture-corner capture-corner-tl" /><span className="capture-corner capture-corner-br" />
    </div>
    {showButton && !open && <button className="overlay-setup-toggle" onClick={() => setOpen(true)} title="Display setup (S)">Display setup</button>}
    {open && <section className="overlay-setup" aria-label="Overlay display setup">
      <div className="overlay-setup-heading"><h2>Display setup</h2><button className="btn" onClick={() => setOpen(false)}>Hide controls</button></div>
      <label>Current match station<select value={focus} onChange={event => onFocus(event.target.value)}><option value="">Automatic · Stage first</option>{stations.map(station => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
      <details open><summary>Use with OBS</summary><ol><li>Add this URL as a Browser Source at 1920 × 1080.</li><li>Place the browser source <strong>above</strong> your gameplay video source in OBS.</li><li>Fit your video underneath the transparent centre. Keep its 16:9 shape.</li></ol><p>Set the station above, then copy the updated URL into OBS. Hide these controls before going live.</p></details>
      <details><summary>Show video directly in this browser</summary><p>For a standalone event screen, choose a window or a capture card that appears as a camera. This preview stays on this device and has no audio. Browser and device support varies; OBS handles capture separately.</p>
        <div className="overlay-setup-actions"><button className="btn" disabled={pending} onClick={() => void start('screen')}>Choose window / screen</button><button className="btn" disabled={pending} onClick={() => void refreshDevices()}>Find cameras / capture cards</button></div>
        <label>Video input<select value={device} onChange={event => setDevice(event.target.value)}><option value="">Default camera / capture card</option>{devices.map((item, index) => <option key={item.deviceId || index} value={item.deviceId}>{item.label || `Video input ${index + 1}`}</option>)}</select></label>
        <div className="overlay-setup-actions"><button className="btn" disabled={pending} onClick={() => void start('camera')}>Open selected video input</button><button className="btn" disabled={!stream && !pending} onClick={stop}>{pending ? 'Cancel capture request' : 'Stop and close capture'}</button></div>
        <p role="status">{pending ? 'Choose a source in your browser’s permission prompt…' : stream ? `${label} is showing. Stop capture here or with your browser’s sharing control.` : 'No local capture is running.'}</p>
      </details>
      <div className="overlay-setup-actions"><button className="btn" onClick={() => void fullscreen()}>Fullscreen display</button><button className="btn" onClick={() => { setShowButton(false); setOpen(false); }}>Hide setup button</button></div>
      <p className="overlay-setup-hint">Press S to reopen setup. Add <code>controls=0</code> to the URL to hide its button on load.</p>
      {error && <p role="alert" className="overlay-setup-error">{error}</p>}
    </section>}
  </>;
}
