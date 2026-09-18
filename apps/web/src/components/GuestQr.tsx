import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

export function GuestQr({ value }: { value: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!canvas.current) return;
    void QRCode.toCanvas(canvas.current, value, { width: 320, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#141411', light: '#ffffff' } }).then(() => {
      // The encoder sets inline dimensions; let each placement size the square QR.
      canvas.current?.style.removeProperty('width');
      canvas.current?.style.removeProperty('height');
    }).catch(() => setError(true));
  }, [value]);
  return error ? <p role="alert">QR unavailable. Use the invitation link.</p> : <canvas ref={canvas} role="img" aria-label="Scan to report a match score" className="guest-qr" />;
}

